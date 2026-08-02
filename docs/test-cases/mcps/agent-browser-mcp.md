# agent-browser MCP 端到端验证

> 验证用户通过 **local MCP** 模式把 [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) 接入 Session 的标准流程：注册 local MCP → AI 调用浏览器工具。
>
> 沙箱镜像 `opencode-opensandbox:local` 已预装 agent-browser 0.31.1 + chromium + 系统库（libgtk-3 / libnss3 等），整条链路开箱即用。

## MCP Server 信息

| 字段 | 值 |
|------|-----|
| 名称 | `agent-browser` |
| 二进制 | `agent-browser`（native Rust CLI，沙箱预装 0.31.1） |
| MCP 启动命令 | `agent-browser mcp --tools core`（stdio） |
| 类型 | **local**（沙箱内启动 stdio 进程，SaaS 自动桥接） |
| 运行位置 | **沙箱**（`/workspace`） |
| 浏览器 | 沙箱预装 `/usr/local/bin/chromium`（agent-browser 自动发现） |
| 工具数 | 29（core profile：open/snapshot/click/fill/get_text/get_title/eval/close 等） |
| 仓库 | https://github.com/vercel-labs/agent-browser |

> **local MCP 的桥接由 SaaS 自动处理**：用户只需要 `mcps/create` 注册命令，SaaS 在 AI 首次调用工具时自动在沙箱里启动 stdio 进程并桥接（`connectSandboxLocal`，`mcp/index.ts:684`）。用户不需要感知桥接细节。

---

## 接入流程概览

| 步骤 | 动作 | 章节 |
|------|------|------|
| 1. 创建 session | `new_sid -k` 启动沙箱 | T44.1 |
| 2. 验证预装 | 通过 `exec` 接口确认 agent-browser + chromium 可用 | T44.2 |
| 3. 注册 local MCP | `mcps/create {type:"local", command:[...]}` 写入 PG | T44.3 |
| 4. AI 调用 | `prompt_async` 触发，SaaS 在首次调用时 lazy 启动 MCP 进程 | T44.4 |

**关键**：步骤 3 只写 PG `session_mcps` 表，**不启动进程**。真正启动发生在步骤 4 —— AI 每轮 step 调用 `toolsForSession`（`session/tools.ts:413`）时按需启动 stdio MCP 子进程并桥接（`connectSandboxLocal`），成功后缓存复用。

---

## 前置条件

### 1. 沙箱镜像已预装以下资源（`opencode-opensandbox:local` 默认包含）

| 资源 | 路径 / 验证方式 |
|------|----------------|
| agent-browser ≥ 0.31.0 | `agent-browser --version`（含 `mcp` 子命令） |
| chromium | `/usr/local/bin/chromium`（agent-browser 自动发现） |
| Chrome 系统依赖 | libgtk-3-0t64、libnss3、libatk 等已预装 |

> 若沙箱镜像版本较旧缺上述依赖，可通过 `exec` 接口手动补：`npm install -g agent-browser@latest` + `apt-get install -y chromium-browser libgtk-3-0 libnss3`。

### 2. 测试环境变量与辅助函数

组合 3（本地 PG + 本地 OpenSandbox）所需的环境变量与辅助函数，直接在 shell 中执行：

```bash
# —— 环境变量（组合 3：本地 PG + 本地 OpenSandbox）——
export BASE="http://localhost:14096"
export PG_URL="postgresql://local@127.0.0.1:15432/opencode"
export MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
export NO_PROXY=localhost,127.0.0.1

# —— 辅助函数 ——
# JSON 解析（容错未转义控制字符）
jexec() { python3 -c "import json,sys; d=json.load(sys.stdin, strict=False); print($1)" 2>/dev/null; }

# 创建 session；-k 同时开 keepAlive，-kb 再加 boot 立即起沙箱
new_sid() {
  local sid
  sid=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
  case "${1:-}" in
    -k)  curl -s -X POST "$BASE/session/$sid/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null ;;
    -kb) curl -s -X POST "$BASE/session/$sid/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' >/dev/null ;;
  esac
  echo "$sid"
}

# 在沙箱里执行命令
exec_in_sandbox() {
  local sid="$1"; shift
  curl -s -X POST "$BASE/session/$sid/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"$*\"}" | jexec "(d.get('stdout') or '') + (d.get('stderr') or '')"
}

# PG 取单值（无表头）
pgval() { psql "$PG_URL" -t -A -c "$1" 2>/dev/null; }
```

