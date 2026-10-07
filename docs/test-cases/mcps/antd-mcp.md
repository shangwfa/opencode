# Ant Design MCP 端到端验证（V2）

> 验证 Session MCP 功能通过 Ant Design 官方 MCP Server 完整生效：创建 → PG 持久化 → sandbox 启动 MCP server → AI 感知工具 → AI 查询 API → AI 生成代码。
>
> **V2 契约**：`POST /api/session/:sessionID/mcps`，payload `{name, config:{type:"local", command:[...]}}`；PG 表 `session_mcps`（`config` jsonb 取代 V1 扁平列）；prompt 为扁平 `{text, model}`（`model.id` 非 `modelID`）；消息投影 `session_message`，Code Mode 下工具调用经 `execute` 的 `metadata.toolCalls` 记录 `antd.antd_*|completed`。CRUD/校验/生命周期与 [`session-mcp.md`](./session-mcp.md) T22.x 同资源全覆盖，本文件聚焦 antd 真实 server 的 AI 链路。

## V2 执行记录 2026-10-08（当前代码全量重跑）

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox + 容器 `:14096`，含 2026-10-05/07/08 全部 session-mcp 修复），模型 `Yd-GLM/glm-5.3-flash`，SSE 流式执行器（复用 session-mcp.md 契约经验）。

| 用例 | 结果 | 证据 |
|---|---|---|
| T40.1 创建+PG | ✅ | `POST /api/session/:id/mcps` 200；PG `antd\|{"type":"local","command":["npx","-y","@ant-design/cli","mcp"]}` |
| T40.2 列表/隔离 | ✅ | 列表含 antd；B 会话同名 `--other` command 互不可见；PG 2 条（深度 CRUD/级联由 T22 回归覆盖） |
| T40.3 AI 感知工具 | ✅ | 8/8 工具全部列出（list/info/doc/demo/token/design_md/semantic/changelog） |
| T40.4 antd_list | ✅ | completed + 真实组件名（Affix/Alert/Button…） |
| T40.5 antd_info | ✅ | completed + Button 真实 props（autoInsertSpace/classNames…） |
| T40.6 完整开发流程 | ✅ | antd 工具调用 37 次（查 API/示例→生成）；`/workspace/Dashboard.tsx` **877 行**，Card/Statistic/Table/Layout 特征 34 处、`useToken` 4 处（antd v6 API）；模型自主 `npm install` + `tsc --strict` 类型检查通过 + SSR 冒烟通过，并修复 antd v6 `filters` 的 `text` 字段类型错误 |

**执行注记**：
1. 预热须用 `npm install -g @ant-design/cli`（可靠退出）；`npx mcp </dev/null` 的 stdio server 不因 stdin EOF 退出，shell 超时中断且 marker 丢失；
2. **npx 缓存在沙箱文件系统内**——复用预热结果必须复用同一 session（新 session 新沙箱缓存全无）；
3. 执行器文件特征断言须匹配 stringify 文本中的字面 `\n`（非真实换行）。

## V2 执行记录 2026-09-27

> **环境**：Docker `opencode-saas-mcp-v2:local`（`localhost:14099`）、PostgreSQL `opencode-v2-up`、本地 OpenSandbox、`Yd-DeepSeek/deepseek-v4-flash`。
>
> **结果**：T40.1–T40.6 全部通过。此前 local MCP 桥接的 shell 转义 bug 修复后（见 [`session-mcp.md`](./session-mcp.md) V2 执行记录），antd local MCP 链路首次即打通。

