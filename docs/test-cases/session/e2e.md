# 综合 E2E 场景

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

> **前置条件**（参考 `local-test-env.md`）：
> 1. Sandbox TCP 转发已启动（`lsof -i :30040 | grep LISTEN`）
> 2. 权限已配置（`PATCH /global/config {"permission":{"bash":"allow","edit":"allow","write":"allow",...}}`）

## 十、综合 E2E 场景

> 运行前先全局加载环境：`source test-env.sh [1|2|3] && source test-lib.sh`（见测试环境说明）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。AI 请求使用 `stream_prompt`（`POST /session/:id/prompt_stream`），正文增量和工具状态会实时输出到前台。

### T10.1 完整开发流程：创建项目 → 验证结构 → 运行

> 验证：创建 Python 项目骨架、检查文件结构、运行代码输出 `hello`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# Step 1: 创建项目骨架（4 个文件）
stream_prompt "$SID" 'Create a Python project at /workspace/myapp with:
1. myapp/__init__.py (empty)
2. myapp/main.py with def main(): print("hello")
3. tests/__init__.py (empty)
4. tests/test_main.py that imports myapp.main
Use the write tool for each file.' 120
```

```bash
# Step 2: 检查文件结构（使用 exec API 直连沙箱）
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"find /workspace/myapp -type f -name \"*.py\" | sort"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);print('exit:',d.get('exitCode'));print(d.get('stdout',''))"
# 期望输出 4 个 .py 文件路径
```

```bash
# Step 3: 运行代码验证
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/myapp && python3 -c \"from myapp.main import main; main()\""}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);print('exit:',d.get('exitCode'));print('stdout:',d.get('stdout','').strip())"
# 期望输出: hello
```
**期望**：4 个 .py 文件创建成功，`python3` 运行输出 `hello`

> **路径说明（实测）**：prompt 指定项目根为 `/workspace/myapp`，AI 会在此目录下创建 `myapp/` 与 `tests/` 子包（标准 Python 项目结构，即 `/workspace/myapp/myapp/__init__.py`、`/workspace/myapp/tests/__init__.py` 等）。因此 `find` 应在 `/workspace/myapp` 下查找，运行需 `cd /workspace/myapp`（使 `myapp` 包可被 import）。原文档命令误用 `/workspace/tests`（与项目根平级）和 `cd /workspace`，与 prompt 语义不符，已修正。

### T10.2 完整开发流程：代码修改 + diff 验证

> 验证：修改已有文件后通过 diff 确认变更，再运行验证

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# Step 1: 创建初始文件
stream_prompt "$SID" 'Use the write tool to create /workspace/calc.py with:
def add(a, b): return a + b
def multiply(a, b): return a * b' 120
```

```bash
# Step 2: 修改代码（添加 subtract 函数）
stream_prompt "$SID" 'Use the edit tool to add a subtract function to /workspace/calc.py: def subtract(a, b): return a - b' 120
```

```bash
# Step 3: 验证修改结果
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && python3 -c \"from calc import add, subtract; print(add(2,3)); print(subtract(5,2))\""}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin, strict=False);print('exit:',d.get('exitCode'));print('stdout:',d.get('stdout','').strip())"
# 期望输出: 5\n3
```
**期望**：edit 工具成功修改文件，`subtract(5,2)` 输出 `3`

### T10.3 SSE 监听完整开发流程

> 验证：通过 SSE 事件流观察完整的创建→修改→执行流程

