import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  getExperimentStatus,
  getQueueStatus,
  getTaskStatus,
  inspectTrainingProject,
  prepareExperiment,
  submitExperiment,
  summarizeExperiment,
} from "./orchestrator.mjs";

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

export const geoTools = [
  defineTool({
    name: "inspect_training_project",
    label: "检查地震相分割项目",
    description: "检查已配置的 MC-Net 地震相分割项目结构、Python 命令和数据路径，不启动训练。",
    parameters: Type.Object({}),
    execute: async () => result(inspectTrainingProject()),
  }),
  defineTool({
    name: "prepare_experiment",
    label: "准备实验卡",
    description: "创建实验卡并执行项目、F3 数据、PyTorch CUDA 与 GPU 预检。此工具绝不会启动训练。",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "实验名称" })),
      objective: Type.Optional(Type.String({ description: "实验目标" })),
      hypothesis: Type.Optional(Type.String({ description: "待验证假设" })),
      dataMode: Type.Union([Type.Literal("synthetic"), Type.Literal("real")], { description: "synthetic 用于首个烟雾验收；real 使用真实 F3 数据" }),
      variant: Type.Optional(Type.Union([Type.Literal("baseline"), Type.Literal("ell"), Type.Literal("vtpm"), Type.Literal("full")])),
      epochs: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      batchSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
      baseChannels: Type.Optional(Type.Integer({ minimum: 4, maximum: 64 })),
      maxTrainSections: Type.Optional(Type.Integer({ minimum: 1, maximum: 512 })),
      maxValidationSections: Type.Optional(Type.Integer({ minimum: 1, maximum: 128 })),
      maxTestSections: Type.Optional(Type.Integer({ minimum: 1, maximum: 256 })),
    }),
    execute: async (_id, params) => result(prepareExperiment(params)),
  }),
  defineTool({
    name: "submit_experiment",
    label: "提交实验队列",
    description: "用户明确确认实验卡后，将训练持久化到异步任务队列。没有 confirmed=true 时必须拒绝。",
    parameters: Type.Object({
      experimentId: Type.String({ pattern: "^exp-[0-9]{14}-[a-f0-9]{6}$" }),
      confirmed: Type.Boolean({ description: "仅在用户明确确认后设为 true" }),
    }),
    execute: async (_id, params) => result(submitExperiment(params.experimentId, params.confirmed)),
  }),
  defineTool({
    name: "get_task_status",
    label: "查询异步任务",
    description: "使用 taskId 查询持久化队列状态、重试次数、检查点、训练进度和日志，无需保持原会话。",
    parameters: Type.Object({ taskId: Type.String({ pattern: "^task-[0-9]{14}-[a-f0-9]{6}$" }) }),
    execute: async (_id, params) => result(getTaskStatus(params.taskId)),
  }),
  defineTool({
    name: "get_queue_status",
    label: "查询任务队列",
    description: "查询各状态任务数量及单 GPU Worker 是否存活。",
    parameters: Type.Object({}),
    execute: async () => result(getQueueStatus()),
  }),
  defineTool({
    name: "get_experiment_status",
    label: "查询实验状态",
    description: "兼容接口：使用 experimentId 查询对应异步任务、epoch 进度和检查点。",
    parameters: Type.Object({ experimentId: Type.String() }),
    execute: async (_id, params) => result(getExperimentStatus(params.experimentId)),
  }),
  defineTool({
    name: "summarize_experiment",
    label: "总结实验",
    description: "读取训练产物、任务检查点并输出验收结论和核心指标。",
    parameters: Type.Object({ experimentId: Type.String() }),
    execute: async (_id, params) => result(summarizeExperiment(params.experimentId)),
  }),
];