---

## 一、准备 session

### T44.1 创建 session 并启动沙箱

```bash
SID=$(new_sid -kb)        # -kb: keepAlive + boot，立即起沙箱
echo "SID: $SID"
```

**期望**：返回 `ses_xxx`；沙箱已就绪。

---

## 二、验证沙箱预装

### T44.2 确认 agent-browser + chromium 可用

```bash
exec_in_sandbox "$SID" 'agent-browser --version'
exec_in_sandbox "$SID" 'agent-browser mcp --help | head -1'
exec_in_sandbox "$SID" 'which chromium && chromium --version 2>&1 | head -1'

# 快速 smoke test：直接用 CLI 打开页面，确认能驱动浏览器
exec_in_sandbox "$SID" 'agent-browser open https://example.com && agent-browser get title && agent-browser close'
```

**期望**：
- `agent-browser --version` 返回 ≥ 0.31.0
- `agent-browser mcp --help` 输出含 `Start an MCP stdio server`
- `which chromium` 返回 `/usr/local/bin/chromium`，`chromium --version` 有版本号
- smoke test 输出含 `Example Domain`

---

## 三、注册 local MCP

### T44.3 创建并 PG 验证

```bash
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"agent-browser","type":"local","command":["agent-browser","mcp","--tools","core"]}' \
  | python3 -m json.tool

# PG 验证
psql "$PG_URL" -t -A -c "SELECT name, type, command FROM session_mcps WHERE session_id='$SID' AND name='agent-browser'"
```

**期望**：
- 接口返回 `id=smc_xxx, name=agent-browser, type=local, command=["agent-browser","mcp","--tools","core"], enabled=true`
- PG 行：`agent-browser|local|["agent-browser","mcp","--tools","core"]`

> **注册 ≠ 启动**：接口只写 PG，不启动进程。真正启动是 lazy 的 —— AI 每轮 step 调用 `toolsForSession`（`session/tools.ts:413`）时按需 `connectSandboxLocal`（`mcp/index.ts:684`）在沙箱里拉起 stdio 进程并桥接，成功后缓存复用。

---

## 四、AI 调用 MCP 工具驱动浏览器

### T44.4 触发 AI 调用 agent_browser_*

```bash
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 agent-browser MCP 工具完成：1) agent_browser_open 打开 https://example.com 2) agent_browser_snapshot 获取页面快照 3) 告诉我页面标题和正文是什么。完成后用一句中文总结。\"}],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

# 轮询消息列表，等待 agent_browser_* 工具全部 completed
bun -e '
const SID = "'$SID'"
const BASE = "'$BASE'"
const start = Date.now()
let lastSeen = 0
let assistantDone = false
while (Date.now() - start < 150000) {
  const msgs = await (await fetch(BASE + "/session/" + SID + "/message")).json()
  for (let i = lastSeen; i < msgs.length; i++) {
    const m = msgs[i]
    const role = m.role || m.info?.role || "?"
    for (const p of m.parts || []) {
      if (p.type === "tool" && p.tool?.startsWith("agent-browser_")) {
        const s = p.state || {}
        console.log(`  [${role}] ${p.tool} status=${s.status||"?"} input=${JSON.stringify(s.input||{}).slice(0,120)}`)
        if (s.output) console.log(`    output: ${JSON.stringify(s.output).slice(0,200)}`)
      } else if (p.type === "text" && p.text?.trim()) {
        console.log(`  [${role}] TEXT: ${p.text.slice(0,200)}`)
        // AI 给出最终回复（assistant text 且不是 user 的 prompt）才视为完成
        if (role === "assistant") assistantDone = true
      }
    }
  }
  lastSeen = Math.max(lastSeen, msgs.length)
  // 等到 AI 输出 assistant 文本才退，避免在首个工具 completed 时过早退出错过后续工具
  if (assistantDone) { console.log(`\n=== DONE ===`); break }
  await new Promise(r => setTimeout(r, 4000))
}
'

# PG 验证工具调用持久化
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool' LIKE 'agent-browser_%'"
```

