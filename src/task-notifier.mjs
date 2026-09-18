import { getTaskStatus, summarizeExperiment } from "./orchestrator.mjs";

const TERMINAL_STATES = new Set(["succeeded", "dead_letter"]);

function parseToolResult(result) {
  if (result?.details && typeof result.details === "object") return result.details;
  for (const item of result?.content || []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    try {
      return JSON.parse(item.text);
    } catch {
      const match = item.text.match(/task-[0-9]{14}-[a-f0-9]{6}/);
      if (match) return { taskId: match[0] };
    }
  }
  return null;
}

export function taskIdFromToolEvent(event) {
  if (event?.type !== "tool_execution_end" || event.toolName !== "submit_experiment" || event.isError) return null;
  const value = parseToolResult(event.result);
  return typeof value?.taskId === "string" ? value.taskId : null;
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function formatProgress(status) {
  const current = number(status.progress?.currentEpoch) ?? 0;
  const total = number(status.progress?.totalEpochs);
  const epoch = total ? `Epoch ${current}/${total}` : "训练中";
  return `[任务进度] ${status.taskId}：${epoch}（第 ${status.attempts}/${status.maxAttempts} 次尝试）`;
}

function formatRetry(status) {
  const when = status.availableAt ? `，下次尝试：${status.availableAt}` : "";
  return `[任务重试] ${status.taskId}：第 ${status.attempts}/${status.maxAttempts} 次尝试失败${when}`;
}

function formatFailure(status) {
  const error = String(status.lastError || "未知错误").split(/\r?\n/)[0];
  return `[任务失败] ${status.taskId} 已进入死信队列\n实验：${status.experimentId}\n原因：${error}\n日志：${status.artifacts?.log || "未知"}`;
}

function formatSuccess(status, summary) {
  const metrics = summary?.metrics;
  const bestMiou = number(metrics?.bestValidationMiou);
  const overallMiou = number(metrics?.overall?.mean_iou);
  const lines = [
    `[任务完成] ${status.taskId}：训练成功`,
    `实验：${status.experimentId}`,
  ];
  if (bestMiou !== null) lines.push(`最佳验证 MIoU：${bestMiou.toFixed(4)}`);
  if (overallMiou !== null) lines.push(`测试 Mean IoU：${overallMiou.toFixed(4)}`);
  lines.push(`结果目录：${status.artifacts?.outputs || "未知"}`);
  return lines.join("\n");
}

export function createTaskNotifier({
  getStatus = getTaskStatus,
  summarize = summarizeExperiment,
  emit = (message) => process.stdout.write(`\n${message}\n`),
  intervalMs = 2_000,
} = {}) {
  const watched = new Map();
  let timer = null;
  let polling = false;

  function ensureTimer() {
    if (timer || watched.size === 0) return;
    timer = setInterval(() => void pollNow(), intervalMs);
    timer.unref();
  }

  function stopTimerIfIdle() {
    if (watched.size !== 0 || !timer) return;
    clearInterval(timer);
    timer = null;
  }

  function watch(taskId) {
    if (!taskId || watched.has(taskId)) return false;
    watched.set(taskId, { marker: null, errors: 0 });
    ensureTimer();
    return true;
  }

  async function pollNow() {
    if (polling) return;
    polling = true;
    try {
      for (const [taskId, tracked] of [...watched]) {
        try {
          const status = await getStatus(taskId);
          tracked.errors = 0;
          const epoch = number(status.progress?.currentEpoch) ?? 0;
          const marker = `${status.state}:${status.attempts}:${epoch}`;
          if (marker === tracked.marker) continue;

          if (status.state === "running") emit(formatProgress(status));
          else if (status.state === "retrying") emit(formatRetry(status));
          else if (status.state === "succeeded") {
            const summary = await summarize(status.experimentId);
            emit(formatSuccess(status, summary));
          } else if (status.state === "dead_letter") emit(formatFailure(status));

          tracked.marker = marker;
          if (TERMINAL_STATES.has(status.state)) watched.delete(taskId);
        } catch (error) {
          tracked.errors += 1;
          if (tracked.errors === 3) {
            emit(`[通知异常] 暂时无法查询 ${taskId}：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } finally {
      polling = false;
      stopTimerIfIdle();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    watched.clear();
  }

  return { watch, pollNow, stop, watchedTaskIds: () => [...watched.keys()] };
}