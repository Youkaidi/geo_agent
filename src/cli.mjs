import readline from "node:readline/promises";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import process from "node:process";
import { runAcceptance } from "./acceptance.mjs";
import { runTests } from "./tests.mjs";
import { createGeoAgent } from "./agent.mjs";
import { createTaskNotifier, taskIdFromToolEvent } from "./task-notifier.mjs";

async function runConversation(initialPrompt) {
  const { session, modelFallbackMessage, config } = await createGeoAgent();
  let wroteText = false;
  let lastModelError = "";
  let agentBusy = false;
  let rl = null;
  let waitingForInput = false;
  const pendingNotifications = [];

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
      }
      if (event.type === "tool_execution_start") process.stderr.write(`\n[tool] ${event.toolName}\n`);
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
    try {
      await session.prompt(input);
      await session.waitForIdle();
      return true;
    } catch (error) {
      process.stderr.write(`[request error] ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    }
  }

  try {
    if (initialPrompt) {
      const ok = await sendPrompt(initialPrompt);
      if (!ok) process.exitCode = 1;
      return;
    }
    console.log("Geo-Agent 已启动。输入实验意图；输入 exit 退出。\n");
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
    unsubscribe();
    session.dispose();
  }
}

const args = process.argv.slice(2);
if (args[0] === "--acceptance") await runAcceptance();
else if (args[0] === "--test") await runTests();
else if (args[0] === "--worker") await import("./queue-worker.mjs");
else await runConversation(args.join(" "));