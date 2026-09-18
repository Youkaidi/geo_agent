import { closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "./config.mjs";
import { buildTrainingCommand, preflight, readExperimentSummary } from "./project.mjs";
import { loadExperiment, saveStatus } from "./run-store.mjs";
import {
  acquireWorkerLease,
  addCheckpoint,
  claimNextTask,
  completeTask,
  failTask,
  heartbeatTask,
  recoverExpiredTasks,
  releaseWorkerLease,
  renewWorkerLease,
} from "./task-queue.mjs";

const config = loadConfig();
const owner = `${hostname()}:${process.pid}`;
let stopping = false;

function logTail(path, lines = 40) {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

function retryableFailure(message) {
  const permanent = /out of memory|ModuleNotFoundError|FileNotFoundError|ValueError|shape mismatch|Output size is too small|预检失败/i;
  if (permanent.test(message)) return false;
  return /timeout|timed out|connection|temporar|busy|reset|unavailable|worker|exit code/i.test(message);
}

function runChild(command, logPath, task, heartbeat, shouldResume) {
  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, "a");
    writeSync(logFd, `\n=== task ${task.taskId} attempt ${task.attempts}/${task.maxAttempts} ${new Date().toISOString()} ===\n`);
    const args = [...command.args];
    if (shouldResume && !args.includes("--resume")) args.push("--resume");
    const child = spawn(command.command, args, {
      cwd: command.cwd,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      shell: false,
    });
    closeSync(logFd);
    heartbeat(child.pid);
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve({ code, signal, pid: child.pid });
      else reject(new Error(`training exited with code ${code}${signal ? ` signal ${signal}` : ""}`));
    });
  });
}

async function executeTask(task) {
  const experiment = loadExperiment(config, task.experimentId);
  const logPath = join(experiment.runDirectory, "training.log");
  const heartbeat = (trainingPid) => {
    heartbeatTask(config, task.taskId, owner);
    renewWorkerLease(config, owner);
    saveStatus(config, experiment.id, {
      state: "running",
      taskId: task.taskId,
      attempt: task.attempts,
      maxAttempts: task.maxAttempts,
      workerPid: process.pid,
      trainingPid,
      heartbeatAt: new Date().toISOString(),
      logPath,
    });
  };
  const timer = setInterval(() => heartbeat(undefined), 10_000);
  timer.unref();

  try {
    addCheckpoint(config, task.taskId, "preflight", "started", task.attempts);
    const check = preflight(config, experiment.dataRoot);
    if (!check.ready) throw new Error(`预检失败：${check.reasons.join("；")}`);
    addCheckpoint(config, task.taskId, "preflight", "completed", task.attempts, {
      device: check.python.cuda_available ? "cuda:0" : null,
      gpu: check.gpu.gpus?.[0]?.name,
    });

    const command = buildTrainingCommand(experiment);
    const shouldResume =
      task.attempts > 1 &&
      existsSync(join(experiment.outputDirectory, experiment.variant, "last.pt"));
    addCheckpoint(config, task.taskId, "training", "started", task.attempts, {
      epochs: experiment.epochs,
      variant: experiment.variant,
      resume: shouldResume,
    });
    const outcome = await runChild(command, logPath, task, heartbeat, shouldResume);
    addCheckpoint(config, task.taskId, "training", "completed", task.attempts, outcome);

    addCheckpoint(config, task.taskId, "summary", "started", task.attempts);
    const summary = readExperimentSummary(experiment);
    if (!summary) throw new Error("训练进程成功退出，但 summary.json 缺失或无法解析");
    addCheckpoint(config, task.taskId, "summary", "completed", task.attempts, {
      bestValidationMiou: summary.bestValidationMiou,
      overallMiou: summary.overall?.mean_iou,
      summaryPath: summary.summaryPath,
    });

    const completed = completeTask(config, task.taskId, owner);
    addCheckpoint(config, task.taskId, "task", "succeeded", task.attempts);
    saveStatus(config, experiment.id, {
      state: "completed",
      taskId: task.taskId,
      attempts: completed.attempts,
      finishedAt: completed.finishedAt,
      logPath,
    });
  } catch (error) {
    const tail = logTail(logPath);
    const message = `${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ""}`;
    const retryable = retryableFailure(message);
    const failed = failTask(config, task.taskId, owner, message, retryable);
    addCheckpoint(config, task.taskId, "task", failed.state, task.attempts, {
      retryable,
      error: error instanceof Error ? error.message : String(error),
      nextAttemptAt: failed.availableAt,
    });
    saveStatus(config, experiment.id, {
      state: failed.state,
      taskId: task.taskId,
      attempts: failed.attempts,
      maxAttempts: failed.maxAttempts,
      error: failed.lastError,
      nextAttemptAt: failed.state === "retrying" ? failed.availableAt : null,
      finishedAt: failed.finishedAt,
      logPath,
    });
  } finally {
    clearInterval(timer);
  }
}

async function main() {
  if (!acquireWorkerLease(config, owner)) return;
  recoverExpiredTasks(config);
  const leaseTimer = setInterval(() => renewWorkerLease(config, owner), 10_000);
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!stopping) {
      const task = claimNextTask(config, owner);
      if (!task) {
        await delay(1_000);
        continue;
      }
      await executeTask(task);
    }
  } finally {
    clearInterval(leaseTimer);
    releaseWorkerLease(config, owner);
  }
}

await main();
