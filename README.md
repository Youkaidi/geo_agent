# Geo Agent

基于 Pi-Agent 的地震相分割科研实验助手。首个适配目标是 [seismic_facies_segforment](https://github.com/Youkaidi/seismic_facies_segforment) 的 `ablation.run_ablation` 流程，运行约束为 PyTorch + 单机单卡 GPU。

## 首个验收场景

用户提出“用 baseline 跑 2 个 epoch”后，Geo-Agent 完成以下闭环：

1. 生成包含目标、假设、参数和成功标准的实验卡。
2. 检查目标项目、六个 F3 NPY 文件、Python/PyTorch CUDA 和 NVIDIA GPU。
3. 在用户明确确认前不启动训练。
4. 后台运行任务并持久化 `experiment.json`、`status.json` 和 `training.log`。
5. 查询 epoch 进度，并从 `summary.json` 汇总验证 MIoU、测试指标和产物路径。

Agent 使用领域工具白名单，不开放任意 shell、文件编辑或写入工具。

## 本机配置

复制 `config/geo-agent.example.json` 为 `.geo-agent.local.json`，填写：

- `trainingProject`：训练项目根目录。
- `pythonCommand`：已安装 PyTorch CUDA 的 Python 可执行文件。
- `dataRoot`：真实 F3 数据目录。
- `proxyUrl`：可选的 HTTP/HTTPS 代理，例如 `http://127.0.0.1:7897`。

也可使用环境变量 `GEO_TRAINING_PROJECT`、`GEO_PYTHON`、`GEO_DATA_ROOT` 覆盖。

## 运行

```powershell
pnpm install
npm run geo
```

对话示例：

```text
请用合成数据准备 baseline 单卡 2 epoch 验收实验
确认运行 exp-...
查询 exp-... 的状态
总结 exp-... 的结果
```

直接执行确定性的端到端验收：

```powershell
npm run acceptance:first
```

运行快速测试：

```powershell
npm test
```

运行产物位于 `.geo-agent/runs/<experiment_id>/`，该目录不会提交到 Git。

## 异步任务队列

> 当前实现仍为 SQLite + 本地 Worker。面向多机多 CPU 的目标方案已完成设计，尚未写入运行代码，详见 [MySQL + RabbitMQ 多机任务系统设计](docs/architecture/mysql-rabbitmq-task-queue.md)。

异步任务功能的业务流程、断点续跑、重试、通知和技术选型说明见 [Geo-Agent 异步实验任务系统说明](docs/async-task-system.md)。

训练提交后会立即返回 `taskId`，任务持久化在 `.geo-agent/queue.sqlite`。单 GPU Worker 串行消费任务，状态包括：

```text
queued → running → succeeded
           ↓
        retrying → running
           ↓
        dead_letter
```

Worker 会为 `preflight`、`training`、`summary` 保存开始/完成检查点，并用租约和心跳防止任务重复执行。进程异常退出后，过期的 `running` 任务会在 Worker 重启时恢复为 `retrying`；重试训练会向目标脚本传入 `--resume`。

在 Agent 中可以输入：

```text
查询任务 task-... 的状态
查看当前任务队列
```

也可以单独以前台方式运行 Worker，便于开发调试：

```powershell
npm run queue:worker
```

正常使用 `npm run geo` 时，提交任务会自动启动后台 Worker，不需要保持 Agent 会话或 HTTP 连接。

当 `npm run geo` 的交互终端保持打开时，CLI 会自动监听本次会话提交的任务。它会在 epoch 变化、任务重试、训练成功或进入死信队列时主动显示通知；用户不需要手动调用 `get_task_status`，也可以在训练期间继续输入其他问题。

```text
[任务进度] task-...：Epoch 1/2（第 1/3 次尝试）
[任务完成] task-...：训练成功
最佳验证 MIoU：0.0277
结果目录：...\outputs
```

关闭 CLI 不会中断后台训练，但终端关闭期间无法显示即时通知；稍后仍可使用 `taskId` 查询持久化结果。

## 真实 F3 数据

真实模式要求数据目录包含：

- `train_seismic.npy` / `train_labels.npy`
- `test1_seismic.npy` / `test1_labels.npy`
- `test2_seismic.npy` / `test2_labels.npy`

首个自动验收使用同名、同维度语义的小型合成 NPY 数据，只验证工程链路，不代表科研精度结论。
