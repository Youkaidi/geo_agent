# Geo-Agent 语义缓存（第一版）

## 目标

第一版只缓存不调用工具的独立知识问答。任务提交、实验状态、训练进度、GPU状态、带实验ID的请求和上下文依赖问题全部旁路，避免旧答案影响真实实验。

## 请求流程

1. 规则判断问题是否可缓存。
2. 按租户、项目、意图、知识版本、Agent版本、模型版本和权限作用域生成隔离空间。
3. 先查询规范化文本的SHA-256精确键。
4. 精确未命中且不含数字等硬参数时，生成384维多语言Embedding并做余弦距离查询。
5. `shadow`模式只记录潜在命中，仍调用模型；`active`模式才直接返回缓存答案。
6. 只保存成功、纯文本且没有工具调用的回答。

## 存储与兼容

- Redis 8/Redis Stack存在Query Engine时，自动使用Redis端FLAT向量索引。
- 当前Redis 5没有向量模块时，自动使用Redis存储 + 应用侧FLAT扫描，最多扫描同一作用域的2000条记录。
- 所有条目默认TTL为7天；精确键、回答和作用域索引都会过期。
- Redis或Embedding不可用时，本次会话自动旁路缓存，不影响Agent主流程。
- 在线缓存操作默认3秒超时；首次模型尚未下载时会快速旁路，使用 `npm run cache:warmup` 单独完成预热。

## 配置

`.geo-agent.local.json`：

```json
{
  "semanticCache": {
    "mode": "shadow",
    "redisUrl": "redis://127.0.0.1:6379",
    "ttlSeconds": 604800,
    "distanceThreshold": 0.08,
    "knowledgeVersion": "v1"
  }
}
```

支持三种模式：

- `off`：完全关闭。
- `shadow`：推荐初始模式，记录命中但不复用答案。
- `active`：高置信命中时跳过模型调用。

知识库、系统提示词或领域规则发生实质变化时，应提升 `knowledgeVersion` 或 `agentVersion`，旧缓存会因作用域不同而自然失效。

## 运维命令

```powershell
npm run cache:status
npm run cache:warmup
npm run test
```

`cache:warmup` 会首次下载量化的多语言MiniLM模型到 `.geo-agent/embedding-models`。第一次可能较慢，后续从本地加载。

进入 `npm run geo` 后输入 `/cache` 也可以查看当前会话的命中率、错误数和后端模式。

## 正式启用前验收

至少准备200组业务问题，标注“可以共享答案/不能共享答案”。先在 `shadow` 模式观察潜在命中，优先把错误命中率控制到可接受范围，再将模式切换为 `active`。阈值与Embedding模型绑定，不能直接照搬到其他模型。
