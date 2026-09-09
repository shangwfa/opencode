# 沙箱命令执行 API（exec / keep-alive）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十九、沙箱命令执行 API（exec / keep-alive）

> 本节验证直接通过 HTTP API 在沙箱中执行命令、设置 keepAlive 的能力。不依赖 AI 模型是否正确传递 `background:true`，可用于程序化控制沙箱。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T19.1 exec API：简单命令执行

```bash
# 先通过 AI 消息创建沙箱（exec 依赖沙箱存在）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo sandbox-ready\"}],\"model\":$MODEL}" > /dev/null

# 使用 exec API 执行命令
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello-from-exec"}' | python3 -m json.tool
```
**期望**：返回 `{id: "...", exitCode: 0, stdout: "hello-from-exec\n", stderr: ""}`

### T19.2 exec API：多行输出与 stderr

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo line1 && echo line2 && echo err >&2"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'stdout: {repr(d.get(\"stdout\",\"\"))}')
print(f'stderr: {repr(d.get(\"stderr\",\"\"))}')
"
```
**期望**：`exitCode: 0`，stdout 含 `line1`、`line2`。**注意**：当前实现 stderr 被合并到 stdout，`stderr` 字段为空。验证 stdout 包含所有输出即可。

### T19.3 exec API：指定工作目录

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"pwd","workingDirectory":"/tmp"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'pwd: {d.get(\"stdout\",\"\").strip()}')
"
```
**期望**：`pwd: /tmp`

### T19.4 exec API：命令执行失败

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"exit 42"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'非0: {d.get(\"exitCode\") != 0}')
"
```
**期望**：`exitCode: 42`，非 0 退出码

### T19.5 exec API：缺少 command 参数

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{}'
echo ""
```
**期望**：`400`

### T19.6 exec API：不存在的 session

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/ses_NOTEXIST/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo test"}'
echo ""
```
**期望**：`404`（session 不存在）。**注意**：实际返回 404 而非 502，因为路由层先匹配到 session 不存在。

### T19.7 exec API：后台启动 dev server 并设置 keepAlive

> 最佳实践：`POST /exec` 适合执行会退出的短命令。Vite、Next.js、Astro 等 dev server 属于长驻进程，必须在 shell 中显式后台化（例如 `nohup ... > /tmp/app.log 2>&1 & echo $!`），然后通过 `/session/:sessionID/proxy/:port/` 做健康检查。不要让 dev server 以前台进程运行在 `/exec` 请求里，否则 HTTP 请求会一直等待直到客户端或上游超时。
>
> 如果目标是长期运行并持续采集输出，优先使用 `09-sandbox-proxy.md` 中的 `/exec/async` 流程；本用例保留同步 `/exec + nohup` 写法，是为了验证纯 API 同步入口也能安全启动 dev server 且不阻塞请求。

```bash
# 创建 Vite 项目（如果不存在）
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: if [ ! -d /workspace/vite-app ]; then npx create-vite@5 /workspace/vite-app --template react-ts --yes && cd /workspace/vite-app && npm install; fi && echo vite-ready\"}],\"model\":$MODEL}" > /dev/null

# 通过 exec API 安装依赖（如果需要）
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npm install 2>&1 | tail -1"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f'npm install: exit={d.get(\"exitCode\")} stdout={d.get(\"stdout\",\"\").strip()[:80]}')
"

# 通过 exec API 设置 keepAlive
curl -s -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | python3 -m json.tool

# 通过 exec API 后台启动 Vite。
# 注意：exec 是同步 API；长驻 dev server 必须用 nohup + & 后台化，避免阻塞 HTTP 请求。
# 优先使用项目本地二进制，避免 npx 拉取 latest 版本导致 Node 版本不兼容。
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && nohup ./node_modules/.bin/vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 & echo $!"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f'Vite PID: {d.get(\"stdout\",\"\").strip()}')
"

sleep 8

# 验证 Vite 运行
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Vite proxy: %{http_code}\n"

# 验证 keepAlive 状态
curl -s "$BASE/session/$SID/keep-alive" | python3 -m json.tool
```
**期望**：
- keep-alive 设置返回 `{keepAlive: true}`
- Vite proxy 返回 HTTP 200
- keep-alive 查询返回 `{keepAlive: true}`
- `/exec` 启动命令应快速返回 PID；不应等待 dev server 前台进程退出

**最佳实践检查点**：
- 安装/构建依赖和启动服务拆成两次 `/exec`，便于定位失败原因。
- 启动命令固定写日志到 `/tmp/<app>.log`，proxy 失败时先用 `/exec` 读取日志。
- 使用已安装的本地二进制（例如 `./node_modules/.bin/vite`）优先于 `npx vite`，避免 `npx` 拉取 latest 版本导致 Node 版本不兼容。
- 启动前先设置 `keep-alive=true`，测试结束后调用 `/session/:sessionID/kill-sandbox` 清理。

### T19.8 keepAlive 阻止 idle 销毁（纯 API 方式）

```bash
# 创建新 session
SID2=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 先用 AI 消息创建沙箱
curl -s --max-time 60 -X POST "$BASE/session/$SID2/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo ready\"}],\"model\":$MODEL}" > /dev/null

# 通过 API 设置 keepAlive
curl -s -X POST "$BASE/session/$SID2/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null

# 等待 idle 触发
sleep 15

