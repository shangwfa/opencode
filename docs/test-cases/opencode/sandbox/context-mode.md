# context-mode SaaS Plugin 集成测试

> 验证 [context-mode](https://github.com/mksglu/context-mode) 作为 **SaaS session plugin** 接入：沙箱预装 → 通过 `plugins/create` API 注册（source: "code" 包装注入 `CONTEXT_MODE_PLATFORM=opencode`）→ 自动注册 hooks（`tool.execute.before/after` + `session.compacting`）→ AI 获得 11 个 `ctx_*` 工具 + 自动路由。
>
> 这是比 local MCP 更强的接入方式：plugin 有 **hooks 能力**（自动拦截工具输出沙箱化），MCP 只有工具能力。

## 跟 local MCP 模式的区别

| 能力 | session plugin（本文档） | local MCP |
|------|---|---|
| 工具（ctx_execute/search 等） | ✅ | ✅ |
| **自动路由**（拦截 Read/Bash/WebFetch 输出） | ✅ hooks 自动 | ❌ 无 hooks |
| **Session 连续性**（压缩后 FTS5 搜索恢复） | ✅ hooks 自动 | ❌ 无 hooks |
| **系统提示注入**（路由规则自动注入 system prompt） | ✅ `chat.system.transform` | ❌ |
| 工具调用开销 | 无（in-process） | 有（stdio 子进程） |

## 涉及的 API

| 步骤 | API | 用途 |
|------|------|------|
| T-CM.1 | `POST /session` + `POST /session/:id/keep-alive` | 创建 session + 启沙箱 |
| T-CM.2 | `POST /session/:id/exec` | 验证 context-mode 预装 |
| T-CM.3 | `POST /session/:id/plugins/create` | **核心 API**：注册 context-mode 为 session plugin |
| T-CM.4 | `GET /session/:id/plugins` | 验证 plugin 入库 |
| T-CM.5 | `POST /session/:id/prompt_async` | AI 使用 ctx_* 工具 + 验证自动路由 |
| T-CM.6 | PG 验证 | `session_plugin` 表持久化 |

## 公共配置

```bash
BASE="http://localhost:14096"
PG_URL="postgresql://local@127.0.0.1:15432/opencode"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

---

### T-CM.1 创建 Session + 启动沙箱

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"context-mode-e2e"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --noproxy '*' -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}'
# 期望: {"keepAlive":true,"sandboxId":"xxx"}
```

---

### T-CM.2 验证 context-mode 预装

> **沙箱镜像已预装 context-mode**（见 `packages/opencode/docker/Dockerfile` 步骤 `8c`，`npm install -g context-mode`）。

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"which context-mode && context-mode --version 2>&1 | head -1"}'
# 期望: /root/.local/share/mise/shims/context-mode
```

---

### T-CM.3 注册 context-mode 为 session plugin（核心）

> **用 `source: "code"` 而非 `source: "npm"`**：包装代码在加载 context-mode 前注入 `CONTEXT_MODE_PLATFORM=opencode`，
> 强制使用 OpenCode adapter（避免沙箱里 `~/.claude/` 目录残留导致误判为 Claude Code）。
>
> 包装代码做两件事：
> 1. `process.env.CONTEXT_MODE_PLATFORM = 'opencode'`（平台覆盖）
> 2. `export default plugin.server`（context-mode 的 default 是 object，SaaS `source: "code"` 要求 default 是 function）

```bash
# 包装代码（TS），设环境变量 + 导出 context-mode 的 server plugin
WRAPPER_CODE='process.env.CONTEXT_MODE_PLATFORM = "opencode"
const { default: plugin } = await import("context-mode")
export default plugin.server'

# 通过 plugins/create 注册（source: "code"）
python3 <<PYEOF
import json, urllib.request
body = json.dumps({
    "name": "context-mode",
    "source": "code",
    "code": '''$WRAPPER_CODE''',
    "enabled": True,
}).encode()
req = urllib.request.Request("$BASE/session/$SID/plugins/create",
                             data=body, headers={"Content-Type":"application/json"})
print(urllib.request.urlopen(req).read().decode()[:300])
PYEOF
```

期望响应：

```json
{
  "id": "sp_xxx",
  "session_id": "ses_xxx",
  "name": "context-mode",
  "source": "code",
  "enabled": true
}
```

> **为什么不用 `source: "npm"`**：
> - `source: "npm"` 无法注入环境变量（`PluginLoader.resolve` 不接受 env 参数）
> - 沙箱里有 `~/.claude/` 残留，context-mode 误判为 Claude Code（存储路径 / hook 配置错误）
> - `source: "code"` 包装在 import 前设 env，精确覆盖平台检测

---

### T-CM.4 验证 plugin 列表 + PG 持久化

```bash
# API 验证
curl -s --noproxy '*' "$BASE/session/$SID/plugins" | python3 -m json.tool

