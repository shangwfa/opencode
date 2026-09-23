# Playwright MCP 端到端验证

> 验证 `@playwright/mcp` 在 SaaS 沙箱内完整工作：创建 → PG 持久化 → AI 感知工具 → AI 驱动浏览器。
>
> MCP 文档：https://github.com/microsoft/playwright-mcp

## MCP Server 信息

| 字段 | 值 |
|------|-----|
| 名称 | `playwright` |
| 命令 | `npx -y @playwright/mcp@latest --browser chromium --headless --no-sandbox` |
| 类型 | local（sandbox 内启动 stdio 进程） |
| 功能 | 浏览器自动化（基于 Playwright accessibility tree，非截图） |
| 工具数 | 25+（browser_navigate/click/fill/snapshot/eval/close 等） |
| 特点 | LLM-friendly：纯结构化数据，不需要 vision 模型 |
| OpenCode 配置 | https://github.com/microsoft/playwright-mcp#opencode |

---

## 一、准备 session

### T45.1 创建 session 并启动沙箱

```bash
SID=$(new_sid -kb)
echo "SID: $SID"
```

**期望**：返回 `ses_xxx`；沙箱已就绪。

---

## 二、注册 local MCP

### T45.2 创建并 PG 验证

```bash
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"playwright","type":"local","command":["npx","-y","@playwright/mcp@latest","--browser","chromium","--headless","--no-sandbox"]}'

# PG 验证
psql "$PG_URL" -t -A -c "SELECT name, type FROM session_mcps WHERE session_id='$SID' AND name='playwright'"
```

**期望**：`playwright|local`，PG 持久化正确

---

## 三、AI 感知 MCP 工具

### T45.3 AI 列出可用工具

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请列出你所有以 playwright 或 browser 开头的 MCP 工具名称\"}],\"model\":$MODEL}"
```

**期望**：AI 列出 browser_navigate/browser_click/browser_fill/browser_snapshot/browser_eval 等工具

---

## 四、AI 驱动浏览器

### T45.4 基础：打开页面 + 获取快照

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 playwright MCP 工具完成：1) browser_navigate 打开 https://example.com 2) browser_snapshot 获取页面快照 3) 告诉我页面标题和正文\"}],\"model\":$MODEL}"

# PG 验证
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool' LIKE 'playwright_%' ORDER BY time_created"
```

**期望**：
- `playwright_browser_navigate(completed)`
- `playwright_browser_snapshot(completed)`
- AI 返回 "Example Domain" 标题和正文描述

---

## 五、实战场景

### T45.5 表单填写

```bash
curl -s --max-time 180 -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 playwright MCP 工具：1) 打开 https://httpbin.org/forms/post 2) 填写 custname=张三 custtel=13800000000 3) 提交表单 4) 返回服务器响应 JSON\"}],\"model\":$MODEL}"
```

**期望**：browser_navigate + browser_fill + browser_click，AI 返回 httpbin 回显 JSON

---

### T45.6 JS eval 数据提取

```bash
curl -s --max-time 180 -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 playwright MCP 工具打开 https://books.toscrape.com，用 browser_eval 执行 JS 提取所有书的标题和价格，返回 JSON 数组\"}],\"model\":$MODEL}"
```

**期望**：browser_navigate + browser_eval，AI 返回 ≥10 条书的 {title, price}

---

### T45.7 异常处理

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 playwright MCP 工具打开 https://this-domain-does-not-exist-12345.com，告诉我错误信息\"}],\"model\":$MODEL}"
```

**期望**：AI 不卡死，明确返回"页面无法访问"或类似错误信息

---

## 验收汇总

| 用例 | 验证点 | 结果 |
|------|--------|------|
| T45.1 | 创建 session + 沙箱 | ✅ |
| T45.2 | 注册 MCP + PG 持久化 | ✅ `playwright\|local` |
| T45.3 | AI 感知 browser_* 工具 | ✅ 24 个工具 |
| T45.4 | AI 调用 navigate + snapshot | ✅ 返回 Example Domain 标题/正文 |
| T45.5 | 表单填写 + 提交 | ✅ httpbin 回显 custname/custtel |
| T45.6 | JS eval 数据提取 | ✅ browser_evaluate 返回 JSON 数组 |
| T45.7 | 异常处理 | ✅ net::ERR_NAME_NOT_RESOLVED 正确上报 |

> **2026-08-08 全量重跑记录**（容器 `opencode-saas-test`，`OPENCODE_EXPERIMENTAL_CODE_MODE=mcp`）：T45.1-7 全通过。PG 持久化 `playwright|local`；T45.3 AI 列出 24 个 browser_* 工具；T45.4 navigate+snapshot 返回 Example Domain（首次 navigate error 后 AI 自动重装浏览器自愈）；T45.5 httpbin.org 当日 503 不可用 → AI 触发 question 工具询问，回复"本地创建表单页面"后 AI 自动建 POST 服务器（`/workspace/form_server.py` @ 9095），fill_form+click 提交成功，`/post` 回显 `custname=张三 / custtel=13800138000`；T45.6 browser_evaluate×3 返回 `{h1_text, links}` JSON；T45.7 navigate 不存在域名返回 `net::ERR_NAME_NOT_RESOLVED`。PG `part` 表持久化 playwright.browser_navigate/fill_form/click/evaluate/wait_for 全 completed（navigate 含 error 状态正确记录）。

> **2026-08-21 全量重跑记录**（容器 `opencode-saas-test:13b750953b`，本地 PG `opencode` + 本地 OpenSandbox `opencode-opensandbox:mini` 3.53G，模型 `opencode/muse-spark-1.2-contributor-free`）：T45.1-7 全通过。PG `playwright|local`；T45.3 列出 13+ 个 browser_* 工具（Muse Spark 输出截断）；T45.4 navigate（首次 error 后重试 completed）+ snapshot 返回 Example Domain；T45.5 fill_form + click 提交 httpbin 成功；T45.6 books.toscrape evaluate 返回 20 本书 JSON；T45.7 `net::ERR_NAME_NOT_RESOLVED` 正确上报。PG 有 `error` 与 `completed` 混合记录（符合重试自愈语义）。mini 镜像下 Chromium 正常，无回归。

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| CRUD | 创建/PG 持久化 | ✅ |
| AI 感知 | AI 列出 MCP 工具 | ✅ 24 个 browser_* 工具 |
| AI 调用 | AI 实际调用 browser_* 工具 | ✅ navigate/snapshot/type/click/evaluate 全 completed |
| 真实执行 | 工具驱动 chromium 打开页面 | ✅ |
| 反馈 | AI 综合工具输出总结 | ✅ |

### 修复记录（2026-08-02）

T45.4 实测发现 **supergateway stateless bridge 与 playwright-mcp 不兼容**：playwright-mcp 在 `tools/call` 时会重新发起 initialize 协商并请求 roots/list，supergateway `stdioToStatelessStreamableHttp`（stateless，默认）的 requestId 关联被重置，最终工具结果报 `No connection established for request ID: N` → opencode 侧 MCP 调用超时（navigate 等全部失败）。

**修复**（`packages/opencode/src/mcp/index.ts` `connectSandboxLocal`）：bridge 命令加 `--stateful`，使 stdio→StreamableHttp 保持 session 关联。实测 SDK 客户端 navigate 由超时变为 ~1s 成功。

> 前置条件补充：playwright MCP 依赖 playwright 版本对应的 chromium（`chromium_headless_shell-1232`），沙箱需 `npx playwright install chromium` 预装匹配版本（沙箱 `opencode-opensandbox:local` 镜像建议预装；缺时 AI 会自动检测并安装）。
