# Playwright MCP 端到端验证（V2）

> 验证 `@playwright/mcp` 在 SaaS 沙箱内完整工作：创建 → PG 持久化 → AI 感知工具 → AI 驱动浏览器。
>
> MCP 文档：https://github.com/microsoft/playwright-mcp
>
> **V2 契约**：`POST /api/session/:sessionID/mcps`，payload `{name, config:{type:"local", command:[...]}}`；PG 表 `session_mcps`（`config` jsonb）；prompt 为扁平 `{text, model}`；消息投影 `session_message`，Code Mode 下工具调用经 `execute` 的 `metadata.toolCalls` 记录 `playwright.*|completed|error`。V1 的 supergateway `--stateful` 修复已内含于 V2 `bridgeStartCommand`。CRUD/校验/生命周期与 [`session-mcp.md`](./session-mcp.md) T22.x 同资源全覆盖。

## V2 执行记录 2026-10-08（当前代码全量重跑）

> **环境**：组合 3（本地 PG `opencode-v2-up` + 本地 OpenSandbox + 容器 `:14096`，含 2026-10-05/07/08 全部 session-mcp 修复），模型 `Yd-GLM/glm-5.3-flash`，SSE 流式执行器（复用 antd/mastra 契约经验）。

| 用例 | 结果 | 证据 |
|---|---|---|
| T45.1 session + 沙箱 | ✅ | keep-alive + `npm install -g @playwright/mcp` 预热 |
| T45.2 注册 + PG | ✅ | PG `playwright\|{"type":"local","command":["npx","-y","@playwright/mcp@latest","--browser","chromium","--headless","--no-sandbox"]}` |
| T45.3 AI 感知工具 | ✅ | **6/6** 目标工具全部列出（navigate/click/fill/snapshot/evaluate/close） |
| T45.4 navigate + snapshot | ✅ | `Example Domain` 返回（chromium 首次自愈路径照常） |
| T45.5 表单填写 | ✅ | 回显 `custname`/`张三` |
| T45.6 JS eval | ✅ | books.toscrape 价格数据 ≥10 条 |
| T45.7 异常处理 | ✅ | 不存在域名正确报错、轮次正常结束 |

**执行注记**：预热只装 npm 包、chromium 留给首轮自愈（历史验证路径，T45.4 给 600s 预算覆盖版本安装）；T45.5 允许模型在目标站不可用时自建表单服务器（判定只看回显内容，沿用历史先例）。

## V2 执行记录 2026-09-28

> **环境**：Docker `opencode-saas-mcp-v2:local`（`localhost:14099`）、PostgreSQL `opencode-v2-up`、本地 OpenSandbox（`opencode-opensandbox:local` 镜像预装 chromium-1243，全网关 endpoint 模式）、`Yd-DeepSeek/deepseek-v4-flash`。
>
> **结果**：T45.1–T45.7 全部通过（每轮工具调用均按消息时间线核对为本轮证据）。

| 用例                      | 结果 | 证据                                                                                                                                 |
| ------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| T45.1 创建 session + 沙箱 | ✅   | session 建立、keepAlive+boot、沙箱内预热 `@playwright/mcp` 包                                                                        |
| T45.2 注册 + PG 持久化    | ✅   | PG `playwright\|{"type":"local","command":["npx","-y","@playwright/mcp@latest","--browser","chromium","--headless","--no-sandbox"]}` |
| T45.3 AI 感知工具         | ✅   | AI 列出 `playwright` 命名空间 25 个 browser\_\* 工具                                                                                 |
| T45.4 navigate + snapshot | ✅   | 本轮 `browser_navigate`+`browser_snapshot` completed，返回 Example Domain 标题/正文                                                  |
| T45.5 表单填写            | ✅   | 本轮 `navigate+snapshot+fill_form+click+evaluate` 全 completed，httpbin 回显 custname/张三                                           |
| T45.6 JS eval 提取        | ✅   | 本轮 `browser_navigate`+`browser_evaluate` completed，提取书籍标题与价格                                                             |
| T45.7 异常处理            | ✅   | 本轮 `browser_navigate\|error`，AI 明确返回 `net::ERR_NAME_NOT_RESOLVED`，不卡死                                                     |

**观察（自愈过程，均在 T45.4 时间线上有据）**：

1. **chromium 版本自愈**：镜像预装 `chromium-1243`，`@playwright/mcp@latest` 要求更新版本——首次 `browser_navigate` error，AI 按提示自动安装匹配版本后重试成功。
2. **沙箱 DNS 异常由 AI 修复**：OrbStack 容器 DNS 对外网域名可能返回无效解析，AI 诊断修复后导航成功（远端 K8s 沙箱无此现象）。
3. **`--stateful` 桥接有效**：全程无 V1 记录的 `No connection established for request ID` 报错。

## MCP Server 信息