# PG 验证
psql "$PG_URL" -Atc "SELECT name, source, spec, enabled FROM session_plugin WHERE session_id='$SID'"
# 期望: context-mode|npm|context-mode|t
```

---

### T-CM.5 AI 使用 ctx_* 工具 + 验证自动路由

> 发一个需要大量代码分析的 prompt，验证 AI 用 `ctx_execute`（沙箱化执行）而不是直接调 47 次 `read`。

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\": \"text\", \"text\": \"统计 /workspace 下所有 .ts 文件的行数，给我一个汇总。文件数量可能很多，请用高效的方式处理。\"}],
    \"model\": $MODEL
  }"

# 轮询消息
bun -e '
const SID = "'$SID'"
const BASE = "http://localhost:14096"
const START = '$BEFORE'
const start = Date.now()
let assistantDone = false
while (Date.now() - start < 180000) {
  const msgs = await (await fetch(BASE + "/session/" + SID + "/message")).json()
  for (let i = START; i < msgs.length; i++) {
    for (const p of msgs[i].parts || []) {
      if (p.type === "tool") {
        const s = p.state || {}
        const isCtx = p.tool?.startsWith("context-mode_") || p.tool?.includes("ctx_")
        console.log(`[${i}] ${p.tool} ${s.status||"?"}${isCtx ? " ★" : ""}`)
      } else if (p.type === "text" && p.text?.trim() && i > START) {
        console.log(`[${i}] TEXT: ${p.text.slice(0, 300)}`)
        if (msgs[i].role === "assistant") assistantDone = true
      }
    }
  }
  if (assistantDone) break
  await new Promise(r => setTimeout(r, 5000))
}
'
```

**期望**：
- AI 优先使用 `ctx_execute` 或 `ctx_batch_execute`（沙箱化执行，只返回结果不返回原始输出）
- 如果 AI 调了 `bash` 或 `read`，hooks 应自动拦截并沙箱化（输出被替换为摘要）
- 最终回答含统计结果，但上下文消耗极低

---

### T-CM.6 上下文优化效果验证

```bash
# 在沙箱里跑 ctx stats（如果 context-mode 注册了 ctx_stats 工具）
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"context-mode stats 2>&1 | head -20"}'

# 或让 AI 主动调用
curl -s --noproxy '*' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 ctx_stats 工具告诉我本 session 的上下文节省情况\"}],\"model\":$MODEL}"
```

---

## 已知限制

### ~~better-sqlite3 native module（FTS5 存储）~~ ✅ 已解决

**原问题**：npm 11+ 的 `allow-scripts` 机制默认阻止 install scripts，导致 `better-sqlite3` 的 `prebuild-install`（native module 下载）没执行。

**解决方案**：Dockerfile 8c 步骤用 `npm install -g context-mode --allow-scripts`，`--allow-scripts` flag 允许 prebuild-install 下载 arm64 预编译 `.node` 文件。

**验证**（构建后确认）：
```bash
docker run --rm --entrypoint /bin/bash opencode-opensandbox:local -lc '
  cd $(npm root -g)/context-mode && node -e "
    const Database = require(\"better-sqlite3\");
    const db = new Database(\":memory:\");
    db.exec(\"CREATE VIRTUAL TABLE search USING fts5(content)\");
    console.log(\"FTS5 OK\");
  "
'
# 期望: FTS5 OK
```

### ~~平台检测~~ ✅ 项目级解决

**原问题**：沙箱里有 `~/.claude/` 目录残留，context-mode 误判为 Claude Code。

**解决方案**（不改 Dockerfile，纯项目级）：T-CM.3 用 `source: "code"` 包装代码，在 import context-mode 前注入 `process.env.CONTEXT_MODE_PLATFORM = "opencode"`。包装代码 3 行：
```ts
process.env.CONTEXT_MODE_PLATFORM = "opencode"
const { default: plugin } = await import("context-mode")
export default plugin.server
```

> **为什么不用 Dockerfile `ENV`**：Dockerfile 只做依赖安装，平台配置属于业务逻辑。`source: "code"` 方式灵活——不同 session 可以用不同平台配置。

---

## 验收对照

| 验证项 | API | 结果 |
|--------|------|------|
| Session 创建 | `POST /session` | ⬜ |
| 沙箱启动 | `POST /session/:id/keep-alive` | ⬜ |
| context-mode 预装验证 | `POST /session/:id/exec` | ⬜ |
| **Plugin 注册** | **`POST /session/:id/plugins/create`** | ⬜ |
| Plugin PG 持久化 | `psql` | ⬜ |
| AI 使用 ctx_* 工具 | `POST /session/:id/prompt_async` | ⬜ |
| 自动路由（hooks 生效） | 轮询 message | ⬜ |
| 上下文优化效果 | `ctx_stats` / `context-mode stats` | ⬜ |

> **关键验证**：T-CM.3 的 `plugins/create`（source: "npm"）让 context-mode 以 **in-process plugin** 方式运行，获得完整的 hooks 能力（自动路由 + session 连续性），效果跟本地 opencode plugin 一致。
