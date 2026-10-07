# agent-browser MCP 端到端验证（V2）

> 验证用户通过 **local MCP** 模式把 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) 接入 Session 的标准流程：注册 local MCP → AI 调用浏览器工具。
>
> 沙箱镜像 `opencode-opensandbox:local` 已预装 agent-browser + chromium + 系统库（libgtk-3 / libnss3 等），整条链路开箱即用。
>
> **V2 契约**：`POST /api/session/:sessionID/mcps`，payload `{name, config:{type:"local", command:[...]}}`；PG 表 `session_mcps`（`config` jsonb）；prompt 为扁平 `{text, model}`；消息投影 `session_message`，Code Mode 下工具调用经 `execute` 的 `metadata.toolCalls` 记录 `agent-browser.agent_browser_*`。“注册 ≠ 启动、首次调用 lazy 启动并缓存复用”的语义与 V2 `SessionMcps.reconcile` 一致。CRUD/校验/生命周期与 [`session-mcp.md`](./session-mcp.md) T22.x 同资源全覆盖。

## V2 执行记录 2026-10-08（当前代码全量重跑）

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox + 容器 `:14096`，含 2026-10-05/07/08 全部 session-mcp 修复），模型 `Yd-GLM/glm-5.3-flash`，SSE 流式执行器（复用 antd/mastra/playwright 契约经验）。

| 用例 | 结果 | 证据 |
|---|---|---|
| T44.1 session + 沙箱 | ✅ | keep-alive |
| T44.2 预装 + smoke | ✅ | agent-browser **0.38.1** + chromium；DNS 预修后 smoke `Example Domain` 一次通过 |
| T44.3 注册 + PG | ✅ | PG `agent-browser\|{"type":"local","command":["agent-browser","mcp","--tools","core"]}` |
| T44.4 基础调用 | ✅ | `Example Domain` + 中文总结 |
| T44.5 批量提取 | ✅ | books.toscrape £ 价格 ≥10 |
| T44.6 表单填写 | ✅ | 回显 `custname`/`张三` |
| T44.7 SPA 交互 | ✅ | 剩余 todo（买牛奶/睡觉） |
| T44.8 eval 提取 | ✅ | {title, price, availability} 结构化 JSON |
| T44.9 异常处理 | ✅ | 错误明确上报不卡死 |

**执行注记**：执行器在 T44.2 主动预修沙箱 DNS（`nameserver 223.5.5.5/8.8.8.8` 覆盖 `/etc/resolv.conf`）后再 smoke——本轮一次通过（历史两轮均靠 AI 首轮自愈修复 DNS，预修后模型轮次更干净）；agent-browser 为预装二进制，无需 npm 预热。

## V2 执行记录 2026-09-28

> **环境**：Docker `opencode-saas-mcp-v2:local`（`localhost:14099`）、PostgreSQL `opencode-v2-up`、本地 OpenSandbox `opencode-opensandbox:local`（预装 agent-browser 0.38.1 + Chrome for Testing 153，全网关 endpoint 模式）、`Yd-DeepSeek/deepseek-v4-flash`。
>
> **结果**：T44.1–T44.9 全部通过（T44.6 初判 FAIL 为断言脚本本地/服务端时钟偏差的假阴性，按 user prompt 时间分段核对后证据完整）。