```bash
timeout 120 bun -e "
const BASE = 'http://localhost:14096'
const sess = await (await fetch(BASE + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch(BASE + '/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id
console.log('session:', SID)

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('⏭️ timeout'); process.exit(0) }, 110000)

const r = await fetch(BASE + '/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
const eventLog = []

setTimeout(async () => {
  // 用流式接口触发回合；独立 /event 连接实时输出会话事件
  const prompt = await fetch(BASE + '/session/' + SID + '/prompt_stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'Use the write tool to create /workspace/hello.py with: print(\"hello from SSE test\")' }], model: { providerID: 'Yd-DeepSeek', modelID: 'deepseek-v4-flash' } })
  })
  if (!prompt.ok) console.error('prompt_stream failed:', prompt.status, await prompt.text())
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      eventLog.push({ type: p.type, time: new Date().toISOString().slice(11,19) })
      console.log(new Date().toISOString().slice(11,19), p.type)

      if (p.type === 'permission.asked') {
        await fetch(BASE + '/session/' + SID + '/permissions/' + p.properties.id, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: 'always' })
        })
      }

      if (p.type === 'file.edited') {
        console.log('📄 file.edited:', p.properties.file)
      }

      if (p.type === 'session.idle') {
        clearTimeout(timer)
        const types = [...new Set(eventLog.map(e => e.type))].sort()
        const timeline = eventLog.map(e => e.time + ' ' + e.type).join('\\n')
        console.log('--- Event Timeline ---')
        console.log(timeline)
        console.log('--- Summary ---')
        console.log('total events:', eventLog.length)
        console.log('unique types:', types.length)
        console.log('types:', types.join(', '))
        const hasFileEdit = types.includes('file.edited')
        const hasMsgUpdate = types.some(t => t.startsWith('message.'))
        const hasSessionIdle = types.includes('session.idle')
        console.log(hasFileEdit && hasMsgUpdate && hasSessionIdle ? '✅ E2E SSE flow verified' : '❌ missing events')
        await reader.cancel()
        process.exit(0)
      }
    }
  } catch(e) { if (!ctrl.signal.aborted) console.error(e); break }
}
"
```
**期望**：SSE 事件时间线包含 `server.connected` → `message.*` → `file.edited` → `session.idle` 完整流程

### T10.4 多轮对话上下文保持

> 验证：多轮对话中 LLM 能记住前几轮的上下文

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# Round 1: 设定上下文
echo "=== Round 1 ==="
stream_prompt "$SID" 'Remember this secret number: 42. Just reply OK.' 60

# Round 2: 验证记忆
echo "=== Round 2 ==="
stream_prompt "$SID" 'What was the secret number I told you?' 60
```
**期望**：Round 2 回答包含 `42`

---

## 测试结果

| 用例 | 结果 | 备注 |
|------|------|------|
| T10.1 | ✅ | 4 个 .py 文件创建成功，`python3 -c "from myapp.main import main; main()"` 输出 hello |
| T10.2 | ✅ | edit 工具添加 subtract 函数，`subtract(5,2)` 输出 3 |
| T10.3 | ✅ | SSE 监听完整事件流，文件内容验证通过 |
| T10.4 | ✅ | Round 1 设定 42，Round 2 正确回忆 42 |

## 2026-09-29 V2 实测记录

环境：SaaS `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG + 本地 OpenSandbox、`Yd-DeepSeek/deepseek-v4-flash`。

**执行方式**：直接跑现成的 V2 脚本 `docs/test-cases/scripts/session-e2e-stream-v2.mjs`（235 行，T10.1–T10.4 均带 `assert` 硬断言）：

```bash
BASE=http://localhost:14096 \
OPENCODE_PASSWORD=... \
bun docs/test-cases/scripts/session-e2e-stream-v2.mjs
```

> 本文档正文的 bash 用例仍是 V1 写法（`POST /session`、`/session/:id/exec`、`/event`、`prompt_stream` 的 V1 路径），**V2 下不可直接执行**。以脚本为准。

**结果：T10.1–T10.4 全部通过，连续两轮可复现。**

| 用例 | SSE 事件数 | 断言验证 |
|---|---|---|
| T10.1 | 103 | 4 个 .py 文件（`find … \| wc -l` = 4）；`python3 -c 'from myapp.main import main; main()'` 输出 `hello` |
| T10.2 | 26 + 24 | `assertToolSucceeded(events, "edit")` 通过；`add(2,3),subtract(5,2)` 输出 `5,3`；`git diff` 含 `subtract` |
| T10.3 | 25 | 收到 25 个流式事件；`cat /workspace/hello.py` 含 `hello from SSE test` |
| T10.4 | 15 + 18 | Round 2 终态回复匹配 `\b42\b` |

### 独立证据（不依赖脚本自述）

用 session-scoped fs 接口直接读 AI 产出的文件：