| 字段          | 值                                                                         |
| ------------- | -------------------------------------------------------------------------- |
| 名称          | `playwright`                                                               |
| 命令          | `npx -y @playwright/mcp@latest --browser chromium --headless --no-sandbox` |
| 类型          | local（sandbox 内经 supergateway 桥接 stdio）                               |
| 功能          | 浏览器自动化（基于 Playwright accessibility tree，非截图）                 |
| 工具数        | 25+（browser_navigate/click/fill/snapshot/eval/close 等）                  |
| 特点          | LLM-friendly：纯结构化数据，不需要 vision 模型                             |
| OpenCode 配置 | https://github.com/microsoft/playwright-mcp#opencode                       |

**前置条件**：沙箱需 playwright 对应版本的 chromium。预热建议 `npm install -g @playwright/mcp && npx playwright install chromium`（镜像预装版本不匹配时首次 navigate 会 error，AI 可自愈但慢）。

## 公共配置（V2）

与 [`antd-mcp.md`](./antd-mcp.md) 完全一致（组合 3、Basic auth、`Yd-GLM/glm-5.3-flash`、SSE 流式执行器、context 工具输出特征判定、shell context 读回），此处不重复。

---

### T45.1 创建 session 并启动沙箱

```js
const { data: s } = await (await api("/api/session", { method: "POST", body: JSON.stringify({ title: "playwright-v2" }) })).json()
await api(`/api/experimental/session/${SID}/keep-alive`, { method: "POST", body: JSON.stringify({ enabled: true }) })
// 预热（可靠退出）：npm install -g @playwright/mcp && npx playwright install chromium
```

### T45.2 注册 + PG 验证

```js
await api(`/api/session/${SID}/mcps`, {
  method: "POST",
  body: JSON.stringify({ name: "playwright", config: { type: "local", command: ["npx", "-y", "@playwright/mcp@latest", "--browser", "chromium", "--headless", "--no-sandbox"] } }),
})
// PG: SELECT name, config FROM session_mcps ... -> playwright | {"type":"local","command":[...]}
```

### T45.3 AI 感知工具

```js
// prompt: "请列出你所有以 playwright 或 browser 开头的 MCP 工具名称"
// 判定：模型文本列出 browser_navigate/browser_click/browser_fill/browser_snapshot/browser_evaluate 等
```

### T45.4 navigate + snapshot

```js
// prompt: "用 playwright MCP 工具：1) browser_navigate 打开 https://example.com 2) browser_snapshot 获取快照 3) 告诉我页面标题和正文"
// 判定：completed + 输出含 "Example Domain"
```

### T45.5 表单填写

```js
// prompt: "用 playwright MCP 工具：1) 打开 https://httpbin.org/forms/post 2) 填写 custname=张三 custtel=13800000000 3) 提交 4) 返回服务器响应 JSON"
// 判定：回显含 custname/张三（httpbin 不可用时模型可自建表单服务器——历史先例，判定只看回显内容）
```

### T45.6 JS eval 数据提取

```js
// prompt: "用 playwright MCP 工具打开 https://books.toscrape.com，用 browser_evaluate 提取所有书的标题和价格，返回 JSON 数组"
// 判定：≥10 条 {title, price} 形态数据
```

### T45.7 异常处理

```js
// prompt: "用 playwright MCP 工具打开 https://this-domain-does-not-exist-12345.com，告诉我错误信息"
// 判定：不卡死，返回 net::ERR_NAME_NOT_RESOLVED 或等价"无法访问"信息
```

## 验收汇总

| 用例  | 验证点                      | 结果 |
| ----- | --------------------------- | ---- |
| T45.1 | 创建 session + 沙箱         | ✅（2026-10-08） |
| T45.2 | 注册 MCP + PG 持久化        | ✅（2026-10-08） |
| T45.3 | AI 感知 browser\_\* 工具    | ✅ 6/6（2026-10-08） |
| T45.4 | AI 调用 navigate + snapshot | ✅ Example Domain（2026-10-08） |
| T45.5 | 表单填写 + 提交             | ✅ custname/张三（2026-10-08） |
| T45.6 | JS eval 数据提取            | ✅ ≥10 条价格（2026-10-08） |
| T45.7 | 异常处理                    | ✅（2026-10-08） |

## 历史记录（V1 时代，已归档）

- **2026-08-02 修复**：supergateway stateless bridge 与 playwright-mcp 不兼容（`tools/call` 重新 initialize 协商 + roots/list → `No connection established for request ID` → 超时）。修复：bridge 命令加 `--stateful`。V2 的 `bridgeStartCommand` 内含。
- **2026-08-08**（CODE_MODE=mcp）：T45.1-7 全过；httpbin 当日 503，AI 自建表单服务器完成 T45.5。
- **2026-08-21**（mini 镜像）：T45.1-7 全过（books.toscrape 20 本 JSON）。
- V1 原始脚本见 git 历史。