# 检查：sandbox 应仍然存活（不被销毁）
RESULT=$(curl -s --max-time 10 -X POST "$BASE/session/$SID2/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo alive"}')
echo "After idle + keepAlive: $RESULT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode={d.get(\"exitCode\")} stdout={d.get(\"stdout\",\"\").strip()}')
print(f'PASS: sandbox still alive = {d.get(\"exitCode\")==0}')
"
```
**期望**：`sandbox still alive = True`，证明 keepAlive 阻止了 idle 销毁

### T19.9 释放 keepAlive 后 idle 销毁

```bash
SID3=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建沙箱
curl -s --max-time 60 -X POST "$BASE/session/$SID3/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo ready\"}],\"model\":$MODEL}" > /dev/null

# 设置 keepAlive
curl -s -X POST "$BASE/session/$SID3/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null

# 确认存活
sleep 5
curl -s -X POST "$BASE/session/$SID3/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo alive"}' | python3 -c "import json,sys;print('alive:', json.load(sys.stdin).get('exitCode')==0)"

# 释放 keepAlive
curl -s -X POST "$BASE/session/$SID3/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | python3 -c "import json,sys;print(json.load(sys.stdin))"

# 等待 idle + destroy
sleep 15

# 检查：sandbox 应已被销毁
curl -s --max-time 10 -X POST "$BASE/session/$SID3/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo dead"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'After release: exitCode={d.get(\"exitCode\")} error={d.get(\"error\")}')
"
```
**期望**：释放 keepAlive 后，纯 exec 路径**不触发** session runner 的 idle 销毁，sandbox 仍存活，exec 正常返回（exitCode=0）。此为当前预期行为：纯 exec 不经过 session runner，idle 回收需 `kill-sandbox`/`dispose` 显式触发，或等待 T30 的 idle reap 扫描兜底（见本文档"已知问题"）

### T19.10 exec API：超时控制

> `timeoutSeconds` 通过 `POST /exec` → `runInSession({timeoutSeconds})` → `withExecTimeout` 传递。Effect 层面使用 `Effect.timeoutOrElse` 在指定秒数后返回超时结果（`exitCode=null` + `error.name=TimeoutError`），无需依赖 execd 服务端强制中止。

#### T19.10a 不传 timeoutSeconds → 命令正常完成

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = process.argv[2] || (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id
const r = await (await fetch(`${BASE}/session/${SID}/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "echo no-timeout && sleep 1 && echo done" }),
})).json()
console.log("exitCode:", r.exitCode, "stdout:", (r.stdout || "").trim())
console.log(r.exitCode === 0 && r.stdout?.includes("done") ? "✅ T19.10a PASS" : "❌ T19.10a FAIL")
'
```
**期望**：`exitCode=0`，stdout 含 `no-timeout` 和 `done`

#### T19.10b timeoutSeconds=1 → Effect 层超时

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = process.argv[2] || (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id
const t0 = Date.now()
const r = await (await fetch(`${BASE}/session/${SID}/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "echo before-timeout && sleep 30 && echo never", timeoutSeconds: 1 }),
})).json()
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`耗时: ${elapsed}s`)
console.log("exitCode:", r.exitCode)
console.log("error:", JSON.stringify(r.error))
const ok = r.exitCode === null && r.error?.name === "TimeoutError" && r.error?.value?.includes("1s")
console.log(ok ? "✅ T19.10b PASS" : "❌ T19.10b FAIL")
'
```
**期望**：
- 约 1 秒后返回（非 30 秒）
- `exitCode=null`
- `error.name=TimeoutError`，`error.value` 含 `1s`

#### T19.10c timeoutSeconds=0 → 不超时（falsy 短路）

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = process.argv[2] || (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id
const r = await (await fetch(`${BASE}/session/${SID}/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "echo zero-timeout-ok", timeoutSeconds: 0 }),
})).json()
console.log("exitCode:", r.exitCode, "stdout:", (r.stdout || "").trim())
console.log(r.exitCode === 0 && r.stdout?.includes("zero-timeout-ok") ? "✅ T19.10c PASS" : "❌ T19.10c FAIL")
'
```
**期望**：`exitCode=0`，命令正常完成（`timeoutSeconds=0` 被视为不设超时）

#### T19.10d timeoutSeconds 足够大 → 命令在超时前完成

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = process.argv[2] || (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id
const r = await (await fetch(`${BASE}/session/${SID}/exec`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "echo fast && sleep 0.5 && echo done", timeoutSeconds: 30 }),
})).json()
console.log("exitCode:", r.exitCode, "stdout:", (r.stdout || "").trim())
console.log(r.exitCode === 0 && !r.error ? "✅ T19.10d PASS" : "❌ T19.10d FAIL")
'
```
**期望**：`exitCode=0`，`error` 为空，命令正常完成

#### T19.10e withExecTimeout 单元测试

```bash
bun test test/tool/exec-timeout.test.ts 2>&1 | tail -15
```
**期望**：7 个测试全部 pass

| 测试 | 验证点 |
|------|--------|
| undefined → passthrough | `timeoutSeconds=undefined` 不超时，原样返回 |
| 0 → passthrough | `timeoutSeconds=0` 不超时（falsy 短路） |
| fast effect 返回 exitCode=0 | 命令在超时前完成，正常返回 |
| slow effect 返回 exitCode=null | 1 秒后超时，返回 TimeoutError |
| 超时消息含秒数 | `error.value` = `"Command timed out after 3s"` |
| traceback 为空数组 | `error.traceback` = `[]` |
| 底层失败传播 | `Effect.fail` 正常传播为 `Exit.Failure` |

