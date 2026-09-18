import { setTimeout as delay } from "node:timers/promises";
import { getExperimentStatus, prepareExperiment, submitExperiment, summarizeExperiment } from "./orchestrator.mjs";

export async function runAcceptance() {
  console.log("[1/5] 创建 synthetic F3 数据并生成实验卡");
  const prepared = prepareExperiment({
    name: "首个验收：MC-Net baseline 单卡 2 epoch",
    dataMode: "synthetic",
    variant: "baseline",
    epochs: 2,
    batchSize: 1,
    baseChannels: 8,
    maxTrainSections: 4,
    maxValidationSections: 1,
    maxTestSections: 2,
  });
  console.log(JSON.stringify({ experimentId: prepared.experimentId, ready: prepared.ready, blockers: prepared.blockers, preflight: prepared.experimentCard.preflight }, null, 2));
  if (!prepared.ready) throw new Error(`验收预检未通过：${prepared.blockers.join("；")}`);

  console.log("[2/5] 模拟验收者明确确认并提交后台训练");
  console.log(JSON.stringify(submitExperiment(prepared.experimentId, true), null, 2));

  console.log("[3/5] 轮询持久化任务状态");
  const deadline = Date.now() + 15 * 60_000;
  let lastMarker = "";
  while (Date.now() < deadline) {
    const status = getExperimentStatus(prepared.experimentId);
    const marker = `${status.state}:${status.progress.currentEpoch}`;
    if (marker !== lastMarker) {
      console.log(JSON.stringify({ state: status.state, progress: status.progress }, null, 2));
      lastMarker = marker;
    }
    if (["completed", "failed"].includes(status.state)) {
      if (status.state === "failed") throw new Error(`训练失败：\n${status.logTail}`);
      break;
    }
    await delay(2_000);
  }

  console.log("[4/5] 解析实验指标与产物");
  const summary = summarizeExperiment(prepared.experimentId);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.passed) throw new Error("验收失败：任务未完成、缺少摘要，或训练没有使用 CUDA");
  if (summary.metrics.epochs !== 2) throw new Error("验收失败：epoch 数不是 2");

  console.log("[5/5] PASS：实验卡 → 预检 → 确认 → SQLite入队 → 后台训练 → 检查点 → 状态查询 → 指标总结闭环通过");
}
