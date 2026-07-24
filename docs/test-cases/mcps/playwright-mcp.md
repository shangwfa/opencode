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
| T45.1 | 创建 session + 沙箱 | |
| T45.2 | 注册 MCP + PG 持久化 | |
| T45.3 | AI 感知 browser_* 工具 | |
| T45.4 | AI 调用 navigate + snapshot | |
| T45.5 | 表单填写 + 提交 | |
| T45.6 | JS eval 数据提取 | |
| T45.7 | 异常处理 | |

**验证层级**：

| 层级 | 标准 |
|------|------|
| CRUD | 创建/PG 持久化 |
| AI 感知 | AI 列出 MCP 工具 |
| AI 调用 | AI 实际调用 browser_* 工具 |
| 真实执行 | 工具驱动 chromium 打开页面 |
| 反馈 | AI 综合工具输出总结 |
