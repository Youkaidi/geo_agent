import { createHash } from "node:crypto";
import { join } from "node:path";

const CACHEABLE_PATTERNS = [
  /什么是|是什么|为什么|解释(?:一下)?|区别|原理|如何理解|如何处理|怎么理解|作用|优缺点/i,
  /\b(?:what is|why|explain|difference|how does|how to understand)\b/i,
];
const DYNAMIC_PATTERNS = [
  /(?:查询|查看|显示).{0,8}(?:任务|实验|队列|状态|进度|日志|指标|GPU)/i,
  /(?:任务|实验|队列|训练).{0,8}(?:状态|进度|完成|失败|运行中|跑完)/i,
  /(?:提交|运行|启动|停止|取消|重试|创建|准备|修改|改为|删除|继续).{0,12}(?:任务|实验|训练|配置|epoch|轮)/i,
  /(?:当前|现在|刚才|上面|下面|这个|那个|它|我的|该任务|该实验)/i,
  /\b(?:status|progress|submit|start|stop|cancel|retry|current|latest|my task|this experiment)\b/i,
  /(?:exp|task)-[0-9]{8,}/i,
];
const HARD_PARAMETER_PATTERN = /\d|epoch|batch(?:[ -]?size)?|cuda:\d|实验\s*ID|任务\s*ID/i;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${milliseconds}ms）`)), milliseconds);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function normalizeCachePrompt(input) {
  return String(input).normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function evaluateCachePolicy(input) {
  const prompt = normalizeCachePrompt(input);
  if (prompt.length < 8) return { cacheable: false, reason: "问题过短，可能依赖上下文" };
  if (prompt.length > 1000) return { cacheable: false, reason: "问题过长，不适合回答缓存" };
  if (prompt.startsWith("/")) return { cacheable: false, reason: "命令不缓存" };
  if (DYNAMIC_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return { cacheable: false, reason: "动态状态或有副作用的请求不缓存" };
  }
  if (!CACHEABLE_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return { cacheable: false, reason: "第一版只缓存独立的知识问答" };
  }
  return {
    cacheable: true,
    semanticEligible: !HARD_PARAMETER_PATTERN.test(prompt),
    intent: "knowledge_qa",
    prompt,
  };
}

function scopeHash(scope) {
  const stable = [
    scope.tenantId,
    scope.projectId,
    scope.intent,
    scope.locale,
    scope.knowledgeVersion,
    scope.agentVersion,
    scope.modelVersion,
    scope.permissionScope,
  ].map((value) => String(value || "default")).join("\u001f");
  return sha256(stable).slice(0, 32);
}

function vectorBuffer(vector) {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function vectorFromBase64(value) {
  const buffer = Buffer.from(value, "base64");
  return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT));
}

function cosineDistance(left, right) {
  if (left.length !== right.length || left.length === 0) return Number.POSITIVE_INFINITY;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  if (!leftNorm || !rightNorm) return Number.POSITIVE_INFINITY;
  return 1 - dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function fieldsFromReply(reply) {
  if (!reply) return {};
  if (reply instanceof Map) return Object.fromEntries(reply);
  if (!Array.isArray(reply)) return typeof reply === "object" ? reply : {};
  const result = {};
  for (let index = 0; index + 1 < reply.length; index += 2) {
    result[String(reply[index])] = reply[index + 1];
  }
  return result;
}

function firstSearchDocument(reply) {
  if (!reply) return null;
  if (reply instanceof Map) {
    const results = reply.get("results") || reply.get(Buffer.from("results"));
    if (!Array.isArray(results) || results.length === 0) return null;
    const row = results[0] instanceof Map ? Object.fromEntries(results[0]) : results[0];
    return { key: row.id || row.key, fields: fieldsFromReply(row.extra_attributes || row.fields) };
  }
  if (!Array.isArray(reply) || Number(reply[0]) < 1) return null;
  return { key: String(reply[1]), fields: fieldsFromReply(reply[2]) };
}

export class RedisSemanticCacheStore {
  constructor(config) {
    this.config = config;
    this.client = null;
    this.readyPromise = null;
    this.vectorBackend = "uninitialized";
  }

  async ready() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#connect();
    return this.readyPromise;
  }

  async #connect() {
    const { createClient } = await import("redis");
    const client = createClient({
      url: this.config.redisUrl,
      RESP: 2,
      socket: {
        connectTimeout: this.config.connectTimeoutMs,
        reconnectStrategy: false,
      },
    });
    client.on("error", () => {});
    await client.connect();
    this.client = client;
    try {
      await client.sendCommand([
        "FT.CREATE", this.config.indexName,
        "ON", "HASH", "PREFIX", "1", this.config.entryPrefix,
        "SCHEMA",
        "scope", "TAG",
        "promptHash", "TAG",
        "embedding", "VECTOR", "FLAT", "6",
        "TYPE", "FLOAT32", "DIM", String(this.config.dimension), "DISTANCE_METRIC", "COSINE",
      ]);
      this.vectorBackend = "redis-query-engine-flat";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Index already exists/i.test(message)) this.vectorBackend = "redis-query-engine-flat";
      else if (/unknown command|not found|module/i.test(message)) this.vectorBackend = "application-flat";
      else throw error;
    }
    return true;
  }

  async incrementMetric(name, amount = 1) {
    await this.ready();
    await this.client.hIncrBy(this.config.metricsKey, name, amount);
  }

  async lookupExact(scope, promptHash) {
    await this.ready();
    const exactKey = `${this.config.exactPrefix}${scope}:${promptHash}`;
    const entryKey = await this.client.get(exactKey);
    if (!entryKey) return null;
    const fields = await this.client.hGetAll(entryKey);
    if (!fields.response) return null;
    await Promise.all([
      this.client.hIncrBy(entryKey, "hitCount", 1),
      this.client.expire(entryKey, this.config.ttlSeconds),
      this.client.expire(exactKey, this.config.ttlSeconds),
    ]);
    return { entryKey, response: fields.response, prompt: fields.prompt, distance: 0, match: "exact" };
  }

  async lookupSemantic(scope, vector) {
    await this.ready();
    if (this.vectorBackend === "application-flat") {
      const scopeKey = `${this.config.scopeSetPrefix}${scope}`;
      const keys = (await this.client.sMembers(scopeKey)).slice(0, this.config.maxFallbackCandidates);
      let best = null;
      const stale = [];
      for (const key of keys) {
        const fields = await this.client.hGetAll(key);
        if (!fields.response || !fields.embeddingBase64) {
          stale.push(key);
          continue;
        }
        const distance = cosineDistance(vector, vectorFromBase64(fields.embeddingBase64));
        if (!best || distance < best.distance) {
          best = { entryKey: key, response: fields.response, prompt: fields.prompt || "", distance, match: "semantic" };
        }
      }
      if (stale.length) await this.client.sRem(scopeKey, stale);
      if (best) {
        await Promise.all([
          this.client.hIncrBy(best.entryKey, "hitCount", 1),
          this.client.expire(best.entryKey, this.config.ttlSeconds),
          this.client.expire(scopeKey, this.config.ttlSeconds),
        ]);
      }
      return best;
    }
    const reply = await this.client.sendCommand([
      "FT.SEARCH", this.config.indexName,
      `(@scope:{${scope}})=>[KNN 1 @embedding $queryVector AS distance]`,
      "PARAMS", "2", "queryVector", vectorBuffer(vector),
      "SORTBY", "distance",
      "RETURN", "4", "prompt", "response", "distance", "createdAt",
      "LIMIT", "0", "1",
      "DIALECT", "2",
    ]);
    const document = firstSearchDocument(reply);
    if (!document?.fields?.response) return null;
    const distance = Number(document.fields.distance);
    if (!Number.isFinite(distance)) return null;
    await Promise.all([
      this.client.hIncrBy(document.key, "hitCount", 1),
      this.client.expire(document.key, this.config.ttlSeconds),
    ]);
    return {
      entryKey: document.key,
      response: String(document.fields.response),
      prompt: String(document.fields.prompt || ""),
      distance,
      match: "semantic",
    };
  }

  async store({ scope, promptHash, prompt, response, vector, metadata }) {
    await this.ready();
    const entryKey = `${this.config.entryPrefix}${scope}:${promptHash}`;
    const exactKey = `${this.config.exactPrefix}${scope}:${promptHash}`;
    await this.client.hSet(entryKey, {
      scope,
      promptHash,
      prompt,
      response,
      embedding: vectorBuffer(vector),
      embeddingBase64: vectorBuffer(vector).toString("base64"),
      createdAt: new Date().toISOString(),
      hitCount: "0",
      metadata: JSON.stringify(metadata),
    });
    await Promise.all([
      this.client.expire(entryKey, this.config.ttlSeconds),
      this.client.set(exactKey, entryKey, { EX: this.config.ttlSeconds }),
      this.client.sAdd(`${this.config.scopeSetPrefix}${scope}`, entryKey),
      this.client.expire(`${this.config.scopeSetPrefix}${scope}`, this.config.ttlSeconds),
    ]);
    return entryKey;
  }

  async metrics() {
    await this.ready();
    const raw = await this.client.hGetAll(this.config.metricsKey);
    return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Number(value)]));
  }

  backend() {
    return this.vectorBackend;
  }

  async close() {
    if (this.client?.isOpen) await this.client.close();
  }
}

export class LocalMultilingualEmbedder {
  constructor(config) {
    this.config = config;
    this.pipelinePromise = null;
  }

  async #pipeline() {
    if (!this.pipelinePromise) {
      this.pipelinePromise = (async () => {
        const transformers = await import("@huggingface/transformers");
        transformers.env.cacheDir = this.config.modelCacheDirectory;
        return transformers.pipeline("feature-extraction", this.config.embeddingModel, {
          device: "cpu",
          dtype: "q8",
        });
      })();
    }
    return this.pipelinePromise;
  }

  async embed(text) {
    const extractor = await this.#pipeline();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    const vector = Array.from(output.data, Number);
    if (vector.length !== this.config.dimension) {
      throw new Error(`Embedding维度不匹配：期望${this.config.dimension}，实际${vector.length}`);
    }
    return vector;
  }
}

export function createSemanticCache(config, options = {}) {
  const cacheConfig = config.semanticCache;
  const store = options.store || new RedisSemanticCacheStore(cacheConfig);
  const embedder = options.embedder || new LocalMultilingualEmbedder(cacheConfig);
  const onWarning = options.onWarning || (() => {});
  let disabledReason = null;
  let warningSent = false;
  const localMetrics = { queries: 0, exactHits: 0, semanticHits: 0, misses: 0, stores: 0, bypassed: 0, errors: 0, shadowHits: 0 };

  function warnOnce(error) {
    disabledReason = error instanceof Error ? error.message : String(error);
    localMetrics.errors += 1;
    if (!warningSent) {
      warningSent = true;
      onWarning(disabledReason);
    }
  }

  async function metric(name) {
    localMetrics[name] = (localMetrics[name] || 0) + 1;
    try { await store.incrementMetric(name); } catch (error) { warnOnce(error); }
  }

  function buildScope(policy, context) {
    const scope = {
      tenantId: context.tenantId || cacheConfig.tenantId,
      projectId: context.projectId || cacheConfig.projectId,
      intent: policy.intent,
      locale: context.locale || cacheConfig.locale,
      knowledgeVersion: context.knowledgeVersion || cacheConfig.knowledgeVersion,
      agentVersion: context.agentVersion || cacheConfig.agentVersion,
      modelVersion: context.modelVersion || "unknown-model",
      permissionScope: context.permissionScope || "local-user",
    };
    return { scope, hash: scopeHash(scope) };
  }

  return {
    async lookup(input, context = {}) {
      const policy = evaluateCachePolicy(input);
      if (cacheConfig.mode === "off") return { kind: "off", policy };
      if (!policy.cacheable) {
        localMetrics.bypassed += 1;
        return { kind: "bypass", policy };
      }
      if (disabledReason) return { kind: "unavailable", policy, error: disabledReason };
      await metric("queries");
      const promptHash = sha256(policy.prompt);
      const scoped = buildScope(policy, context);
      try {
        const exact = await withTimeout(store.lookupExact(scoped.hash, promptHash), cacheConfig.operationTimeoutMs, "缓存精确查询");
        if (exact) {
          await metric("exactHits");
          if (cacheConfig.mode === "shadow") {
            await metric("shadowHits");
            return { kind: "shadow_hit", policy, candidate: exact, promptHash, ...scoped };
          }
          return { kind: "hit", policy, candidate: exact, promptHash, ...scoped };
        }
        const vector = await withTimeout(embedder.embed(policy.prompt), cacheConfig.operationTimeoutMs, "Embedding生成");
        if (policy.semanticEligible) {
          const semantic = await withTimeout(store.lookupSemantic(scoped.hash, vector), cacheConfig.operationTimeoutMs, "缓存向量查询");
          if (semantic && semantic.distance <= cacheConfig.distanceThreshold) {
            await metric("semanticHits");
            if (cacheConfig.mode === "shadow") {
              await metric("shadowHits");
              return { kind: "shadow_hit", policy, candidate: semantic, vector, promptHash, ...scoped };
            }
            return { kind: "hit", policy, candidate: semantic, vector, promptHash, ...scoped };
          }
        }
        await metric("misses");
        return { kind: "miss", policy, vector, promptHash, ...scoped };
      } catch (error) {
        warnOnce(error);
        return { kind: "unavailable", policy, error: disabledReason };
      }
    },

    async store(input, response, context = {}, lookup = null) {
      if (cacheConfig.mode === "off" || disabledReason || !response?.trim()) return { stored: false };
      const policy = lookup?.policy?.cacheable ? lookup.policy : evaluateCachePolicy(input);
      if (!policy.cacheable) return { stored: false, reason: policy.reason };
      try {
        const scoped = lookup?.hash ? { scope: lookup.scope, hash: lookup.hash } : buildScope(policy, context);
        const promptHash = lookup?.promptHash || sha256(policy.prompt);
        const vector = lookup?.vector || await withTimeout(embedder.embed(policy.prompt), cacheConfig.operationTimeoutMs, "Embedding生成");
        const entryKey = await withTimeout(store.store({
          scope: scoped.hash,
          promptHash,
          prompt: policy.prompt,
          response: response.trim(),
          vector,
          metadata: { ...scoped.scope, embeddingModel: cacheConfig.embeddingModel },
        }), cacheConfig.operationTimeoutMs, "缓存写入");
        await metric("stores");
        return { stored: true, entryKey };
      } catch (error) {
        warnOnce(error);
        return { stored: false, error: disabledReason };
      }
    },

    async status() {
      let redisMetrics = {};
      if (!disabledReason && cacheConfig.mode !== "off") {
        try { redisMetrics = await store.metrics(); } catch (error) { warnOnce(error); }
      }
      const hits = Number(redisMetrics.exactHits || localMetrics.exactHits) + Number(redisMetrics.semanticHits || localMetrics.semanticHits);
      const queries = Number(redisMetrics.queries || localMetrics.queries);
      return {
        mode: cacheConfig.mode,
        available: !disabledReason && cacheConfig.mode !== "off",
        disabledReason,
        threshold: cacheConfig.distanceThreshold,
        ttlSeconds: cacheConfig.ttlSeconds,
        embeddingModel: cacheConfig.embeddingModel,
        vectorBackend: store.backend?.() || "custom",
        metrics: { ...localMetrics, ...redisMetrics, hitRate: queries ? hits / queries : 0 },
      };
    },

    async close() {
      await store.close?.();
    },
  };
}

export function semanticCacheDefaults(workspaceRoot) {
  return {
    mode: "shadow",
    redisUrl: "redis://127.0.0.1:6379",
    connectTimeoutMs: 1000,
    operationTimeoutMs: 3000,
    indexName: "geo_semantic_cache_idx_v1",
    entryPrefix: "geo:semantic-cache:v1:entry:",
    exactPrefix: "geo:semantic-cache:v1:exact:",
    scopeSetPrefix: "geo:semantic-cache:v1:scope:",
    metricsKey: "geo:semantic-cache:v1:metrics",
    maxFallbackCandidates: 2000,
    ttlSeconds: 7 * 24 * 60 * 60,
    distanceThreshold: 0.08,
    embeddingModel: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    dimension: 384,
    modelCacheDirectory: join(workspaceRoot, ".geo-agent", "embedding-models"),
    tenantId: "local-user",
    projectId: "seismic-facies",
    locale: "zh-CN",
    knowledgeVersion: "v1",
    agentVersion: "geo-agent-v1",
  };
}
