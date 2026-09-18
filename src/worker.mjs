import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "./config.mjs";
import { buildTrainingCommand } from "./project.mjs";
import { loadExperiment, saveStatus } from "./run-store.mjs";

const runId = process.argv[2];
if (!runId) throw new Error("worker 缺少 experiment_id");
const config = loadConfig();
const experiment = loadExperiment(config, runId);
const logPath = join(experiment.runDirectory, "training.log");
const logFd = openSync(logPath, "a");
const command = buildTrainingCommand(experiment);
const startedAt = new Date().toISOString();

const child = spawn(command.command, command.args, {
  cwd: command.cwd,
  env: { ...process.env, PYTHONUNBUFFERED: "1" },
  stdio: ["ignore", logFd, logFd],
  windowsHide: true,
  shell: false,
});

saveStatus(config, runId, {
  state: "running",
  workerPid: process.pid,
  trainingPid: child.pid,
  startedAt,
  logPath,
});
closeSync(logFd);

child.once("error", (error) => {
  saveStatus(config, runId, {
    state: "failed",
    workerPid: process.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    error: error.message,
    logPath,
  });
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  saveStatus(config, runId, {
    state: code === 0 ? "completed" : "failed",
    workerPid: process.pid,
    trainingPid: child.pid,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: code,
    signal,
    logPath,
  });
  process.exitCode = code || 0;
});
