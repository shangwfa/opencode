# Mastra MCP 端到端验证（V2）

> 验证 `@mastra/mcp-docs-server` 在 SaaS 沙箱内完整工作：创建 → PG 持久化 → AI 感知工具 → AI 查询文档 → AI 生成代码。
>
> MCP 文档：https://mastra.ai/docs/getting-started/build-with-ai
>
> **V2 契约**：`POST /api/session/:sessionID/mcps`，payload `{name, config:{type:"local", command:[...]}}`；PG 表 `session_mcps`（`config` jsonb）；prompt 为扁平 `{text, model}`（`model.id` 非 `modelID`）；消息投影 `session_message`，Code Mode 下工具调用经 `execute` 的 `metadata.toolCalls` 记录 `mastra.*|completed`。CRUD/校验/生命周期与 [`session-mcp.md`](./session-mcp.md) T22.x 同资源全覆盖。

## V2 执行记录 2026-10-08（当前代码全量重跑）

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox + 容器 `:14096`，含 2026-10-05/07/08 全部 session-mcp 修复），模型 `Yd-GLM/glm-5.3-flash`，SSE 流式执行器（复用 session-mcp.md/antd-mcp.md 契约经验）。

| 用例 | 结果 | 证据 |
|---|---|---|
| T41.1 创建+PG | ✅ | 200；PG `mastra\|{"type":"local","command":["npx","-y","@mastra/mcp-docs-server@latest"]}` |
| T41.2 AI 感知工具 | ✅ | **7/7** 工具全部列出（mastraDocs/searchMastraDocs/listMastraPackages/getMastraExports/getMastraExportDetails/getMastraHelp/getMastraCourseStatus） |
| T41.3 AI 查询文档 | ✅ | completed + Agent 创建示例（`new Agent` 内容） |
| T41.4 AI 生成代码 | ✅ | 6 次工具成功（先查文档再写文件）、`/workspace/my-agent.ts` 2153 字节、`new Agent` ×1 |

**执行注记**：
1. 预热用 `npm install -g @mastra/mcp-docs-server@latest`（antd 用例同款教训：npx stdio server 不因 stdin EOF 退出）；
2. 工具活动判定用轮次事件（`session.tool.success` 计数）——Code Mode 下工具名在 `execute` 的 metadata.toolCalls 里而非顶层 part 名，按名字匹配 completed part state 会漏检（首跑 T41.4 因此误判，文件验证的原始输出证实行为成功后以修正判定复跑）；
3. 文件特征断言解析 stringify 文本时须锚定 `"output":"..."` 段内（避免 context 其他数字干扰）。

## V2 执行记录 2026-09-28

> **环境**：Docker `opencode-saas-mcp-v2:local`（`localhost:14099`）、PostgreSQL `opencode-v2-up`、本地 OpenSandbox（全网关 endpoint 模式）、`Yd-DeepSeek/deepseek-v4-flash`。
>
> **结果**：T41.1–T41.4 全部通过。

| 用例              | 结果 | 证据                                                                                                                                           |
| ----------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| T41.1 创建        | ✅   | 200；PG `mastra\|{"type":"local","command":["npx","-y","@mastra/mcp-docs-server@latest"]}`                                                     |
| T41.2 AI 感知工具 | ✅   | AI 列出 7 个工具（mastraDocs/searchMastraDocs/listMastraPackages/getMastraExports/getMastraExportDetails/getMastraHelp/getMastraCourseStatus） |
| T41.3 AI 查询文档 | ✅   | `mastra.getMastraCourseStatus + getMastraHelp + mastraDocs` completed，返回 agent 创建示例（含 `Agent` 定义）                                  |
| T41.4 AI 生成代码 | ✅   | `mastra.mastraDocs` completed×2，`write` 生成 `/workspace/my-agent.ts`（2543 字节，含 7 处 `Agent`）                                           |

**观察**：