| 用例                      | 结果 | 证据                                                                                                                                                                  |
| ------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T44.1 创建 session + 沙箱 | ✅   | session 建立、keepAlive+boot                                                                                                                                          |
| T44.2 验证预装            | ✅   | `agent-browser`（mcp 子命令含 "Start an MCP stdio server"）、`/usr/local/bin/chromium`；smoke test `open example.com → get title` 返回 `Example Domain`              |
| T44.3 注册 + PG           | ✅   | PG `agent-browser\|{"type":"local","command":["agent-browser","mcp","--tools","core"]}`                                                                               |
| T44.4 基础调用            | ✅   | 本轮 `open+snapshot+get_title+get_text+close` 全 completed，AI 中文总结 Example Domain                                                                                |
| T44.5 批量提取            | ✅   | 本轮 `open+eval` completed，Markdown 表格含 £ 价格                                                                                                                    |
| T44.6 表单填写            | ✅   | 本轮 `open+snapshot+fill×3+check×3+eval+click+get_text` 全 completed，httpbin 原样回显 JSON（custname=张三 等）                                                       |
| T44.7 SPA 交互            | ✅   | 本轮 `open+snapshot+type×3+press×3+…` completed，返回剩余 todo（买牛奶/睡觉）                                                                                         |
| T44.8 eval 结构化提取     | ✅   | 本轮 `open+eval` completed，返回 {title, price, availability}                                                                                                         |
| T44.9 异常处理            | ✅   | 本轮 `open\|error`，AI 明确报告 `net::ERR_NAME_NOT_RESOLVED`，并正常 close                                                                                            |

**观察**：

1. **沙箱 DNS（同 playwright 用例）**：Docker Engine 生成的 `nameserver 0.250.250.200`（OrbStack）对域名可能返回无效解析；沙箱内改公共 DNS（223.5.5.5/8.8.8.8）后全部场景正常（或由 AI 首轮自愈）。本地 Docker runtime 环境注意项。
2. **已知噪声**：N44.1 首次调用延迟明显（lazy 启动 + 桥接 + 工具发现，约 16-24s），与“注册 ≠ 启动、成功后缓存复用”语义一致。
3. **断言时钟偏差记录**：V2 `context` 消息时间戳为服务端时钟，跨进程断言按本地 `Date.now()` 过滤会有偏差；应按 user prompt 的 `time.created` 分段取本轮证据。

## MCP Server 信息

| 字段         | 值                                                                            |
| ------------ | ----------------------------------------------------------------------------- |
| 名称         | `agent-browser`                                                               |
| 二进制       | `agent-browser`（native Rust CLI，沙箱预装）                                  |
| MCP 启动命令 | `agent-browser mcp --tools core`（stdio）                                     |
| 类型         | **local**（沙箱内启动 stdio 进程，SaaS 自动桥接）                             |
| 运行位置     | **沙箱**（`/workspace`）                                                      |
| 浏览器       | 沙箱预装 `/usr/local/bin/chromium`（agent-browser 自动发现）                  |
| 工具数       | 29（core profile：open/snapshot/click/fill/get_text/get_title/eval/close 等） |
| 仓库         | https://github.com/vercel-labs/agent-browser                                  |

> **local MCP 的桥接由 SaaS 自动处理**：用户只需注册命令（`POST /api/session/:id/mcps`），SaaS 在 AI 首次调用工具时自动在沙箱里启动 stdio 进程并桥接（`SessionMcps` reconcile → `connectLocal` → supergateway）。用户不需要感知桥接细节。

## 公共配置（V2）

与 [`antd-mcp.md`](./antd-mcp.md) 完全一致（组合 3、Basic auth、`Yd-GLM/glm-5.3-flash`、SSE 流式执行器、context 工具输出特征判定、shell context 读回），此处不重复。

**本用例特有预热**：agent-browser 为预装二进制——预热即 smoke（`agent-browser --version` + `which chromium`）；若 smoke 报 `ERR_NAME_NOT_RESOLVED`，先修沙箱 DNS（`printf 'nameserver 223.5.5.5\n' > /etc/resolv.conf`）再重试。

---

### T44.1 创建 session 并启动沙箱

```js
const { data: s } = await (await api("/api/session", { method: "POST", body: JSON.stringify({ title: "agent-browser-v2" }) })).json()
await api(`/api/experimental/session/${SID}/keep-alive`, { method: "POST", body: JSON.stringify({ enabled: true }) })
```

### T44.2 验证预装 + smoke

```js
// shell: agent-browser --version && which chromium
// shell: agent-browser open https://example.com && agent-browser get title && agent-browser close
// 判定：版本号非空、chromium 路径存在、smoke 输出含 Example Domain（DNS 异常时先修 resolv.conf 重试）
```

