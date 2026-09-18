import assert from "node:assert/strict";
import { join } from "node:path";
import { createGeoAgent } from "./agent.mjs";
import { loadConfig } from "./config.mjs";
import { inspectTrainingProject, prepareExperiment } from "./orchestrator.mjs";
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
  console.log("PASS: orchestration, SQLite queue/retry/dead-letter/recovery, CLI task notifications, proxy config, and Pi tool allowlist");
}