1. `@mastra/mcp-docs-server` 首次 `npx` 下载较慢（历史记录同），注册 MCP 前经 session shell 预热一次后连接正常（日志 `session MCP endpoint resolved ... useServerProxy=true`）。**V2 预热方式**：`npm install -g @mastra/mcp-docs-server`（可靠退出；`npx mcp </dev/null` 的 stdio server 不因 stdin EOF 退出）；npx 缓存在沙箱文件系统内，复用预热须复用同一 session（见 [`antd-mcp.md`](./antd-mcp.md) 2026-10-08 执行注记）。
2. T41.3 中模型两次以 `queryKeywords` 调用 `mastraDocs` 被工具以 `Invalid arguments ... paths: Missing key` 拒绝，收到错误后改用 `paths` 参数调用成功——工具错误透传与模型自纠路径正常，非产品缺陷。

## MCP Server 信息

| 字段          | 值                                                            |
| ------------- | ------------------------------------------------------------- |
| 名称          | `@mastra/mcp-docs-server`                                     |
| 命令          | `npx -y @mastra/mcp-docs-server@latest`                       |
| 类型          | local（sandbox 内经 supergateway 桥接 stdio）                  |
| 功能          | Mastra 框架文档查询、API 参考、代码示例、迁移工具             |
| OpenCode 配置 | https://mastra.ai/docs/getting-started/build-with-ai#opencode |

## 公共配置（V2）

与 [`antd-mcp.md`](./antd-mcp.md) 完全一致（组合 3、Basic auth、`Yd-GLM/glm-5.3-flash`、SSE 流式执行器、context 工具输出特征判定），此处不重复。

---

### T41.1 创建 local MCP

```js
const res = await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "mastra", config: { type: "local", command: ["npx", "-y", "@mastra/mcp-docs-server@latest"] } }),
})
// expect 200; PG: SELECT name, config FROM session_mcps ... -> mastra | {"type":"local","command":["npx","-y","@mastra/mcp-docs-server@latest"]}
```

### T41.2 AI 感知 MCP 工具

```js
// prompt: "请列出你所有以 mastra 开头的 MCP 工具名称和功能"
// 判定：模型文本列出 ≥4 个工具（mastraDocs/searchMastraDocs/listMastraPackages/getMastraExports/...）
```

### T41.3 AI 调用 MCP 工具查询文档

```js
// prompt: "用 mastra MCP 工具查询如何创建一个 agent，给我一个简单的示例"
// 判定：completed 工具 part + 输出含 Agent 创建内容（new Agent / Agent 定义示例）
```

**PG 验证**：`session_message` 的 `metadata.toolCalls` 含 `mastra.*|completed`。

### T41.4 AI 基于 MCP 文档生成代码

```js
// prompt: "用 mastra MCP 工具查看文档后，帮我创建一个简单的 Mastra agent 到 /workspace/my-agent.ts，功能是回答天气问题"
// 判定：mastra 工具调用 completed；/workspace/my-agent.ts 存在且含 new Agent（沙箱 shell 验证字节数 + 内容特征）
```

## 验收汇总

| 用例              | 结果 | 验证详情 |
| ----------------- | ---- | -------- |
| T41.1 创建 MCP    | ✅（2026-10-08） | PG config jsonb 一致 |
| T41.2 AI 感知工具 | ✅（2026-10-08） | 7/7 mastra 工具 |
| T41.3 AI 查询文档 | ✅（2026-10-08） | completed + Agent 示例 |
| T41.4 AI 生成代码 | ✅（2026-10-08） | 6 次工具成功 + my-agent.ts（2153B，new Agent） |

## 历史记录（V1 时代，已归档）

- **2026-08-08**（CODE_MODE=mcp）：T41.1-4 全过；T41.4 生成 `/workspace/src/mastra/` 三文件结构。
- **2026-08-21**（mini 镜像）：初测超时（MCP 首启慢 + 模型超时），沙箱 npm 切淘宝源后 T41.1-4 全过（my-agent.ts 2762 字节）。
- V1 原始脚本（`/session/:id/mcps/create`、`part` 表、`$BASE/$PG_URL` 全局变量）见 git 历史。
