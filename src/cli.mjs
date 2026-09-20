import readline from "node:readline/promises";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import process from "node:process";
import { runAcceptance } from "./acceptance.mjs";
import { runTests } from "./tests.mjs";
import { createGeoAgent } from "./agent.mjs";
import { createTaskNotifier, taskIdFromToolEvent } from "./task-notifier.mjs";
import { applyNetworkConfig, loadConfig } from "./config.mjs";
import { createSemanticCache, LocalMultilingualEmbedder } from "./semantic-cache.mjs";

async function runCacheCommand(warmup = false) {
  const config = loadConfig();
  applyNetworkConfig(config);
  if (warmup) {
    const startedAt = Date.now();
    const vector = await new LocalMultilingualEmbedder(config.semanticCache).embed("地震相分割语义缓存初始化");
    console.log(JSON.stringify({ ready: true, dimension: vector.length, elapsedMs: Date.now() - startedAt, model: config.semanticCache.embeddingModel }, null, 2));
    return;
  }
  const cache = createSemanticCache(config);
  try { console.log(JSON.stringify(await cache.status(), null, 2)); }
  finally { await cache.close(); }
}

async function runConversation(initialPrompt) {
  const { session, modelFallbackMessage, config } = await createGeoAgent();
  let wroteText = false;
  let lastModelError = "";
  let agentBusy = false;
  let rl = null;
  let waitingForInput = false;
  const pendingNotifications = [];
  let activePromptRun = null;
  const semanticCache = createSemanticCache(config, {
    onWarning: (message) => process.stderr.write(`[cache] Redis/Embedding不可用，本会话已旁路语义缓存：${message}\n`),
  });

  function cacheContext() {
    const model = session.model;
    return {
      modelVersion: [model?.provider, model?.id].filter(Boolean).join(":") || "unknown-model",
    };
  }

  function writeNotification(message) {
    if (agentBusy || wroteText) {
      pendingNotifications.push(message);
      return;
    }
    if (rl && waitingForInput && process.stdout.isTTY) {
      const currentLine = rl.line || "";
      const cursor = Number.isInteger(rl.cursor) ? rl.cursor : currentLine.length;
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      process.stdout.write(`${message}\n你> ${currentLine}`);
      if (cursor < currentLine.length) moveCursor(process.stdout, cursor - currentLine.length, 0);
      return;
    }
    process.stdout.write(`\n${message}\n`);
  }

  function flushNotifications() {
    while (pendingNotifications.length) writeNotification(pendingNotifications.shift());
  }

  const notifier = createTaskNotifier({ emit: writeNotification });

  if (modelFallbackMessage) process.stderr.write(`[model] ${modelFallbackMessage}\n`);
  if (config.proxyUrl) process.stderr.write(`[network] 已使用代理 ${config.proxyUrl}\n`);

  const unsubscribe = session.subscribe((event) => {
    try {
      if (event.type === "agent_start") agentBusy = true;
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
        wroteText = true;
      }
      if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason === "error") {
        lastModelError = event.message.errorMessage || "模型请求失败";
        if (activePromptRun) activePromptRun.failed = true;
      }
      if (event.type === "tool_execution_start") {
        if (activePromptRun) activePromptRun.toolCalls += 1;
        process.stderr.write(`\n[tool] ${event.toolName}\n`);
      }
      if (event.type === "tool_execution_end") {
        const taskId = taskIdFromToolEvent(event);
        if (taskId && notifier.watch(taskId)) {
          pendingNotifications.push(`[任务监听] 已自动监听 ${taskId}，完成后会在当前终端通知。`);
        }
      }
      if (event.type === "auto_retry_start") {
        process.stderr.write(`[retry] 第 ${event.attempt}/${event.maxAttempts} 次重试：${event.errorMessage}\n`);
      }
      if (event.type === "agent_settled") {
        if (wroteText) process.stdout.write("\n");
        if (lastModelError) process.stderr.write(`[model error] ${lastModelError}\n`);
        wroteText = false;
        lastModelError = "";
        agentBusy = false;
        flushNotifications();
      }
    } catch (error) {
      process.stderr.write(`[event error] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  });

  async function sendPrompt(input) {
    if (input === "/cache") {
      process.stdout.write(`${JSON.stringify(await semanticCache.status(), null, 2)}\n`);
      return true;
    }
    const context = cacheContext();
    const lookup = await semanticCache.lookup(input, context);
    if (lookup.kind === "hit") {
      const label = lookup.candidate.match === "exact" ? "精确" : `语义 distance=${lookup.candidate.distance.toFixed(4)}`;
      process.stderr.write(`[cache] ${label}命中，已跳过模型调用\n`);
      process.stdout.write(`${lookup.candidate.response}\n`);
      await session.sendCustomMessage({
        customType: "semantic-cache-replay",
        content: `[历史问答：由语义缓存返回，仅作为此前对话上下文，不需要对此消息作答]\n用户：${input}\n助手：${lookup.candidate.response}`,
        display: false,
        details: { match: lookup.candidate.match, distance: lookup.candidate.distance },
      }, { triggerTurn: false });
      return true;
    }
    if (lookup.kind === "shadow_hit") {
      const distance = Number(lookup.candidate.distance).toFixed(4);
      process.stderr.write(`[cache shadow] 潜在${lookup.candidate.match}命中 distance=${distance}；本次仍调用模型\n`);
    }
    activePromptRun = { toolCalls: 0, failed: false };
    try {
      await session.prompt(input);
      await session.waitForIdle();
      const run = activePromptRun;
      const answer = session.getLastAssistantText();
      if (!run.failed && run.toolCalls === 0 && answer) {
        await semanticCache.store(input, answer, context, lookup);
      }
      return true;
    } catch (error) {
      if (activePromptRun) activePromptRun.failed = true;
      process.stderr.write(`[request error] ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    } finally {
      activePromptRun = null;
    }
  }

  try {
    if (initialPrompt) {
      const ok = await sendPrompt(initialPrompt);
      if (!ok) process.exitCode = 1;
      return;
    }
    console.log(`Geo-Agent 已启动。输入实验意图；输入 exit 退出；输入 /cache 查看缓存状态。\n\n[cache] mode=${config.semanticCache.mode}\n`);
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    while (true) {
      waitingForInput = true;
      const input = (await rl.question("你> ")).trim();
      waitingForInput = false;
      if (!input) continue;
      if (["exit", "quit", "/exit"].includes(input.toLowerCase())) break;
      await sendPrompt(input);
    }
    rl.close();
  } finally {
    notifier.stop();
    await semanticCache.close();
    unsubscribe();
    session.dispose();
  }
}

const args = process.argv.slice(2);
if (args[0] === "--acceptance") await runAcceptance();
else if (args[0] === "--test") await runTests();
else if (args[0] === "--worker") await import("./queue-worker.mjs");
else if (args[0] === "--cache-status") await runCacheCommand(false);
else if (args[0] === "--cache-warmup") await runCacheCommand(true);
else await runConversation(args.join(" "));
