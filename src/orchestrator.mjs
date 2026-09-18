import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { createSyntheticF3Dataset } from "./npy.mjs";
import { buildTrainingCommand, inspectProject, preflight, readExperimentSummary, readProgress } from "./project.mjs";
import { createRunId, ensureRuntime, loadExperiment, loadStatus, runDirectory, saveExperiment, saveStatus } from "./run-store.mjs";
import {
  enqueueExperimentTask,
  getTask,
  getTaskByExperiment,
  listCheckpoints,
  queueOverview,
  workerLeaseActive,
} from "./task-queue.mjs";

function integer(value, fallback, min, max) {
  const parsed = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function ensureQueueWorker(config) {
  if (workerLeaseActive(config)) return { started: false };
  const workerPath = fileURLToPath(new URL("./queue-worker.mjs", import.meta.url));
  const child = spawn(process.execPath, [workerPath], {
    cwd: config.workspaceRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    shell: false,
  });
  child.unref();
  return { started: true, workerPid: child.pid };
}

function statusArtifacts(experiment) {
  return {
    experimentCard: join(experiment.runDirectory, "experiment.json"),
    status: join(experiment.runDirectory, "status.json"),
    log: join(experiment.runDirectory, "training.log"),
    outputs: experiment.outputDirectory,
  };
}

function taskStateForLegacy(state) {
  if (state === "succeeded") return "completed";
  if (state === "dead_letter") return "failed";
  return state;
}

export function inspectTrainingProject() {
  const config = loadConfig();
  ensureRuntime(config);
  return { ...inspectProject(config), configuredDataRoot: config.dataRoot, pythonCommand: config.pythonCommand };
}

export function prepareExperiment(options = {}) {
  const config = loadConfig();
  ensureRuntime(config);
  const mode = options.dataMode === "real" ? "real" : "synthetic";
  const id = createRunId();
  const directory = runDirectory(config, id);
  const dataRoot = mode === "synthetic"
    ? createSyntheticF3Dataset(join(config.runtimeRoot, "fixtures", "f3_smoke"))
    : config.dataRoot;
  const epochs = integer(options.epochs, 2, 1, 5);
  const experiment = {
    id,
    name: options.name || `MC-Net baseline ${mode} smoke`,
    objective: options.objective || "验证地震相分割训练链路能够在单张 GPU 上完成并产出可追踪指标",
    hypothesis: options.hypothesis || "baseline 在两轮训练后能够生成合法 checkpoint、history 和测试指标",
    successCriteria: ["进程退出码为 0", "完成全部 epoch", "生成 summary.json 与 metrics.csv", "PyTorch 使用 cuda:0"],
    dataMode: mode,
    projectPath: config.trainingProject,
    pythonCommand: config.pythonCommand,
    dataRoot,
    runDirectory: directory,
    outputDirectory: join(directory, "outputs"),
    variant: ["baseline", "ell", "vtpm", "full"].includes(options.variant) ? options.variant : "baseline",
    epochs,
    batchSize: integer(options.batchSize, 1, 1, 8),
    numWorkers: integer(options.numWorkers, 0, 0, 8),
    baseChannels: integer(options.baseChannels, mode === "synthetic" ? 8 : 32, 4, 64),
    trainHeight: integer(options.trainHeight, mode === "synthetic" ? 32 : 256, 32, 512),
    trainWidth: integer(options.trainWidth, mode === "synthetic" ? 32 : 192, 32, 512),
    maxTrainSections: integer(options.maxTrainSections, mode === "synthetic" ? 4 : 32, 1, 512),
    maxValidationSections: integer(options.maxValidationSections, mode === "synthetic" ? 1 : 8, 1, 128),
    maxTestSections: integer(options.maxTestSections, mode === "synthetic" ? 2 : 16, 1, 256),
    device: "cuda:0",
    createdAt: new Date().toISOString(),
  };
  experiment.preflight = preflight(config, dataRoot);
  const command = buildTrainingCommand(experiment);
  experiment.commandPreview = [command.command, ...command.args].map((part) => /\s/.test(part) ? `"${part}"` : part).join(" ");
  saveExperiment(config, experiment);
  saveStatus(config, id, { state: "drafted", createdAt: experiment.createdAt });
  return {
    experimentId: id,
    ready: experiment.preflight.ready,
    blockers: experiment.preflight.reasons,
    experimentCard: experiment,
    confirmation: experiment.preflight.ready
      ? `实验已就绪。请明确确认后调用 submit_experiment，experiment_id=${id}`
      : "实验尚未就绪，请先解决 blockers；不会启动训练。",
  };
}

export function submitExperiment(runId, confirmed) {
  if (confirmed !== true) throw new Error("提交训练需要 confirmed=true；请先向用户展示实验卡并获得明确确认");
  const config = loadConfig();
  const experiment = loadExperiment(config, runId);
  const current = loadStatus(config, runId);
  if (current.state !== "drafted") throw new Error(`实验当前状态为 ${current.state}，不能重复提交`);
  const latestPreflight = preflight(config, experiment.dataRoot);
  if (!latestPreflight.ready) throw new Error(`预检失败：${latestPreflight.reasons.join("；")}`);
  const task = enqueueExperimentTask(config, runId, { maxAttempts: 3 });
  saveStatus(config, runId, { state: "queued", taskId: task.taskId, queuedAt: task.createdAt });
  const worker = ensureQueueWorker(config);
  return {
    taskId: task.taskId,
    experimentId: runId,
    state: task.state,
    maxAttempts: task.maxAttempts,
    worker,
    pollingHint: `使用 get_task_status 查询 task_id=${task.taskId}`,
  };
}

export function getTaskStatus(taskId) {
  const config = loadConfig();
  const task = getTask(config, taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (["queued", "retrying", "running"].includes(task.state)) ensureQueueWorker(config);
  const experiment = loadExperiment(config, task.experimentId);
  const logPath = join(experiment.runDirectory, "training.log");
  const progress = readProgress(logPath, experiment.epochs);
  const logTail = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-12).join("\n")
    : "";
  return {
    ...task,
    progress,
    checkpoints: listCheckpoints(config, taskId),
    logTail,
    artifacts: statusArtifacts(experiment),
  };
}

export function getExperimentStatus(runId) {
  const config = loadConfig();
  const task = getTaskByExperiment(config, runId);
  if (!task) {
    const experiment = loadExperiment(config, runId);
    const status = loadStatus(config, runId);
    return {
      experimentId: runId,
      ...status,
      progress: readProgress(join(experiment.runDirectory, "training.log"), experiment.epochs),
    };
  }
  const result = getTaskStatus(task.taskId);
  return { ...result, state: taskStateForLegacy(result.state) };
}

export function getQueueStatus() {
  const config = loadConfig();
  return { counts: queueOverview(config), workerActive: workerLeaseActive(config) };
}

export function summarizeExperiment(runId) {
  const config = loadConfig();
  const experiment = loadExperiment(config, runId);
  const task = getTaskByExperiment(config, runId);
  const metrics = readExperimentSummary(experiment);
  const state = task?.state || loadStatus(config, runId).state;
  return {
    experimentId: runId,
    taskId: task?.taskId,
    name: experiment.name,
    state,
    objective: experiment.objective,
    hypothesis: experiment.hypothesis,
    successCriteria: experiment.successCriteria,
    passed: ["succeeded", "completed"].includes(state) && Boolean(metrics) && metrics.device?.startsWith("cuda"),
    metrics,
    checkpoints: task ? listCheckpoints(config, task.taskId) : [],
    artifacts: statusArtifacts(experiment),
  };
}