| 用例                 | 结果 | 证据                                                                                                                              |
| -------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| T40.1 创建           | ✅   | `POST /api/session/:id/mcps` 200；PG `antd\|{"type":"local","command":["npx","-y","@ant-design/cli","mcp"]}`                      |
| T40.2 CRUD/隔离/级联 | ✅   | 列表含 antd；跨 session 同名不同 command 互不可见（PG 2 条）；删除单个 PG 0；删 session 级联 PG 0                                 |
| T40.3 AI 感知工具    | ✅   | AI 列出全部 8 个工具（antd_list/info/doc/demo/token/design_md/semantic/changelog）                                                |
| T40.4 antd_list      | ✅   | `toolCalls: antd.antd_list\|completed`，返回 71 组件（Affix, Alert, Anchor, App, … Button …）                                     |
| T40.5 antd_info      | ✅   | `antd.antd_info\|completed`，Button 完整 props 表（autoInsertSpace/block/classNames…含类型与默认值）                              |
| T40.6 完整开发流程   | ✅   | `antd_list×1 + antd_info×5 + antd_demo×9` 全 completed，`write` 生成 `/workspace/Dashboard.tsx` 506 行，含 Layout/Statistic/Table |

**观察**：sandbox 首次 `npx -y @ant-design/cli` 需下载预热（历史记录的"首次超时后预热重试"即此）；注册 MCP 前经 session shell 预热一次后，MCP 首连即成功。

## 测试环境（V2，组合 3）

- 容器：`opencode-saas-test`（localhost:14096，Basic auth `opencode:<docker logs 的 server password>`）
- PG：本地 `postgresql://local@127.0.0.1:5432/opencode-v2-up`
- Sandbox：本地 OpenSandbox（Docker runtime，`opencode-opensandbox:local`）
- 模型：`Yd-GLM/glm-5.3-flash`（V1 时代为 Yd-DeepSeek）

## MCP Server 信息

| 字段   | 值                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------- |
| 名称   | `@ant-design/cli`                                                                                                |
| 命令   | `npx -y @ant-design/cli mcp`                                                                                     |
| 类型   | local（sandbox 内经 supergateway 桥接 stdio）                                                                     |
| 文档   | https://ant.design/docs/react/mcp-cn                                                                             |
| 工具数 | 8（antd_list / antd_info / antd_doc / antd_demo / antd_token / antd_design_md / antd_semantic / antd_changelog） |

## 公共配置（V2）

```js
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-GLM", id: "glm-5.3-flash" }
const pw = <docker logs 抓取 "server password">
const H = { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}` }
const api = (p, i = {}) => fetch(BASE + p, { ...i, headers: { ...H, ...(i.headers ?? {}) } })

// 创建会话（V2 响应 { data: { id } }）+ keep-alive（/api/experimental 下）
const { data: s } = await (await api("/api/session", { method: "POST", body: JSON.stringify({ title: "antd" }) })).json()
await api(`/api/experimental/session/${s.id}/keep-alive`, { method: "POST", body: JSON.stringify({ enabled: true }) })

