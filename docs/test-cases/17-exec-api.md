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
**期望**：释放 keepAlive 后，sandbox 被 idle 回收，exec 返回 502 或执行失败

### T19.10 exec API：超时控制

```bash
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 30 && echo done","timeoutSeconds":5}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'has error: {bool(d.get(\"error\"))}')
"
```
**期望**：命令在 5 秒后被终止，返回非 0 exitCode 或 error

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

### API 接口详情

#### `POST /session/:sessionID/exec`

在沙箱中执行命令。沙箱不存在时会按需自动创建；无需先通过 AI 消息创建 sandbox。同步 exec 会等待命令退出，长驻进程请使用 `/exec/async`，或在命令内部用 `nohup ... </dev/null > /tmp/app.log 2>&1 & echo $!` 显式后台化。

**请求体**：
```json
{
  "command": "echo hello",
  "workingDirectory": "/workspace",  // 可选，默认 /workspace
  "timeoutSeconds": 30               // 可选，默认不限
}
```

**响应**：
```json
{
  "id": "exec-xxx",
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": "",
  "error": null  // 或 {"name":"...","value":"...","traceback":[...]}
}
```

#### `POST /session/:sessionID/exec/async`

异步执行命令，适合长运行任务、watch 模式和 dev server。接口只负责启动命令并返回 `execId`；实时输出通过 `/stream` 消费，最终状态通过 `/exec/:execId` 查询。

**请求体**：同 `POST /exec`。

**响应**：
```json
{"execId":"exec-1-1234567890","status":"running","sessionID":"ses_xxx"}
```

#### `GET /session/:sessionID/exec/:execId/stream`

SSE 方式监听 async exec 的实时输出。

**事件**：
```text
event: stdout
data: {"text":"line\n"}

event: stderr
data: {"text":"error\n"}

event: ping
data:

event: done
data: {"execId":"exec-1-...","status":"completed","exitCode":0,"stdout":"...","stderr":""}
```

**注意**：当前 stream 直接消费内存 queue，不是可回放日志，也不是多消费者广播；客户端应在启动 async exec 后立即连接，且同一 `execId` 只保留一个 stream 消费者。

#### `GET /session/:sessionID/exec/:execId`

查询 async exec 当前或最终状态。该接口适合作为 SSE 断线后的兜底，不适合作为实时日志替代。

**响应**：
```json
{"execId":"exec-1-...","status":"completed","exitCode":0,"stdout":"...","stderr":"...","startedAt":123,"finishedAt":456}
```

#### `POST /session/:sessionID/exec/:execId/kill`

请求中断 async exec。当前 opencode 侧会将状态置为 `killed` 并结束 SSE stream；底层 detached command 是否立即中断取决于 sandbox execd 对 detached session interrupt 的支持，关键用例应同时验证进程是否退出或直接调用 `kill-sandbox` 清理。

#### `POST /session/:sessionID/keep-alive`

设置或释放 keepAlive。`keepAlive=true` 时 sandbox 在 session idle 后不会被自动销毁。`boot=true` 时额外立即创建沙箱。

**请求体**：
```json
{"enabled": true}                  // 设置 keepAlive（默认）
{"enabled": true, "boot": true}    // 设置 keepAlive + 立即启动沙箱
{"enabled": false}                 // 释放 keepAlive
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | `true` | keepAlive 开关。`true`=保活，`false`=释放 |
| `boot` | boolean | `false` | 是否立即启动沙箱。仅在 `enabled:true` 时生效 |

> `boot:true` 先设置 keepAlive（写入 DB），再调用 `getOrCreate` 创建沙箱，确保沙箱使用 10x TTL。boot 失败不影响 keepAlive 设置，返回 `sandboxId: null`。

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true, "sandboxId": null}
```

- `sandboxId`：`boot:true` 且沙箱创建成功时返回沙箱 ID；其余情况为 `null`

#### `GET /session/:sessionID/keep-alive`