```
T10.1  fs/list /workspace/myapp/myapp → [__init__.py(file), __pycache__(dir), main.py(file)]
       fs/list /workspace/myapp/tests  → [__init__.py(file), test_main.py(file)]
       fs/read myapp/myapp/main.py     → def main():\n    print("hello")

T10.2  fs/read calc.py → def add(a, b): return a + b
                          def multiply(a, b): return a * b
                          def subtract(a, b): return a - b     ← 由 edit 工具添加
```

`subtract` 只可能由第二轮的 `edit` 调用产生 —— 该文件的存在本身即证明两轮工具调用都真实执行了。

PG 侧工具记录（`session_message.data.content[]` 展开）同样显示 `write(completed)` / `edit(completed)` / `shell(completed)`，与断言一致。

### V1 → V2 映射

| V1 | V2 |
|---|---|
| `POST /session` | `POST /api/session`（需 `location.directory`） |
| `POST /session/:id/message`（同步） | `POST /api/session/:id/prompt` + `wait` |
| `POST /session/:id/exec`（同步 stdout） | `POST /api/session/:id/shell`（204 异步），终态从 PG `type='shell'` + `status='exited'` 读 |
| `POST /session/:id/prompt_stream` | `POST /api/session/:id/prompt_stream`（加 `/api` 前缀） |
| `GET /event` | `GET /api/session/:id/log`（SSE 事件契约不同） |
| PG 表 `session` / `message` | `session_v2` / `session_message` |

### 清理

本轮 8 个会话（两轮 × 4）及其 sandbox 已删除。清理与验证的写法见下方「清理陷阱」。

---

## 2026-10-25 阿里云后端实测记录

环境：镜像 `opencode-saas:aliyun-proxy-fixed-20261025`（当前工作区，含 proxy 修复）、独立 PG `opencode-v2-e2e-test`、阿里云杭州 + 二代模板 `base-5wa5`（自带 Python 3.13.13）、`deepseek/deepseek-flash`，`OPENCODE_CODEMODE_EXECUTOR=sandbox`，root 会话自动保活开启。执行器 `session-e2e-stream-v2.mjs` 原样运行（仅将 MODEL 常量改为 `MODEL_JSON` 环境变量可覆盖，默认值不变）。**T10.1–T10.4 全部通过（硬断言）**：

| 用例 | SSE 事件数 | 断言验证 |
|---|---|---|
| T10.1 | 58 | 4 个 .py 文件（`find \| wc -l` = 4）；`python3 -c 'from myapp.main import main; main()'` 输出 `hello` |
| T10.2 | 26 + 22 | `edit` SSE 成功事件；`add(2,3),subtract(5,2)` 输出 `5,3`；diff 含 `subtract` |
| T10.3 | 32 | 流式事件实时渲染；`cat /workspace/hello.py` 含 `hello from SSE test` |
| T10.4 | 14 + 13 | Round 2 终态回复 `42` |

独立证据（session fs 接口直读，不依赖脚本自述）：`myapp/myapp/main.py` = `def main(): print("hello")`；`myapp/tests/test_main.py` 导入 `myapp.main`；`calc.py` 含 `subtract`（只可能由第二轮 edit 产生）；`hello.py` 内容正确。

PG 侧工具记录（`session_message` 展开）：`write×6`、`edit×1`、`read×1`、`shell×1`，全部 `completed`；4 个会话 `directory=/workspace`、model 正确。

清理（按本文「清理陷阱」写法逐行删除并打印状态码）：4 个会话全部 204，`session_v2` 复查 count=0，6 个 sandbox 行全部 `destroyed`，云端按 metadata 只读核验 0 个残留实例。

环境陷阱（复跑前排除）：容器**不能**设置 `OPENCODE_SESSION_AUTO_KEEPALIVE=0`——轮次结束会回收沙箱，轮后 shell API 触发代次更替，报 `Sandbox identity is no longer current`（首跑实测命中，与 Vercel 生命周期复测记录同源）。

## ⚠️ 清理陷阱：zsh 下 `for s in $SIDS` 只迭代一次

测试后清理会话时踩到的坑，**会导致「看起来清理干净、实际一个没删」**。

```bash
SIDS=$(psql ... -t -A -c "SELECT id FROM session_v2 WHERE ...")
for s in $SIDS; do curl -X DELETE ".../session/$s"; done     # ← zsh 下只跑 1 次
```