**期望**（实际验证记录，2026-07-20，组合 3 环境）：
- `prompt_async` 返回 `HTTP 204`
- 多个 `agent-browser_*` 工具调用全部 `completed`。工具组合由 AI 自行决定，常见组合：
  - `agent-browser_agent_browser_open` input=`{"url":"https://example.com"}` → 输出含 `Example Domain`
  - `agent-browser_agent_browser_snapshot` → 输出含 `heading "Example Domain" [level=1, ref=e1]`
  - 文本/标题获取类工具任选其一或多选：`agent_browser_get_text` / `agent_browser_read` / `agent_browser_get_title` → 输出含 `This domain is for use in documentation examples` 或 `Example Domain`
- AI 文本回复用中文总结页面内容
- PG `part` 表存在上述工具调用记录，状态全部 `completed`

---

## 五、实战场景

> 假设已按 T44.1-T44.3 创建 session + 注册 MCP（变量 `$SID` 复用）。每个场景是一个独立 `prompt_async`，验证 AI 能用 `agent_browser_*` 工具完成典型 Web 自动化任务。
>
> 通用轮询脚本同 T44.4，下面每个用例只给出 prompt 与期望。

### T44.5 多元素批量提取：列表页数据

**Prompt**：
```text
用 agent-browser MCP 工具完成：
1) 打开 https://books.toscrape.com
2) 提取第 1 页所有书（20 本）的标题和价格
3) 以 Markdown 表格返回，列：标题、价格
```

**期望**：
- 工具调用含 `agent_browser_open` + `agent_browser_snapshot` 或 `agent_browser_eval`
- AI 返回 20 行表格，价格格式形如 `£12.34`
- PG `part` 表存在对应工具记录

---

### T44.6 表单填写与提交

**Prompt**：
```text
用 agent-browser MCP 工具完成：
1) 打开 https://httpbin.org/forms/post
2) 填写：custname=张三、custtel=13800000000、size=medium、topping=cheese、topping=mushroom、comments=测试订单
3) 提交表单
4) 把服务器返回的 JSON 原样告诉我
```

**期望**：
- 工具调用含 `agent_browser_open` + `agent_browser_snapshot` + 多次 `agent_browser_fill`/`agent_browser_click`
- 提交后 AI 返回的文本含 httpbin 回显的 JSON 字段：`custname`, `custtel`, `size`, `topping`
- PG `part` 表至少 5 个 `agent-browser_*` 工具记录

---

### T44.7 SPA 动态交互

**Prompt**：
```text
用 agent-browser MCP 工具完成：
1) 打开 https://todomvc.com/examples/react/dist/
2) 添加 3 个 todo：买牛奶、写代码、睡觉
3) 把"买牛奶"标记为完成
4) 删除"写代码"
5) 告诉我当前剩余的 todo 列表和状态
```

**期望**：
- 工具调用含 `agent_browser_open` + `agent_browser_snapshot` + 多次 `agent_browser_fill`（输入框）+ `agent_browser_press`（回车确认）+ `agent_browser_click`（checkbox / destroy 按钮）
- AI 返回剩余 todo：`睡觉`（active）+ `买牛奶`（completed）
- 验证 SPA 状态正确响应（不是页面刷新）

---

### T44.8 高级场景：JS eval 提取结构化数据

**Prompt**：
```text
用 agent-browser MCP 工具完成：
1) 打开 https://books.toscrape.com
2) 用 agent_browser_eval 在页面上下文执行 JS，提取所有书的 {title, price, availability} 三元组
3) 把 JSON 数组直接返回给我，不要表格化
```

**期望**：
- 工具调用含 `agent_browser_open` + `agent_browser_eval`（不是 snapshot）
- `agent_browser_eval` 的 input.code 含 `Array.from(...).map(...)` 之类的提取逻辑
- AI 返回 JSON 数组，至少 20 条，每条含 `title` / `price` / `availability` 三字段
- 验证 AI 知道何时该用 `eval` 而非多次 `get_text`（一次性提取效率更高）

---

### T44.9 异常处理：访问失败页面

**Prompt**：
```text
用 agent-browser MCP 工具打开 https://this-domain-does-not-exist-12345.com，告诉我页面状态和错误信息
```

**期望**：
- 工具调用含 `agent_browser_open`，状态可能为 `error` 或 `completed`（取决于 agent-browser 行为）
- AI 不应卡死，应明确告诉用户"页面无法访问"或类似错误信息
- 验证链路对网络异常的容错性

---

## 六、已知噪声

### N44.1 首次 MCP 调用延迟

**症状**：`prompt_async` 后第一次 `agent_browser_*` 调用比后续慢 5-10 秒。

