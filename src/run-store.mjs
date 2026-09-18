import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export function ensureRuntime(config) {
  mkdirSync(join(config.runtimeRoot, "runs"), { recursive: true });
  mkdirSync(join(config.runtimeRoot, "fixtures"), { recursive: true });
}

export function createRunId() {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `exp-${timestamp}-${randomBytes(3).toString("hex")}`;
}

export function runDirectory(config, runId) {
  if (!/^exp-[0-9]{14}-[a-f0-9]{6}$/.test(runId)) throw new Error("非法 experiment_id");
  return join(config.runtimeRoot, "runs", runId);
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

export function saveExperiment(config, experiment) {
  const directory = runDirectory(config, experiment.id);
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "experiment.json"), experiment);
  return directory;
}

export function loadExperiment(config, runId) {
  const path = join(runDirectory(config, runId), "experiment.json");
  if (!existsSync(path)) throw new Error(`实验不存在：${runId}`);
  return readJson(path);
}

export function saveStatus(config, runId, status) {
  writeJson(join(runDirectory(config, runId), "status.json"), status);
}

export function loadStatus(config, runId) {
  const path = join(runDirectory(config, runId), "status.json");
  return existsSync(path) ? readJson(path) : { state: "drafted" };
}
