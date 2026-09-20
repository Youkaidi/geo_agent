import assert from "node:assert/strict";
import { join } from "node:path";
import { createGeoAgent } from "./agent.mjs";
import { loadConfig } from "./config.mjs";
import { inspectTrainingProject, prepareExperiment } from "./orchestrator.mjs";
import { buildTrainingCommand } from "./project.mjs";
import { createSandboxExecution, restrictedEnvironment } from "./sandbox.mjs";
import { createSemanticCache, evaluateCachePolicy } from "./semantic-cache.mjs";
import { createTaskNotifier, taskIdFromToolEvent } from "./task-notifier.mjs";
import {
  addCheckpoint,
  claimNextTask,
  enqueueExperimentTask,
  failTask,
  getTask,
  listCheckpoints,
  recoverExpiredTasks,
} from "./task-queue.mjs";

export async function runTests() {
  const project = inspectTrainingProject();
  assert.equal(project.valid, true, "目标训练项目结构应完整");

  const prepared = prepareExperiment({ dataMode: "synthetic", epochs: 2 });
  assert.equal(prepared.experimentCard.epochs, 2);
  assert.equal(prepared.experimentCard.device, "cuda:0");
  assert.equal(prepared.experimentCard.preflight.data.ok, true, "合成 NPY 数据应可被 NumPy 读取");
  assert.match(prepared.experimentCard.commandPreview, /ablation\.run_ablation/);

  const baseConfig = loadConfig();
  const command = buildTrainingCommand(prepared.experimentCard);
  const processExecution = createSandboxExecution(baseConfig, prepared.experimentCard, command, "task-test-process");
  assert.equal(processExecution.description.isolation, "restricted-process");
  assert.equal(processExecution.command, baseConfig.pythonCommand);
  assert.equal(restrictedEnvironment({ PATH: "safe", OPENAI_API_KEY: "secret" }).OPENAI_API_KEY, undefined);

  const dockerConfig = { ...baseConfig, sandbox: { ...baseConfig.sandbox, mode: "docker" } };
  const dockerExecution = createSandboxExecution(dockerConfig, prepared.experimentCard, command, "task-test-docker");
  assert.equal(dockerExecution.command, "docker");
  assert.ok(dockerExecution.args.includes("--read-only"));
  assert.ok(dockerExecution.args.includes("no-new-privileges:true"));
  assert.ok(dockerExecution.args.includes("/workspace/data"));
  assert.ok(dockerExecution.args.some((arg) => arg.includes("target=/workspace/project,readonly")));
  assert.throws(
    () => createSandboxExecution(baseConfig, { ...prepared.experimentCard, outputDirectory: "D:\\outside" }, command, "task-test-boundary"),
    /输出目录越界/,
  );

  class MemorySemanticStore {
    constructor() { this.entries = []; }
    async incrementMetric() {}
    async lookupExact(scope, promptHash) {
      const entry = this.entries.find((item) => item.scope === scope && item.promptHash === promptHash);
      return entry ? { ...entry, match: "exact", distance: 0 } : null;
    }
    async lookupSemantic(scope, vector) {
      const entry = this.entries.find((item) => item.scope === scope && item.vector.every((value, index) => value === vector[index]));
      return entry ? { ...entry, match: "semantic", distance: 0.01 } : null;
    }
    async store(entry) { this.entries = [...this.entries.filter((item) => !(item.scope === entry.scope && item.promptHash === entry.promptHash)), entry]; return "memory-entry"; }
    async metrics() { return {}; }
    async close() {}
  }
  const memoryStore = new MemorySemanticStore();
  const fakeEmbedder = { embed: async (text) => /语义缓存|Redis/i.test(text) ? [1, 0] : [0, 1] };
  const activeCacheConfig = {
    ...baseConfig,
    semanticCache: { ...baseConfig.semanticCache, mode: "active", dimension: 2, distanceThreshold: 0.08 },
  };
  const semanticCache = createSemanticCache(activeCacheConfig, { store: memoryStore, embedder: fakeEmbedder });
  const firstLookup = await semanticCache.lookup("为什么语义缓存适合使用Redis", { modelVersion: "test-model" });
  assert.equal(firstLookup.kind, "miss");
  assert.equal((await semanticCache.store("为什么语义缓存适合使用Redis", "因为它支持TTL和向量检索。", { modelVersion: "test-model" }, firstLookup)).stored, true);
  assert.equal((await semanticCache.lookup("为什么Redis适合作为语义缓存", { modelVersion: "test-model" })).kind, "hit");
  assert.equal((await semanticCache.lookup("为什么Redis适合作为语义缓存", { modelVersion: "another-model" })).kind, "miss", "模型版本必须隔离缓存");
  assert.equal((await semanticCache.lookup("请查询我的实验任务状态", { modelVersion: "test-model" })).kind, "bypass");
  assert.equal(evaluateCachePolicy("为什么PyTorch 2.4和2.5有区别").semanticEligible, false, "含硬参数的问题只能精确命中");
  await semanticCache.close();

  const shadowCache = createSemanticCache({
    ...activeCacheConfig,
    semanticCache: { ...activeCacheConfig.semanticCache, mode: "shadow" },
  }, { store: memoryStore, embedder: fakeEmbedder });
  assert.equal((await shadowCache.lookup("为什么Redis适合作为语义缓存", { modelVersion: "test-model" })).kind, "shadow_hit");
  await shadowCache.close();

  const queueConfig = { ...baseConfig, runtimeRoot: join(baseConfig.runtimeRoot, "test-queues", `${process.pid}-${Date.now()}`) };
  const retryTask = enqueueExperimentTask(queueConfig, "exp-test-retry", { maxAttempts: 3 });
  const claimedRetry = claimNextTask(queueConfig, "test-worker");
  assert.equal(claimedRetry.taskId, retryTask.taskId);
  addCheckpoint(queueConfig, retryTask.taskId, "training", "started", 1, { epoch: 0 });
  const retrying = failTask(queueConfig, retryTask.taskId, "test-worker", "temporary timeout", true);
  assert.equal(retrying.state, "retrying");
  assert.equal(listCheckpoints(queueConfig, retryTask.taskId).length, 2);

  const deadTask = enqueueExperimentTask(queueConfig, "exp-test-dead", { maxAttempts: 1 });
  claimNextTask(queueConfig, "test-worker");
  const dead = failTask(queueConfig, deadTask.taskId, "test-worker", "permanent configuration error", false);
  assert.equal(dead.state, "dead_letter");

  const recoverTask = enqueueExperimentTask(queueConfig, "exp-test-recover", { maxAttempts: 3 });
  claimNextTask(queueConfig, "crashed-worker", -1);
  const recovered = recoverExpiredTasks(queueConfig);
  assert.equal(recovered.retried, 1);
  assert.equal(getTask(queueConfig, recoverTask.taskId).state, "retrying");

  const notifications = [];
  let notificationPoll = 0;
  const notifier = createTaskNotifier({
    intervalMs: 60_000,
    emit: (message) => notifications.push(message),
    getStatus: async (taskId) => {
      notificationPoll += 1;
      return notificationPoll === 1
        ? { taskId, experimentId: "exp-notify", state: "running", attempts: 1, maxAttempts: 3, progress: { currentEpoch: 1, totalEpochs: 2 }, artifacts: {} }
        : { taskId, experimentId: "exp-notify", state: "succeeded", attempts: 1, maxAttempts: 3, progress: { currentEpoch: 2, totalEpochs: 2 }, artifacts: { outputs: "outputs" } };
    },
    summarize: async () => ({ metrics: { bestValidationMiou: 0.25, overall: { mean_iou: 0.2 } } }),
  });
  assert.equal(taskIdFromToolEvent({ type: "tool_execution_end", toolName: "submit_experiment", isError: false, result: { details: { taskId: "task-20260918010101-abcdef" } } }), "task-20260918010101-abcdef");
  notifier.watch("task-20260918010101-abcdef");
  await notifier.pollNow();
  await notifier.pollNow();
  assert.match(notifications[0], /Epoch 1\/2/);
  assert.match(notifications[1], /任务完成/);
  assert.match(notifications[1], /0\.2500/);
  assert.deepEqual(notifier.watchedTaskIds(), []);
  notifier.stop();

  const { session, config } = await createGeoAgent();
  assert.equal(config.proxyUrl, "http://127.0.0.1:7897");
  assert.deepEqual(session.getActiveToolNames().sort(), [
    "get_experiment_status",
    "get_queue_status",
    "get_task_status",
    "inspect_training_project",
    "prepare_experiment",
    "submit_experiment",
    "summarize_experiment",
  ]);
  session.dispose();
  console.log("PASS: orchestration, semantic cache policy/scope/shadow mode, sandbox policy/Docker plan, SQLite queue/retry/dead-letter/recovery, CLI task notifications, proxy config, and Pi tool allowlist");
}