**根因**：lazy 启动机制下，首次调用要 `connectSandboxLocal` 在沙箱里启动 `agent-browser mcp` 进程 + supergateway 桥接 + 工具发现，后续复用缓存。

**影响**：无。后续调用走缓存，正常速度。

### N44.2 agent-browser daemon 版本检测重启

**症状**：`agent_browser_open` 首次输出含 `⚠ Daemon version mismatch detected, restarting...`。

**根因**：沙箱里若 agent-browser daemon 版本与 CLI 不一致，首次调用时自动重启 daemon。

**影响**：无。重启后工具正常返回结果，title 字段始终包含在响应中。

---

## 验收汇总

| 用例 | 结果 | 验证详情 |
|------|------|---------|
| T44.1 创建 session | ✅ | `new_sid -kb` 返回 ses_xxx |
| T44.2 验证预装 | ✅ | agent-browser 0.31.1 + chromium 151 + 系统库就绪；smoke test 打开 example.com 返回 Example Domain |
| T44.3 注册 local MCP | ✅ | PG `agent-browser\|local\|["agent-browser","mcp","--tools","core"]` |
| T44.4 AI 调用浏览器（基础） | ✅ | 多个 `agent-browser_*` 工具 completed（open+snapshot），AI 中文总结页面 |
| T44.5 多元素批量提取 | ✅ | books.toscrape.com open + eval 提取，Markdown 表格 20 行（标题 + £价格） |
| T44.6 表单填写与提交 | ✅ | httpbin 表单 6 字段填写（含多选 topping），提交后回显完整 JSON（custname/custtel/size/topping/comments） |
| T44.7 SPA 动态交互 | ✅ | TodoMVC React 添加 3 todo + 标记完成 + 删除，返回剩余列表（买牛奶✅/睡觉⬜） |
| T44.8 JS eval 数据提取 | ✅ | books.toscrape.com 用 eval 提结构化 JSON，20 条 {title, price, availability} |
| T44.9 异常处理 | ✅ | 不存在域名 → agent_browser_open status=error，AI 明确报告 `net::ERR_NAME_NOT_RESOLVED` |

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| 沙箱预装 | agent-browser + chromium + 系统库开箱可用 | ✅ |
| 注册 | SaaS session local MCP CRUD + PG 持久化 | ✅ |
| AI 感知 | AI 主动选择 `agent_browser_*` 工具 | ✅ |
| 真实执行 | 工具实际驱动 chromium 打开 example.com | ✅ title=Example Domain |
| 反馈 | AI 综合工具输出做中文总结 | ✅ |

> **2026-08-02 补充**：环境为 `OPENCODE_EXPERIMENTAL_CODE_MODE=all`，agent-browser 工具经 code-mode `execute` 内嵌调用（metadata.toolCalls 记录 `agent-browser.agent_browser_*`，PG `part` 表持久化为 execute 记录，内嵌 toolCalls 全量覆盖 8 种工具）。T44.5-T44.9 均为实测通过（同一 session 串行 6 轮，MCP 连接缓存复用）。

---

## 测试命令汇总

```bash
# 环境（组合 3：本地 PG + 本地 OpenSandbox）
export BASE="http://localhost:14096"
export PG_URL="postgresql://local@127.0.0.1:15432/opencode"
export MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
export NO_PROXY=localhost,127.0.0.1
new_sid() {
  local sid
  sid=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  [ "${1:-}" = "-k" ] && curl -s -X POST "$BASE/session/$sid/keep-alive" \
    -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
  [ "${1:-}" = "-kb" ] && curl -s -X POST "$BASE/session/$sid/keep-alive" \
    -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' >/dev/null
  echo "$sid"
}
exec_sb() {
  curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
    -d "{\"command\":\"$1\"}" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('stdout') or '')+(d.get('stderr') or ''))"
}

# 1. 创建 session + 启沙箱
SID=$(new_sid -kb)

# 2. 验证沙箱预装（应全部 OK；若缺失见前置条件 §1 的补救命令）
exec_sb 'agent-browser --version'
exec_sb 'which chromium'

# 3. 注册 local MCP
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"agent-browser","type":"local","command":["agent-browser","mcp","--tools","core"]}'

# 4. AI 调用浏览器工具
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 agent-browser MCP 工具打开 https://example.com，snapshot 后告诉我页面标题和正文\"}],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

# 5. PG 验证工具调用
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool' LIKE 'agent-browser_%'"
```
