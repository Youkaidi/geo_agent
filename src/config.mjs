import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";
import { semanticCacheDefaults } from "./semantic-cache.mjs";

export const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let networkConfigured = false;

function readLocalConfig() {
  const path = join(workspaceRoot, ".geo-agent.local.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function numberSetting(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

export function loadConfig() {
  const local = readLocalConfig();
  const localSandbox = local.sandbox || {};
  const localSemanticCache = local.semanticCache || {};
  const cacheDefaults = semanticCacheDefaults(workspaceRoot);
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
    sandbox: {
      mode: process.env.GEO_SANDBOX_MODE || localSandbox.mode || "process",
      dockerCommand: process.env.GEO_SANDBOX_DOCKER || localSandbox.dockerCommand || "docker",
      image: process.env.GEO_SANDBOX_IMAGE || localSandbox.image || "geo-agent-training:local",
      pythonCommand: process.env.GEO_SANDBOX_PYTHON || localSandbox.pythonCommand || "python",
      network: process.env.GEO_SANDBOX_NETWORK || localSandbox.network || "none",
      timeoutSeconds: numberSetting(process.env.GEO_SANDBOX_TIMEOUT_SECONDS || localSandbox.timeoutSeconds, 3600),
      cpus: numberSetting(process.env.GEO_SANDBOX_CPUS || localSandbox.cpus, 4),
      memory: process.env.GEO_SANDBOX_MEMORY || localSandbox.memory || "12g",
      pidsLimit: numberSetting(process.env.GEO_SANDBOX_PIDS || localSandbox.pidsLimit, 256),
      gpu: String(process.env.GEO_SANDBOX_GPU ?? localSandbox.gpu ?? "0"),
      user: process.env.GEO_SANDBOX_USER || localSandbox.user || "10001:10001",
    },
    semanticCache: {
      ...cacheDefaults,
      mode: ["off", "shadow", "active"].includes(process.env.GEO_CACHE_MODE || localSemanticCache.mode)
        ? (process.env.GEO_CACHE_MODE || localSemanticCache.mode)
        : cacheDefaults.mode,
      redisUrl: process.env.GEO_CACHE_REDIS_URL || localSemanticCache.redisUrl || cacheDefaults.redisUrl,
      connectTimeoutMs: numberSetting(process.env.GEO_CACHE_CONNECT_TIMEOUT_MS || localSemanticCache.connectTimeoutMs, cacheDefaults.connectTimeoutMs),
      operationTimeoutMs: numberSetting(process.env.GEO_CACHE_OPERATION_TIMEOUT_MS || localSemanticCache.operationTimeoutMs, cacheDefaults.operationTimeoutMs),
      ttlSeconds: numberSetting(process.env.GEO_CACHE_TTL_SECONDS || localSemanticCache.ttlSeconds, cacheDefaults.ttlSeconds),
      distanceThreshold: numberSetting(process.env.GEO_CACHE_DISTANCE_THRESHOLD || localSemanticCache.distanceThreshold, cacheDefaults.distanceThreshold, 0.0001),
      embeddingModel: process.env.GEO_CACHE_EMBEDDING_MODEL || localSemanticCache.embeddingModel || cacheDefaults.embeddingModel,
      dimension: numberSetting(process.env.GEO_CACHE_DIMENSION || localSemanticCache.dimension, cacheDefaults.dimension),
      tenantId: process.env.GEO_CACHE_TENANT_ID || localSemanticCache.tenantId || cacheDefaults.tenantId,
      projectId: process.env.GEO_CACHE_PROJECT_ID || localSemanticCache.projectId || cacheDefaults.projectId,
      locale: process.env.GEO_CACHE_LOCALE || localSemanticCache.locale || cacheDefaults.locale,
      knowledgeVersion: process.env.GEO_CACHE_KNOWLEDGE_VERSION || localSemanticCache.knowledgeVersion || cacheDefaults.knowledgeVersion,
      agentVersion: process.env.GEO_CACHE_AGENT_VERSION || localSemanticCache.agentVersion || cacheDefaults.agentVersion,
    },
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