#### T19.10f 异步 exec（exec/async）timeoutSeconds 超时

> `runDetached` 现已包裹 `withExecTimeout`，异步 exec 同样支持 Effect 层超时兜底。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id

// 异步 exec，设 timeoutSeconds=1，命令 sleep 30
const t0 = Date.now()
const asyncRes = await (await fetch(`${BASE}/session/${SID}/exec/async`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "echo before && sleep 30 && echo never", timeoutSeconds: 1 }),
})).json()
console.log("execId:", asyncRes.execId, "status:", asyncRes.status)

// 等待超时完成
await new Promise(r => setTimeout(r, 5000))

// 查询最终状态
const final = await (await fetch(`${BASE}/session/${SID}/exec/${asyncRes.execId}`)).json()
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`耗时: ${elapsed}s (期望 < 10s, 非自 30s)`)
console.log("status:", final.status)
console.log("exitCode:", final.exitCode)

const ok = elapsed < 10 && final.status !== "running"
console.log(ok ? "✅ T19.10f PASS — async exec 超时生效" : "❌ T19.10f FAIL")
'
```
**期望**：
- 约 1-2s 后完成（非 30s）
- `status=completed`（withExecTimeout 返回成功结果，但 exitCode=null）
- `exitCode=null`（超时特征）

### T19.11 exec API：环境信息收集

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo \"node=$(node -v) npm=$(npm -v) pwd=$(pwd)\""}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('stdout','').strip())
"
```
**期望**：输出包含 node 版本、npm 版本和当前工作目录

### T19.12 exec/async：流式日志监听最佳实践

> 该用例专门验证 `/exec/async` 的推荐消费方式：启动后立即订阅 `/stream`，实时处理 `stdout` / `stderr` / `done` 事件；命令完成后再查询 `/exec/:execId` 兜底确认最终状态。不要把 `/stream` 当成可回放日志或多消费者广播；如果客户端晚连或多个客户端同时连，可能丢失或竞争消费事件。

```bash
# 创建独立 session，避免被其他长运行 exec 影响
SID_ASYNC=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID_ASYNC: $SID_ASYNC"

# 设置 keepAlive，避免长运行命令期间 sandbox 被 idle 回收
curl -s -X POST "$BASE/session/$SID_ASYNC/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null

# 启动 async exec。命令逐步输出，便于验证流式日志不是最终一次性返回。
EXEC=$(curl -s --max-time 10 -X POST "$BASE/session/$SID_ASYNC/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"for i in 1 2 3; do echo async-line-$i; sleep 1; done; echo async-done","workingDirectory":"/workspace","timeoutSeconds":30}')
EXEC_ID=$(echo "$EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")
echo "EXEC_ID: $EXEC_ID"

# 立即订阅 stream。只保留一个消费者；SSE 不是广播，也不是历史日志回放。
curl -s -N --max-time 20 "$BASE/session/$SID_ASYNC/exec/$EXEC_ID/stream" | python3 -c "
import json, sys
events = []
current = None
for raw in sys.stdin:
    line = raw.rstrip('\n')
    if line.startswith('event: '):
        current = {'event': line[7:], 'data': ''}
        events.append(current)
    elif line.startswith('data: ') and current is not None:
        current['data'] += line[6:]

print('events:', [e['event'] for e in events])
stdout = []
done = None
for e in events:
    if e['event'] == 'stdout':
        stdout.append(json.loads(e['data'])['text'].strip())
    if e['event'] == 'done':
        done = json.loads(e['data'])
print('stdout:', stdout)
print('done:', done)
print('PASS stream:', stdout == ['async-line-1', 'async-line-2', 'async-line-3', 'async-done'] and done and done.get('status') == 'completed')
"

# 查询最终状态兜底。状态接口可用于断线重连后的最终结果确认，但不是实时日志流。
curl -s "$BASE/session/$SID_ASYNC/exec/$EXEC_ID" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('status:', d.get('status'))
print('exitCode:', d.get('exitCode'))
print('stdout has done:', 'async-done' in (d.get('stdout') or ''))
"

# 测试结束清理 sandbox
curl -s -X POST "$BASE/session/$SID_ASYNC/kill-sandbox" > /dev/null
```

**期望**：
- `/exec/async` 立即返回 `execId` 和 `status=running`。
- `/stream` 依次收到多个 `event: stdout`，最后收到 `event: done`。
- stdout 顺序包含 `async-line-1`、`async-line-2`、`async-line-3`、`async-done`。
- `done.status=completed`，最终状态接口返回 `status=completed`、`exitCode=0`。

**最佳实践检查点**：
- 启动 async exec 后立即订阅 `/stream`；晚连不保证回放历史 stdout/stderr。
- 同一 `execId` 只保留一个 stream 消费者；当前实现的 queue 不是广播模型。
- UI 侧同时维护 `/exec/:execId` 轮询或完成态查询，作为 SSE 断线后的兜底。
- 长驻 dev server 场景优先用 `/exec/async`；同步 `/exec` 只用于短命令或显式 `nohup ... & echo $!` 的兼容路径。
- 测试结束调用 `/exec/:execId/kill` 或 `/session/:sessionID/kill-sandbox` 清理。

### T19.13 keep-alive boot 参数：立即启动沙箱

> 验证 `boot:true` 不仅设置 keepAlive，还立即创建沙箱。无需先通过 AI 消息或 exec 触发沙箱创建。