### T44.3 注册 + PG 验证

```js
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "agent-browser", config: { type: "local", command: ["agent-browser", "mcp", "--tools", "core"] } }),
})
// PG: SELECT name, config FROM session_mcps ... -> agent-browser | {"type":"local","command":["agent-browser","mcp","--tools","core"]}
```

### T44.4 基础调用（open + snapshot + 总结）

```js
// prompt: "用 agent-browser MCP 工具：1) agent_browser_open 打开 https://example.com 2) agent_browser_snapshot 获取快照 3) 告诉我标题和正文，用一句中文总结"
// 判定：输出含 "Example Domain"
```

### T44.5 多元素批量提取

```js
// prompt: "用 agent-browser MCP 工具打开 https://books.toscrape.com，提取第 1 页所有书（20 本）的标题和价格，以 Markdown 表格返回"
// 判定：£ 价格 ≥10 条
```

### T44.6 表单填写与提交

```js
// prompt: "用 agent-browser MCP 工具：1) 打开 https://httpbin.org/forms/post 2) 填写 custname=张三、custtel=13800000000、size=medium、topping=cheese、topping=mushroom、comments=测试订单 3) 提交 4) 返回服务器 JSON。若目标站不可用可自建等价表单服务器"
// 判定：回显含 custname + 张三
```

### T44.7 SPA 动态交互

```js
// prompt: "用 agent-browser MCP 工具：1) 打开 https://todomvc.com/examples/react/dist/ 2) 添加 3 个 todo：买牛奶、写代码、睡觉 3) 把'买牛奶'标记为完成 4) 删除'写代码' 5) 告诉我剩余 todo 和状态"
// 判定：剩余 买牛奶（completed）+ 睡觉（active）
```

### T44.8 JS eval 结构化提取

```js
// prompt: "用 agent-browser MCP 工具打开 https://books.toscrape.com，用 agent_browser_eval 执行 JS 提取所有书的 {title, price, availability}，返回 JSON 数组（不要表格化）"
// 判定：≥10 条含 title/price/availability 的数据
```

### T44.9 异常处理

```js
// prompt: "用 agent-browser MCP 工具打开 https://this-domain-does-not-exist-12345.com，告诉我页面状态和错误信息"
// 判定：不卡死，报 net::ERR_NAME_NOT_RESOLVED 或等价"无法访问"
```

## 已知噪声

- **N44.1 首次调用延迟**：lazy 启动 + 桥接 + 工具发现（~16-24s），后续复用正常速度。
- **N44.2 daemon 版本检测重启**：`⚠ Daemon version mismatch detected, restarting...`——自动重启后正常。

## 验收汇总

| 用例 | 结果 |
| --- | --- |
| T44.1 创建 session | ✅（2026-10-08） |
| T44.2 验证预装 | ✅ 0.38.1 + smoke（2026-10-08） |
| T44.3 注册 local MCP | ✅（2026-10-08） |
| T44.4 AI 调用浏览器（基础） | ✅ Example Domain（2026-10-08） |
| T44.5 多元素批量提取 | ✅ £ 价格 ×20（2026-10-08） |
| T44.6 表单填写与提交 | ✅ custname/张三（2026-10-08） |
| T44.7 SPA 动态交互 | ✅ 剩余 todo（2026-10-08） |
| T44.8 JS eval 数据提取 | ✅ 结构化 JSON（2026-10-08） |
| T44.9 异常处理 | ✅（2026-10-08） |

## 历史记录（V1 时代，已归档）

- **2026-08-02**（CODE_MODE=all）：T44.1-9 实测通过（同一 session 串行 6 轮，MCP 连接缓存复用）。
- **2026-08-08**（CODE_MODE=mcp）：T44.1-9 全过；httpbin 503 时 AI 自建表单服务器完成 T44.6；MCP 进程 `agent-browser-9100.{pid,log}` 正常。
- V1 原始脚本（`new_sid`/`exec_sb` 辅助函数、`part` 表验证）见 git 历史。
