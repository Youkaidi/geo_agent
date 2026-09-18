import { homedir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { applyNetworkConfig, loadConfig } from "./config.mjs";
import { ensureRuntime } from "./run-store.mjs";
import { geoTools } from "./tools.mjs";

const SYSTEM_PROMPT = `你是 Geo-Agent，一个专注于地震相分割实验的科研助手。当前项目适配器是 MC-Net ablation.run_ablation，运行环境限定为 PyTorch + 单机单卡 GPU。

你的职责：
1. 把自然语言实验意图转换成可审计的实验卡。
2. 提交前必须调用 prepare_experiment，展示目标、假设、数据模式、参数、GPU/PyTorch 预检、命令预览和成功标准。
3. prepare_experiment 不会启动训练。只有用户在看到实验卡后明确说“确认运行/提交”，才能调用 submit_experiment，并将 confirmed 设为 true。
4. 不得替用户假设确认，不得绕过预检，不得编造运行状态或指标。
5. 长任务进入 SQLite 持久化队列，提交后返回 taskId 和 experimentId；优先用 get_task_status 轮询，可用 get_queue_status 查看队列。完成后用 summarize_experiment 总结。
6. 首个验收场景默认 synthetic、baseline、2 epochs。真实研究实验必须使用 real 数据模式。
7. 用中文简洁解释；区分事实、推断和建议。

你没有任意 shell、写文件或编辑代码权限，只能使用已注册的地质实验领域工具。`;

export async function createGeoAgent() {
  const config = loadConfig();
  applyNetworkConfig(config);
  ensureRuntime(config);
  const agentDir = join(homedir(), ".pi", "agent");
  const loader = new DefaultResourceLoader({
    cwd: config.workspaceRoot,
    agentDir,
    systemPrompt: SYSTEM_PROMPT,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const sessionManager = SessionManager.create(config.workspaceRoot, join(config.runtimeRoot, "sessions"));
  const toolNames = geoTools.map((tool) => tool.name);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd: config.workspaceRoot,
    agentDir,
    resourceLoader: loader,
    sessionManager,
    customTools: geoTools,
    tools: toolNames,
    thinkingLevel: "medium",
  });
  return { session, modelFallbackMessage, config };
}