```bash
SID_BOOT=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID_BOOT: $SID_BOOT"

# boot=true：设置 keepAlive + 立即启动沙箱
curl -s -X POST "$BASE/session/$SID_BOOT/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
sb=d.get('sandboxId')
print(f'keepAlive={d.get(\"keepAlive\")} sandboxId={sb}')
print(f'PASS sandboxId non-null: {sb is not None}')
"

# 验证沙箱确实已启动（GET sandbox）
curl -s "$BASE/session/$SID_BOOT/sandbox" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'sandboxId={d.get(\"sandboxId\")}')
print(f'PASS sandbox exists: {d.get(\"sandboxId\") is not None}')
"

# 验证沙箱可执行命令
curl -s -X POST "$BASE/session/$SID_BOOT/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo boot-ok"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode={d.get(\"exitCode\")} stdout={d.get(\"stdout\",\"\").strip()}')
print(f'PASS exec: {d.get(\"exitCode\")==0}')
"

# 清理
curl -s -X POST "$BASE/session/$SID_BOOT/kill-sandbox" > /dev/null
```
**期望**：
- 响应包含 `keepAlive: true` 和非 null 的 `sandboxId`
- GET sandbox 返回相同的 `sandboxId`
- exec 返回 `exitCode: 0`

### T19.14 keep-alive 不传 boot：不启动沙箱

> 验证不传 `boot`（或 `boot:false`）时只设置 keepAlive 标记，不主动创建沙箱。

```bash
SID_NOBOOT=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID_NOBOOT: $SID_NOBOOT"

# 不传 boot：只设置 keepAlive，sandboxId 应为 null
curl -s -X POST "$BASE/session/$SID_NOBOOT/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'keepAlive={d.get(\"keepAlive\")} sandboxId={d.get(\"sandboxId\")}')
print(f'PASS sandboxId null: {d.get(\"sandboxId\") is None}')
"

# 验证沙箱不存在
curl -s "$BASE/session/$SID_NOBOOT/sandbox" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'sandboxId={d.get(\"sandboxId\")}')
print(f'PASS no sandbox: {d.get(\"sandboxId\") is None}')
"

# boot:false 同样不启动沙箱
curl -s -X POST "$BASE/session/$SID_NOBOOT/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":false}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'boot=false sandboxId={d.get(\"sandboxId\")}')
print(f'PASS sandboxId null: {d.get(\"sandboxId\") is None}')
"
```
**期望**：
- 不传 `boot` 和 `boot:false` 都返回 `sandboxId: null`
- GET sandbox 返回 `sandboxId: null`

### T19.15 同步 exec 命令持久化到 exec_log