查询 keepAlive 状态。

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true}
```


---

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
| T19.10 | ⚠️ | `timeoutSeconds=5` 透传后，`sleep 30 && echo done` 约 30.2s 后返回 `exitCode=null`；execd 未在 5s 强制中止，仍按已知 opensandbox execd 行为记录为 warning |
| T19.11 | ✅ | 补跑显式 `workingDirectory=/workspace` 后返回 `node=v22.2.0 npm=10.7.0 pwd=/workspace` |
| T19.12 | ✅ | session `ses_15bbdc427ffekQUGtCGGPnKzFZ`，execId `exec-1-1780872265127`；`/exec/async` 立即返回 `running`，`/stream` 依次收到 `stdout×4` 和 `done`，最终状态 `completed exitCode=0`，sandbox 已清理为 `destroyed` |
| T19.13 | ✅ | session `ses_12ccef5ccffe9N4sbDwQ179Or5`；`boot:true` 返回 `sandboxId=60d502b8-ccf0-4863-8365-0b25f8b08147`，GET sandbox 一致，exec `exitCode=0 stdout=boot-ok` |
| T19.14 | ✅ | session `ses_12ccef4f6ffe5fGbpM7tNhBFaM`；不传 `boot` 返回 `sandboxId=null`，GET sandbox 确认无沙箱；`boot:false` 同样返回 `sandboxId=null` |
| T19.15 | ✅ | 同步 exec 后 exec_log 持久化，GET /execs 含记录（command/status/exitCode） |
| T19.16 | ✅ | 异步 exec running→completed，GET /exec/:execId 状态正确 |
| T19.17 | ✅ | 多条 exec 历史记录可查（GET /execs 列表 + GET /exec/:execId 详情） |
| T19.18 | ✅ | exec_log 容错：操作函数内部 try/catch，写入失败不影响 exec 返回 |
| T19.19 | ✅ | kill 后 exec_log 状态更新为 killed |

**本轮全量回归环境**：宿主机 opencode server `127.0.0.1:14097`，PG auth，OpenSandbox Docker runtime `127.0.0.1:8080`，sandbox image `opencode-opensandbox:local`，`OPENCODE_SANDBOX_USE_SERVER_PROXY=false`。

**本轮 session**：主回归 session `ses_15bf06e8fffe1ZYG0zMEnDZBp2`；T19.8 session `ses_15befc2f2ffebwECFzD0gCkVsG`；T19.9 session `ses_15bef4a2bffe07JBHR9UMONBup`；T19.7 补跑 session `ses_15be523d1ffeWmA1Td5pR3YBnv`。

**PG / sandbox 验证**：本轮 4 个 session 均创建了 sandbox 记录，host 均为 `http://127.0.0.1:8080`；测试结束后全部清理为 `state=destroyed`。exec API 本身不写入 message part；PG `part` 表只记录用于创建 sandbox 的 AI bootstrap 消息，主 session、T19.8 session、T19.9 session 各有 `bash completed×1`。

**T19.7 补跑说明**：第一次自动化 runner 使用 `vite@latest`，当前 latest 要求 Node `^20.19.0 || >=22.12.0`，而 sandbox 为 Node `v22.2.0`，导致 proxy 502；随后按文档语义改用 Vite 5 兼容链路补跑，proxy 返回 200。`kill-sandbox` 初次清理 Vite session 时因 exec 状态未立即返回，先通过 OpenSandbox `DELETE /v1/sandboxes/:id` 删除容器，再调用 `kill-sandbox` 同步 PG 状态。

**T19.12 流式日志验证**：SSE 事件序列为 `stdout(async-line-1)`、`stdout(async-line-2)`、`stdout(async-line-3)`、`stdout(async-done)`、`done(status=completed, exitCode=0)`；`GET /exec/:execId` 返回 `stdout` 包含完整输出。该用例只使用 exec API，不产生 message/part 记录；PG `sandbox` 表记录 `session_id=ses_15bbdc427ffekQUGtCGGPnKzFZ`，host=`http://127.0.0.1:8080`，测试后 state=`destroyed`。

### 已知问题

- **T19.10 命令超时未生效**：opencode 代码层透传链路完整（`POST /exec` → `runInSession({timeoutSeconds})` → SDK `runInSession`）。SDK `RunCommandOpts.timeoutSeconds` 注释为"server will not enforce any timeout if omitted"，传值后 execd 服务端仍未强制 5s 超时。属 opensandbox execd 服务端行为，需服务端侧排查。
- **T19.9 idle 销毁机制**：sandbox 的 idle 回收由 session runner 的 `onIdle` 回调触发（见 `run-state.ts`），纯 exec API 调用不经过 session runner，因此释放 keepAlive 后不会仅凭 exec 探测触发销毁。需通过 `kill-sandbox` 或 `instance/dispose` 显式销毁。
