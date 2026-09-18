import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let networkConfigured = false;

function readLocalConfig() {
  const path = join(workspaceRoot, ".geo-agent.local.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

export function loadConfig() {
  const local = readLocalConfig();
  const trainingProject = resolve(
    process.env.GEO_TRAINING_PROJECT || local.trainingProject || workspaceRoot,
  );
  return {
    workspaceRoot,
    trainingProject,
    pythonCommand: process.env.GEO_PYTHON || local.pythonCommand || "python",
    dataRoot: resolve(
      process.env.GEO_DATA_ROOT || local.dataRoot || join(trainingProject, "data", "f3_model"),
    ),
    proxyUrl: process.env.GEO_PROXY || local.proxyUrl || "",
    runtimeRoot: join(workspaceRoot, ".geo-agent"),
  };
}

export function applyNetworkConfig(config) {
  if (networkConfigured) return;
  if (config.proxyUrl) {
    process.env.HTTP_PROXY = config.proxyUrl;
    process.env.HTTPS_PROXY = config.proxyUrl;
    process.env.ALL_PROXY = config.proxyUrl;
  }
  setGlobalDispatcher(new EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: 300_000,
    headersTimeout: 300_000,
  }));
  install?.();
  networkConfigured = true;
}