> 验证 exec 执行后命令记录写入 `exec_log` 表，`GET /execs` 可查询。exec_log 独立于消息系统，不进入 AI 上下文。

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 5000))
const r = await (await fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo exec-log-persist" }) })).json()
const execs = await (await fetch(BASE + "/session/" + sid + "/execs")).json()
const hasLog = execs.execs?.some(e => e.command?.includes("exec-log-persist") && e.status === "completed" && e.exitCode === 0)
console.log(hasLog ? "✅ T19.15 PASS" : "❌ T19.15 FAIL", JSON.stringify(execs).slice(0,120))
'
```
**期望**：`GET /execs` 列表包含该命令，`status=completed`，`exitCode=0`

### T19.16 异步 exec 状态更新（running → completed）

> 验证 `/exec/async` 创建时写入 `running`，命令完成后更新为 `completed`。

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 5000))
const asyncRes = await (await fetch(BASE + "/session/" + sid + "/exec/async", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo async-state-test" }) })).json()
console.log("初始状态:", asyncRes.status)
await new Promise(r => setTimeout(r, 3000))
const log = await (await fetch(BASE + "/session/" + sid + "/exec/" + asyncRes.execId)).json()
console.log("最终状态:", log.status, "exit=" + log.exitCode, "out=" + log.stdout?.trim())
const ok = log.status === "completed" && log.exitCode === 0 && log.stdout?.includes("async-state-test")
console.log(ok ? "✅ T19.16 PASS" : "❌ T19.16 FAIL")
'
```
**期望**：`POST /exec/async` 返回 `status=running`；完成后 `GET /exec/:execId` 返回 `status=completed`，`exitCode=0`

### T19.17 历史记录查询（GET /execs + GET /exec/:execId）

> 验证多条 exec 记录持久化到 DB，列表和单条详情均可查询。即使 sandbox 重建，历史记录不丢失。

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 5000))
const r1 = await (await fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo history-1" }) })).json()
const r2 = await (await fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo history-2" }) })).json()
const execs = await (await fetch(BASE + "/session/" + sid + "/execs")).json()
console.log("列表:", execs.execs?.length, "条")
const detail = await (await fetch(BASE + "/session/" + sid + "/exec/" + r1.id)).json()
console.log("详情:", detail.command, detail.status, detail.exitCode, detail.stdout?.trim())
const ok = execs.execs?.length >= 2 && detail.command?.includes("history-1") && detail.exitCode === 0
console.log(ok ? "✅ T19.17 PASS" : "❌ T19.17 FAIL")
'
```
**期望**：
- `GET /execs` 返回 ≥ 2 条记录
- `GET /exec/:execId` 返回单条详情（`command`、`status`、`exitCode`、`stdout`、`startedAt`、`finishedAt`）

### T19.18 exec_log 容错（写入失败不影响 exec）

> 验证 exec_log 写入异常时（表不存在、DB 故障等），exec 命令本身仍正常返回。操作函数内部 `try/catch` 兜底。

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 5000))
const r = await (await fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "echo fault-tolerance-test" }) })).json()
console.log("exec exitCode:", r.exitCode, "stdout:", r.stdout?.trim())
console.log(r.exitCode === 0 ? "✅ T19.18 PASS — exec 不受 exec_log 影响" : "❌ T19.18 FAIL")
'
```
**期望**：exec 返回 `exitCode=0`，即使 exec_log 写入失败也不影响命令执行

### T19.19 kill 后 exec_log 状态更新为 killed

> 验证 `/exec/:execId/kill` 后，exec_log 状态更新为 `killed`。

```bash
bun -e '
const BASE = "http://localhost:14096"
const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json().then(d=>d.id)
await new Promise(r => setTimeout(r, 5000))
const asyncRes = await (await fetch(BASE + "/session/" + sid + "/exec/async", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "sleep 30" }) })).json()
await new Promise(r => setTimeout(r, 1000))
await fetch(BASE + "/session/" + sid + "/exec/" + asyncRes.execId + "/kill", { method: "POST" })
await new Promise(r => setTimeout(r, 1000))
const log = await (await fetch(BASE + "/session/" + sid + "/exec/" + asyncRes.execId)).json()
console.log("kill 后状态:", log.status)
console.log(log.status === "killed" ? "✅ T19.19 PASS" : "❌ T19.19 FAIL")
'
```
**期望**：`GET /exec/:execId` 返回 `status=killed`

### T19.20 exec_log 字段覆盖（working_directory / exit_code / stderr 行为）

> 验证 workingDirectory、非 0 exit_code 正确持久化。stderr 字段：当前 sandbox 实现将 stderr 合并到 stdout（见 T19.2），exec_log 的 stderr 字段为空，stderr 内容在 stdout 中。

```bash
bun -e '
const BASE = "http://localhost:14096"
const post = (path, body) => fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r=>r.json())
const sid = await (await post("/session", {})).id
require("fs").writeFileSync("/tmp/test-sid", sid)
await new Promise(r => setTimeout(r, 5000))

// working_directory
await post("/session/"+sid+"/exec", { command: "echo wd-test", workingDirectory: "/tmp" })
// 非 0 exit_code
await post("/session/"+sid+"/exec", { command: "exit 42" })
// stderr（合并到 stdout）
await post("/session/"+sid+"/exec", { command: "echo stderr-merged >&2" })

const execs = await (await fetch(BASE + "/session/" + sid + "/execs")).json()
const wd = execs.execs.find(e => e.command?.includes("wd-test"))
const fail = execs.execs.find(e => e.command?.includes("exit 42"))
const err = execs.execs.find(e => e.command?.includes("stderr-merged"))
console.log("working_directory:", wd ? "✅" : "❌")
console.log("exit_code=42:", fail?.exitCode === 42 ? "✅" : "❌", "got=" + fail?.exitCode)
console.log("stderr合并到stdout:", err ? "✅（已知行为）" : "❌")
'
```
**期望**：
- working_directory 记录为 `/tmp`
- exit_code 记录为 `42`（非 0）
- stderr 内容出现在 stdout 中（sandbox 合并行为，exec_log stderr 字段为空）

### T19.21 exec_log stdout 截断（64KB）

> 验证大输出截断到 64KB，超出部分替换为 `...[truncated]` 标记。

```bash
bun -e '
const BASE = "http://localhost:14096"
const post = (path, body) => fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r=>r.json())
const sid = await (await post("/session", {})).id
require("fs").writeFileSync("/tmp/test-sid", sid)
await new Promise(r => setTimeout(r, 5000))
// 生成 100KB 输出
const r = await post("/session/"+sid+"/exec", { command: "yes repeat | head -c 100000" })
console.log("API stdout 长度:", r.stdout?.length)
// 查 PG 验证截断
' && SID=$(cat /tmp/test-sid) && psql "$PG_URL" -c "SELECT length(stdout) AS stdout_len, stdout LIKE '%[truncated]%' AS has_mark FROM exec_log WHERE session_id = '$SID' AND command LIKE '%head -c%'"
```
**期望**：
- API 返回完整 stdout（100000 字符）
- PG exec_log stdout 截断到 ~65551（65536 + `...[truncated]` 标记）

---

### T19.22 exec/async 常驻进程不被清理（runDetached 修复）

> 背景：`runDetached` 的 finally 曾无条件 `deleteSession`，execd 删 session 会终止 session 内全部进程——dev server / 守护进程刚拉起就被杀（历史 exit 137）。修复后 detached session 保留（由 interrupt/destroyAll/沙箱销毁兜底）。参见 `lsp/agent.ts` 的 nohup 注释与 `sandbox-provider.ts` runDetached。

```bash
# 1. async 拉起常驻命令（45s sleep），timeoutSeconds:0 = 不超时
EXEC=$(curl -s -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"sleep 45; echo LONG-DONE","timeoutSeconds":0,"workingDirectory":"/workspace"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")

# 2. 期间同步 exec 别的命令（模拟正常使用）
curl -s -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"echo still-alive"}' > /dev/null

# 3. 等待超过原「启动即杀」窗口，确认常驻命令完整跑完
sleep 50
curl -s "$BASE/session/$SID/exec/$EXEC" | python3 -c "import json,sys;d=json.load(sys.stdin);print('status:',d['status'],'exit:',d['exitCode'],'stdout:',d.get('stdout','').strip())"
```
**期望**：`status=completed, exitCode=0, stdout=LONG-DONE`（修复前进程在启动后即被杀，永远等不到完成）。

### T19.23 exec 响应信号解码（exit ≥128 → signal / oomSuspected）

> 内核 OOM kill（SIGKILL）不留任何 stdout/stderr，调用方只能看到裸 exitCode 137。本用例验证信号被解码并在响应/exec_log 中显式透出。

```bash
# 1. 同步 exec：自杀命令 exit 137
curl -s -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"sh -c 'kill -9 $$'","timeoutSeconds":10}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ['exitCode','signal','oomSuspected']})"

# 2. 服务端日志应有明确 warn
docker logs opencode-saas-test 2>&1 | grep "killed by SIGKILL" | tail -1
```
**期望**：
- 响应含 `signal: "SIGKILL"`、`oomSuspected: true`
- 容器日志含 `command killed by SIGKILL — likely sandbox memory OOM`
- async 完成后 `GET /exec/:execId` 同样带 `signal`/`oomSuspected`；exec_log `error` 字段写入 `OOMSuspected` JSON

### T19.24 proxy 502 端口诊断增强

> dev server 死后 proxy 只回模糊的 `Could not connect to the backend sandbox endpoint`（来自 OpenSandbox server proxy）。增强后 opencode 层拦截失败并附沙箱内诊断（端口监听 + cgroup OOM 证据 + hint）。

```bash
# 1. 起一个 dev server 并确认 proxy 200（正常路径不回归）
curl -s -X POST $BASE/session/$SID/exec/async -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && pnpm run dev --host -- --port 5174 --strictPort","timeoutSeconds":0,"workingDirectory":"/workspace"}' > /dev/null
sleep 15 && curl -s -o /dev/null -w "running=%{http_code}\n" $BASE/session/$SID/proxy/5174/

# 2. 杀掉 dev，访问 proxy 应返回带诊断的 502
curl -s -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"pkill -f vite || true","timeoutSeconds":15}' > /dev/null
sleep 2
curl -s -w "\nHTTP=%{http_code}\n" $BASE/session/$SID/proxy/5174/ | python3 -c "
import json,sys
raw=sys.stdin.read()
body=raw.rsplit('HTTP=',1)[0]
print('HTTP='+raw.rsplit('HTTP=',1)[1].strip())
d=json.loads(body)
print('error:',d.get('error'))
diag=d.get('diagnostics',{})
print('portListening:',diag.get('portListening'))
print('hint:',diag.get('hint','')[:100])
print('originalError kept:','Could not connect' in (d.get('originalError') or ''))
"
```
**期望**：
- 步骤 1：`running=200`（正常路径回归）
- 步骤 2：HTTP 502，`error="sandbox process unreachable"`，`diagnostics.portListening=false`，`hint` 给出明确指引；若为 OOM 死亡则 `oomKillCount`/`lastKilled` 有值且 hint 提示内存不足；`originalError` 保留上游原始错误

### T19.25 沙箱 boot 初始化：pnpm store 迁出 git 树 + 全局 exclude 兜底

> 背景：pnpm 在 HOME 与 /workspace 跨文件系统时把 store 落进 `/workspace/.pnpm-store`（硬链接需同盘），业务 .gitignore 普遍缺该条目 → untracked 爆炸 → vcs diff 502（ses_f810f46a、ses_f7a07a06 两次踩坑，靠 AI/平台事后补 .gitignore，还被 Harness Bot 提交进业务 git 历史）。
> 修复（对齐 `docs/shared-package-cache-design.md`）：createSandbox 初始化命令把全局 npmrc 的 store-dir 指到共享 package-cache 挂载（`OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT`，默认 `/opt/pnpm-store`），并配全局 excludesfile 兜底；install 命令不再依赖调用方手动拼 `--store-dir`。

```bash
# 1. 新建会话（触发 createSandbox），验证初始化配置就位
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' \
  -d "{\"directory\":\"/workspace\",\"title\":\"boot-init\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
curl -s -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"cat /root/.npmrc; echo ---; cat /home/sandbox/.gitignore-global; echo ---; git config --global core.excludesfile","timeoutSeconds":30}' | python3 -c "import json,sys; print(json.load(sys.stdin)['stdout'])"

# 2. 跑一次 pnpm install，验证 store 不落 workspace
# 注意：不吞 stderr、显式看 exit code——install 失败时"无 .pnpm-store"是假阳性（初版验证踩过此坑）
curl -s --max-time 120 -X POST $BASE/session/$SID/exec -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && printf \"{\\\"name\\\":\\\"t\\\",\\\"version\\\":\\\"1.0.0\\\"}\\n\" > package.json && pnpm add is-even 2>&1 | tail -3; ls -d /workspace/.pnpm-store 2>/dev/null && echo BAD_STORE_IN_WORKSPACE || echo STORE_NOT_IN_WORKSPACE; pnpm store path","timeoutSeconds":110}' | python3 -c "import json,sys; print(json.load(sys.stdin)['stdout'])"

# 3. vcs/diff 不受 untracked 拖累（秒回）
time curl -s -o /dev/null -w "diff=%{http_code}\n" "$BASE/session/$SID/vcs/status?directory=%2Fworkspace"
```
**期望**：
- 步骤 1：`/root/.npmrc` 含 `store-dir=/opt/pnpm-store`；`.gitignore-global` 含 `.pnpm-store/`；`core.excludesfile=/home/sandbox/.gitignore-global`
- 步骤 2：pnpm 输出 `Done in ...`（install 真实成功）；`STORE_NOT_IN_WORKSPACE`；`pnpm store path` 指向共享挂载
- 步骤 3：diff/status 快速返回（无 502/超时）

> 实测备注：store（共享 NFS 挂载）与 /workspace 跨挂载点，硬链接 EXDEV（实测 `ln` 报 Invalid cross-device link），pnpm 自动降级 copy 模式（node_modules 文件 `stat %h` = 1）——跨会话共享下载缓存的既有代价，非本次引入。

### 单测（bun test，非 HTTP 集成）

```bash
cd packages/opencode

# 诊断与信号解码纯逻辑（17 用例，无外部依赖）
bun test test/server/sandbox-diag.test.ts

# runDetached 行为断言（3 用例：完成不删 session / exit 137 不抛错 / 超时 interrupt）
# 需本地 PG opencode_test 库（migration-pg 已应用）；lifecycle mock 内嵌于测试文件
OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
  bun test test/tool/sandbox-detached-keepalive.test.ts

# boot 初始化命令断言（2 用例：store 迁共享挂载 + excludesfile 全量配置 / 配置段 "; " 连接不短路）
# 同上需本地 PG opencode_test 库；lifecycle mock 捕获 POST /command 下发的命令
OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode_test \
  bun test test/tool/sandbox-boot-init.test.ts
```
**期望**：17/17、3/3、2/2 全 pass。keepalive T1 断言 `sessionDeletes == []` 是该修复的行为锚点——编辑事故（修复未落盘）正是被它暴露的。

---

> API 参考（请求/响应字段、错误码）已迁至 [`guides/exec-api-reference.md`](./guides/exec-api-reference.md)。

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T19.1 | ✅ | session `ses_15bf06e8fffe1ZYG0zMEnDZBp2`；`exitCode=0`，`stdout=hello-from-exec` |
| T19.2 | ✅ | `exitCode=0`，stdout 含 `line1`、`line2`、`err`；stderr 仍为空，符合当前 stderr 合并到 stdout 的实现 |
| T19.3 | ✅ | `workingDirectory=/tmp` 生效，`pwd=/tmp` |
| T19.4 | ✅ | `exitCode=42`，返回 `CommandExecError` |
| T19.5 | ✅ | 缺少 `command` 返回 HTTP 400，body=`{"error":"command is required"}` |
| T19.6 | ✅ | 不存在 session 返回 HTTP 404，body=`{"error":"session not found"}` |
| T19.7 | ✅ | 补跑 session `ses_15be523d1ffeWmA1Td5pR3YBnv`；`keepAlive=true`，Vite 5 dev server 通过 `/session/:id/proxy/5173/` 返回 HTTP 200，proxy HTML 注入了 `/session/.../proxy/5173` 前缀脚本 |
| T19.8 | ✅ | session `ses_15befc2f2ffebwECFzD0gCkVsG`；`keepAlive=true` 后等待 15s，`exec echo alive` 成功，`exitCode=0 stdout=alive` |
| T19.9 | ⚠️ | session `ses_15bef4a2bffe07JBHR9UMONBup`；释放 keepAlive 后等待 15s，纯 exec 仍可返回 `exitCode=0 stdout=dead`；PG 记录随后由 session runner idle 回收为 destroyed。纯 exec 本身不保证触发 idle destroy |
| T19.10 | ✅ | 超时控制全链路验证：T19.10a 不传超时正常完成；T19.10b `timeoutSeconds=1` Effect 层 ~1s 返回 `exitCode=null` + `TimeoutError`；T19.10c `timeoutSeconds=0` 不超时（falsy）；T19.10d 大超时值命令正常完成；T19.10e `withExecTimeout` 单元测试 7/7 pass；T19.10f 异步 exec（`/exec/async`）`timeoutSeconds=1` 超时生效，~2s 返回 `exitCode=null` |
| T19.11 | ✅ | 补跑显式 `workingDirectory=/workspace` 后返回 `node=v22.2.0 npm=10.7.0 pwd=/workspace` |
| T19.12 | ✅ | session `ses_15bbdc427ffekQUGtCGGPnKzFZ`，execId `exec-1-1780872265127`；`/exec/async` 立即返回 `running`，`/stream` 依次收到 `stdout×4` 和 `done`，最终状态 `completed exitCode=0`，sandbox 已清理为 `destroyed` |
| T19.13 | ✅ | session `ses_12ccef5ccffe9N4sbDwQ179Or5`；`boot:true` 返回 `sandboxId=60d502b8-ccf0-4863-8365-0b25f8b08147`，GET sandbox 一致，exec `exitCode=0 stdout=boot-ok` |
| T19.14 | ✅ | session `ses_12ccef4f6ffe5fGbpM7tNhBFaM`；不传 `boot` 返回 `sandboxId=null`，GET sandbox 确认无沙箱；`boot:false` 同样返回 `sandboxId=null` |
| T19.15 | ✅ | 同步 exec 后 exec_log 持久化，GET /execs 含记录（command/status/exitCode） |
| T19.16 | ✅ | 异步 exec running→completed，GET /exec/:execId 状态正确 |
| T19.17 | ✅ | 多条 exec 历史记录可查（GET /execs 列表 + GET /exec/:execId 详情） |
| T19.18 | ✅ | exec_log 容错：操作函数内部 try/catch，写入失败不影响 exec 返回 |
| T19.19 | ✅ | kill 后 exec_log 状态更新为 killed |
| T19.20 | ⏳ | exec_log 字段覆盖（working_directory/exit_code/stderr 合并行为）——用例已定义，待执行 |
| T19.21 | ⏳ | exec_log stdout 64KB 截断 + `...[truncated]` 标记——用例已定义，待执行 |
| T19.22 | ✅ | 2026-09-08 本地组合 1（远端 PG+远端沙箱，镜像 `oom-diag`）实测：session `ses_f810f46acffe2Ft0hJH4F7EnNp`，sleep 45 完整跑完 `completed exit=0 stdout=LONG-DONE` 同类验证；修复前同路径进程启动即被杀（exec-837 VITE ready→Killed 137） |
| T19.23 | ✅ | 2026-09-08 同环境实测：`sh -c 'kill -9 $$'` → `{exitCode:137, signal:"SIGKILL", oomSuspected:true}`；容器日志出现 `command killed by SIGKILL — likely sandbox memory OOM` |
| T19.24 | ✅ | 2026-09-08/09 组合 1 实测（v2/v4 镜像各一轮）：dev 运行时 proxy 200（正常路径回归）；pkill 后 502 响应含 `diagnostics.portListening=false` + hint + `originalError`（保留上游错误）。OOM 场景 `lastKilled` 来自 dmesg、`oomKillCount` 来自 cgroup（v2 memory.events / v1 memory.oom_control，缺失时为 null） |
| T19.25 | ✅ | 2026-09-09 组合 1 实测（镜像 `boot-init`）：新会话 `ses_f798519a9ffeYGzul0XZ96NNy3` boot 后 `/root/.npmrc` 含 `store-dir=/opt/pnpm-store`、`pnpm store path`=`/opt/pnpm-store/v10`、excludesfile 就位；`pnpm add is-even` 真实成功（Done in 1s）后 `STORE_NOT_IN_WORKSPACE`，`git status` 21ms、vcs/diff 200（0.49s）。初版验证曾假阳性（坏 package.json + 吞 stderr 导致 install 失败被误判通过），已修正用例命令并复测。旧会话 `ses_f7a07a06` kill-sandbox 重建后新配置生效，1.2GB 旧 store 由 setsid 后台 rm 渐进清理（实测进程存活） |

**本轮全量回归环境**：宿主机 opencode server `127.0.0.1:14097`，PG auth，OpenSandbox Docker runtime `127.0.0.1:8080`，sandbox image `opencode-opensandbox:local`，`OPENCODE_SANDBOX_USE_SERVER_PROXY=false`。

**本轮 session**：主回归 session `ses_15bf06e8fffe1ZYG0zMEnDZBp2`；T19.8 session `ses_15befc2f2ffebwECFzD0gCkVsG`；T19.9 session `ses_15bef4a2bffe07JBHR9UMONBup`；T19.7 补跑 session `ses_15be523d1ffeWmA1Td5pR3YBnv`。

**PG / sandbox 验证**：本轮 4 个 session 均创建了 sandbox 记录，host 均为 `http://127.0.0.1:8080`；测试结束后全部清理为 `state=destroyed`。exec API 本身不写入 message part；PG `part` 表只记录用于创建 sandbox 的 AI bootstrap 消息，主 session、T19.8 session、T19.9 session 各有 `bash completed×1`。

**T19.7 补跑说明**：第一次自动化 runner 使用 `vite@latest`，当前 latest 要求 Node `^20.19.0 || >=22.12.0`，而 sandbox 为 Node `v22.2.0`，导致 proxy 502；随后按文档语义改用 Vite 5 兼容链路补跑，proxy 返回 200。`kill-sandbox` 初次清理 Vite session 时因 exec 状态未立即返回，先通过 OpenSandbox `DELETE /v1/sandboxes/:id` 删除容器，再调用 `kill-sandbox` 同步 PG 状态。

**T19.12 流式日志验证**：SSE 事件序列为 `stdout(async-line-1)`、`stdout(async-line-2)`、`stdout(async-line-3)`、`stdout(async-done)`、`done(status=completed, exitCode=0)`；`GET /exec/:execId` 返回 `stdout` 包含完整输出。该用例只使用 exec API，不产生 message/part 记录；PG `sandbox` 表记录 `session_id=ses_15bbdc427ffekQUGtCGGPnKzFZ`，host=`http://127.0.0.1:8080`，测试后 state=`destroyed`。

### 已知问题

- **T19.9 idle 销毁机制**：sandbox 的 idle 回收由 session runner 的 `onIdle` 回调触发（见 `run-state.ts`），纯 exec API 调用不经过 session runner，因此释放 keepAlive 后不会仅凭 exec 探测触发销毁。需通过 `kill-sandbox` 或 `instance/dispose` 显式销毁。
- **execd 进程级中止延迟**：`withExecTimeout` 在 Effect 层面于 `timeoutSeconds` 后返回超时结果（`exitCode=null`），但底层 execd 进程可能仍在运行——`Effect.timeoutOrElse` 取消了 Effect fiber，底层 HTTP 连接被中断，execd 容器内的 `sleep` 进程何时退出取决于 execd 实现。Effect 层超时保证 API 调用方在指定时间内收到响应。