// 注册 antd MCP（V2：config 包装）
await api(`/api/session/${s.id}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "antd", config: { type: "local", command: ["npx", "-y", "@ant-design/cli", "mcp"] } }),
})

// 模型轮次：POST /api/session/:id/prompt_stream（SSE，实时观察 + 表单/权限自动应答）
// 工具判定：context 的 assistant content[] 中 completed tool part（Code Mode 下经 execute），
// 以工具真实输出特征（如组件名/props 名）为准 —— 详见 session-mcp.md 执行器契约经验。
// 沙箱命令：POST /api/session/:id/shell（204）+ 从 context 的 shell part 读回输出。
```

---

## T40.1 创建 local MCP

```js
const res = await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "antd", config: { type: "local", command: ["npx", "-y", "@ant-design/cli", "mcp"] } }),
})
// expect 200, res.data.name === "antd", res.data.config.type === "local"
```

**PG 验证**：

```sql
SELECT name, config FROM session_mcps WHERE session_id='<SID>';
-- antd | {"type":"local","command":["npx","-y","@ant-design/cli","mcp"]}
```

## T40.2 列出/删除/隔离/级联

与 session-mcp T22.x 同资源（V2 回归 7/7 已覆盖 remove/clear/级联/404/校验）。本用例保留 antd 特有的快速断言：

| 检查 | 命令 | 期望 |
|---|---|---|
| 列表 | `GET /api/session/:id/mcps` | `{data:[{name:"antd",…}]}` |
| 隔离 | A/B 各建 `antd`（不同 command） | A/B 各自可见自己的 config；PG 2 条 |
| 删除单个 | `DELETE .../mcps/antd`（沙箱就绪后） | 204，列表/PG 清零，bridge 进程被杀 |

## T40.3 AI 感知 MCP 工具

```js
// prompt: "请列出你当前所有以 antd_ 开头的 MCP 工具名称和功能。"
// 判定：模型文本列出 ≥6 个 antd_ 工具名（list/info/doc/demo/token/design_md/semantic/changelog）
```

**期望**：AI 正确感知 8 个工具（`antd_antd_list` … `antd_antd_changelog`）。

## T40.4 调用 antd_list 列出组件

```js
// prompt: "用 antd_antd_list 工具列出所有可用的 antd 组件，只列出组件名"
// 判定：completed 工具 part + 输出含真实组件名（Affix / Alert / Anchor / App / Button …）
```

**PG 验证**：`session_message` 中该消息的 `metadata.toolCalls` 含 `antd.antd_list|completed`。

## T40.5 调用 antd_info 获取 Button API

```js
// prompt: "用 antd_antd_info 工具查看 Button 组件的 API 信息"
// 判定：completed + 输出含 Button 的真实 props（autoInsertSpace / block / classNames 等，含类型与默认值）
```

## T40.6 完整开发流程：AI 用 MCP 设计数据看板

**Prompt**：

> 帮我设计一个数据看板页面，使用 Ant Design 组件库。要求：
> 1. 顶部：4 个统计卡片（总用户、活跃用户、收入、转化率），带图标和趋势
> 2. 中间：左侧折线图区域，右侧饼图区域
> 3. 底部：数据表格，带搜索和分页
> 4. 先用 antd MCP 工具查看 Card、Statistic、Table、Layout 组件的最新 API 和示例，再写代码
> 5. 输出完整的单个 tsx 文件

**期望**：
- 工具链：`antd_list` + `antd_info`/`antd_demo` 多次全 completed（经 execute 的 toolCalls）；
- `write` 生成 `/workspace/Dashboard.tsx`（沙箱文件验证：存在、行数 > 150、内容含 `Card`/`Statistic`/`Table`）；
- 代码使用 antd 真实 API（先查文档再生成的行为闭环）。

## 验收汇总

| 用例 | 结果 | 验证详情 |
| ---- | ---- | ---- |
| T40.1 创建 MCP | ✅（2026-10-08） | PG config jsonb 一致 |
| T40.2 CRUD | ✅（2026-10-08） | 列出/隔离通过（深度覆盖引用 T22 回归） |
| T40.3 AI 感知工具 | ✅（2026-10-08） | 8/8 antd_ 工具 |
| T40.4 antd_list | ✅（2026-10-08） | completed + 真实组件名 |
| T40.5 antd_info | ✅（2026-10-08） | completed + Button props |
| T40.6 完整开发流程 | ✅（2026-10-08） | 37 次工具调用 + 877 行 Dashboard.tsx + tsc --strict/SSR 通过 |

## 历史记录（V1 时代，已归档）

- **MCP.node deps 缺 Database.node 修复（2026-08-02 前）**：LayerNode 重构后 `MCP.node` deps 缺 `Database.node`，`SessionMcp.pgLayer` 在 AI 消息上下文不可用——session MCP 写入 PG 但 AI 无法感知。修复：deps 补 `FSUtil.node, Database.node`。V2 架构下服务为 Location 级 `makeLocationNode`（`instance.ts`），该问题形态不复存在。
- **重跑记录**：2026-08-02（CODE_MODE=all，412 行 Dashboard）、2026-08-08（CODE_MODE=mcp，165 行）、2026-08-21（mini 镜像，524 行）、2026-09-06（endpoint 双模式 A/B 均通过，见 [`local-mcp-endpoint-mode.md`](./local-mcp-endpoint-mode.md)）、2026-09-15（无 CODE_MODE env，auto 路径，toolCalls 持久化一致）。V1 原始脚本见 git 历史。