zsh 默认不对未加引号的变量做分词（`SH_WORD_SPLIT` 关闭），`$SIDS` 被当成**一个含换行的 word**，URL 变成 `.../session/id1\nid2\nid3` → 404，再加上 `-o /dev/null` 把失败吞掉。

**更隐蔽的是验证方式**。如果用同样的拼接去验证：

```bash
psql -c "... WHERE id IN ('$(echo "$SIDS" | tr ' ' ',')')"
```

会生成 `IN ('id1,id2,id3')` —— 这是个**字符串字面量**，不是 3 个 id，结构上不可能匹配任何行，于是永远返回 `0`。看起来「已清理干净」，实际什么都没删。

> 本轮实测：首次清理报告「已清理 23 个」，紧接着复查 `残留=23` —— 那个 `0`/`23` 的矛盾正是本坑暴露的。修正后重新清理，58 个残留会话全部删除（返回 204），复查 `count=0`。

**正确写法**：

```bash
# 清理：逐行读，不用 for s in $SIDS
psql ... -t -A -c "SELECT id FROM session_v2 WHERE <条件>" \
| while IFS= read -r s; do
    [ -z "$s" ] && continue
    curl -sS ... -X DELETE "$BASE/api/session/$s" -o /dev/null -w '%{http_code}\n'
  done

# 验证：直接 count，绝不拼 IN 列表
psql ... -t -A -c "SELECT count(*) FROM session_v2 WHERE <同样的条件>"
```

另外，删除接口会返回 HTTP 204，**逐个打印状态码**才能确认每个都成功；全部静默 `-o /dev/null` 会把失败一起吞掉。

> 若必须用数组，写 `"${SIDS[@]}"`（bash/zsh 通用）而非 `$SIDS`。

> **复测记录（2026-09-16，镜像 `person-model-connect`（feat/opencode-1.18.31 工作区：个人模型隔离 + 公共优先 + provider 脱敏 + autokeepalive），本地 PG + 远端 K8s 沙箱，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）**：T10.1–T10.4 全部通过。**本轮 AI 消息统一改走流式接口**（`POST /session/:id/prompt_stream`，即 `test-lib.sh` 的 `stream_prompt`，实时渲染正文增量 + `[tool]` 状态流转），断言仍以 exec API / 消息终态为准：
>
> | 用例 | 结果 | 备注 |
> |---|---|---|
> | T10.1 | ✅ | 流式观察 write×4 → exec 验证 4 个 .py → 运行输出 `hello` |
> | T10.2 | ✅ | 流式 write → 流式 edit（subtract）→ exec 输出 `5`/`3` |
> | T10.3 | ✅ | `/event` SSE 监听 59 个事件、11 种类型，含 `file.edited` → `session.idle` 完整时间线（该用例本体即流式，保持原同步触发） |
> | T10.4 | ✅ | 两轮流式对话，Round 2 终态回复 `42` |
>
> 附注：autokeepalive 下 session 创建即启动沙箱，T10.1/T10.2 的首次工具调用无沙箱冷启动等待。

> **本地沙箱复测记录（2026-09-24，V2 SaaS + 本地 PG + 本地 OpenSandbox Docker runtime，`linux/arm64`，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）**：通过 `docs/test-cases/scripts/session-e2e-stream-v2.mjs` 执行 T10.1–T10.4。`prompt_stream` SSE 事件逐条实时输出；T10.1 收到 72 个事件、T10.2 write/edit 分别收到 28/25 个事件、T10.3 收到 26 个事件、T10.4 两轮分别收到 15/15 个事件。文件结构和 Python 输出、edit 工具成功事件、diff/计算结果 `5,3`、Round 2 回复 `42` 均验证通过，4/4 用例通过。
>
> **发现并修复**：T10.2 首轮发现 V2 `edit` 未走 `SandboxProvider`，在本地服务容器文件系统查找远端沙箱文件并报 `File not found`。现已增加沙箱文件读取、精确替换、权限检查和回写；单测 17/17 通过，Core 类型检查通过。`test-env.sh` 默认仍指向旧端口；本地 V2 测试服务使用 `BASE=http://127.0.0.1:14105`。
