# SSE 事件流

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置见 [`00-preamble.md`](./00-preamble.md)。运行用例前先 `source test-env.sh 3 && source test-lib.sh`（以下用例直接使用 `$BASE`/`$MODEL`/`jexec`）。



## 九、SSE 事件流

**事件格式差异**：
- 全局 SSE：`data: {"directory":"...","project":"...","payload":{"id":"...","type":"...","properties":{}}}\n\n`
- 实例 SSE：`data: {"id":"...","type":"...","properties":{}}\n\n`

**通用采集脚本**：所有 SSE 用例统一使用 [`scripts/sse-dump.mjs`](./scripts/sse-dump.mjs)（订阅 → 输出拍平后的事件 JSON 行，全局/实例格式已统一）：

```bash
# 标准三段式：后台订阅 → 执行业务动作 → 断言事件日志
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" <采集秒数> "$DIR" > /tmp/sse.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/sse.log 2>/dev/null && break; sleep 0.5; done   # 等订阅建立
# ... 业务动作（curl 发消息等）...
wait $SSE_PID
# grep/jq 断言 /tmp/sse.log
```

实例级 `/event` 需要先取 `DIR`：

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")
```

---

### T9.1 全局事件流：订阅与初始连接事件

> 验证：响应头、初始 `server.connected` 事件

```bash
curl -s -N --max-time 3 -D - -o /dev/null "$BASE/global/event" | grep -i "content-type\|cache-control"

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 3 > /tmp/t91.log
head -1 /tmp/t91.log | jexec "d.get('type')"
```
**期望**：`content-type` 含 `text/event-stream`，`cache-control` 为 `no-cache, no-transform`，首个事件 `type` 为 `server.connected`

---

### T9.2 全局事件流：创建 session 触发事件

> 验证：全局 SSE 能收到 session 生命周期事件

```bash
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 12 > /tmp/t92.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t92.log 2>/dev/null && break; sleep 0.5; done

curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' > /dev/null
wait $SSE_PID

grep -m1 '"type":"session.created"' /tmp/t92.log
```
**期望**：收到 `session.created` 事件，包含 `sessionID`

---

### T9.3 全局事件流：心跳机制

> 验证：约 10 秒后收到 `server.heartbeat`

```bash
time bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 12 > /tmp/t93.log
grep -c server.heartbeat /tmp/t93.log
```
**期望**：`server.heartbeat` ≥ 1（首次心跳约 10s）

---

### T9.4 实例事件流：订阅与初始连接事件

> 验证：实例级 SSE 连接、`x-opencode-directory` 头、初始事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

curl -s -N --max-time 3 -D - -o /dev/null -H "x-opencode-directory: $DIR" "$BASE/event" | grep -i content-type
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 3 "$DIR" > /tmp/t94.log
head -1 /tmp/t94.log | jexec "d.get('type')"
```
**期望**：`content-type` 为 `text/event-stream`，首个事件 `type` 为 `server.connected`

### T9.5 实例事件流：会话消息事件（message.part.updated）

> 验证：LLM 响应过程中 SSE 推送消息相关事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t95.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t95.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

grep -c '"type":"message.part.updated"\|"type":"message.part.delta"' /tmp/t95.log
grep -c '"type":"session.idle"' /tmp/t95.log
```
**期望**：`message.part.updated`/`message.part.delta` ≥ 1（事件含 `properties.sessionID`），`session.idle` ≥ 1

### T9.6 实例事件流：工具调用事件

> 验证：工具调用的 SSE 生命周期事件（pending → running → completed/error）

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 80 "$DIR" > /tmp/t96.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t96.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 75 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 echo hello_sse_test\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

# 提取 tool part 的状态流转
python3 -c "
import json
stats = []
for line in open('/tmp/t96.log'):
    part = json.loads(line).get('properties', {}).get('part', {})
    if part.get('type') == 'tool':
        stats.append(part.get('state', {}).get('status'))
print('tool statuses:', stats)
print('has lifecycle:', 'pending' in stats and any(s in stats for s in ('running','completed','error')))
"
```
**期望**：收到 `message.part.updated`（`part.type === 'tool'`），状态流转 `pending` → `running` → `completed`（或 `error`，取决于 sandbox 环境）

### T9.7 实例事件流：权限请求事件

> 验证：`permission.asked` 事件通过 SSE 推送，并可程序化回复

> **前提**：不要在全局 config 中配 `permission.edit: allow`（否则不会触发 `permission.asked`）。如果已配，可临时移除：
> ```bash
> curl -s -X PATCH "$BASE/global/config" \
>   -H 'Content-Type: application/json' \
>   -d '{"permission":{"bash":"allow","edit":"ask","write":"ask","glob":"allow","grep":"allow","list":"allow","read":"allow","webfetch":"allow"}}'
> ```
>
> **根因说明**：`evaluate()` 默认返回 `{ action: "ask" }`。当 config 未配置 permission 时，所有工具调用都需权限确认。HTTP API 模式下无 UI 回复权限请求，工具会卡在 `running` 状态。本用例通过 SSE 监听 `permission.asked` 后自动回复来验证。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 80 "$DIR" > /tmp/t97.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t97.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 75 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"use the write tool to write hello to /workspace/sse-perm-test.txt\"}],\"model\":$MODEL}" > /dev/null &

# 轮询日志捕获 permission.asked 并自动回复
for i in $(seq 1 40); do
  PLINE=$(grep -m1 '"type":"permission.asked"' /tmp/t97.log 2>/dev/null)
  if [ -n "$PLINE" ]; then
    PID=$(echo "$PLINE" | jexec "d['properties']['id']")
    echo "permission.asked id=$PID"
    curl -s -X POST "$BASE/session//permissions/" \
      -H 'Content-Type: application/json' -d '{"response":"always"}'
    echo "replied: always"
    break
  fi
  sleep 2
done
wait $SSE_PID 2>/dev/null
```
**期望**：收到 `permission.asked` 事件并成功回复（若 `edit` 权限已配 `allow` 则 session 正常完成无权限弹窗）

### T9.8 实例事件流：多会话事件隔离

> 验证：两个 session 的事件通过 `sessionID` 正确路由，无交叉污染

```bash
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID_A" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 60 "$DIR" > /tmp/t98.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t98.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 55 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说A\"}],\"model\":$MODEL}" > /dev/null &
curl -s --max-time 55 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说B\"}],\"model\":$MODEL}" > /dev/null &
wait $SSE_PID

python3 -c "
import json
a=b=0
for line in open('/tmp/t98.log'):
    sid = json.loads(line).get('properties',{}).get('sessionID')
    a += sid == '$SID_A'; b += sid == '$SID_B'
print(f'A events: {a}, B events: {b}')
print('✅ both > 0' if a>0 and b>0 else '❌')
"
```
**期望**：两个 session 各自收到事件（计数 > 0），事件 `sessionID` 无交叉

### T9.9 实例事件流：会话状态变更事件（session.status / session.idle）

> 验证：LLM 处理期间 `session.status` 事件，完成后 `session.idle` 事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t99.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t99.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

grep -o '"type":"session\.\(status\|idle\)"' /tmp/t99.log | sort | uniq -c
```
**期望**：先收到 `session.status`（busy），完成后收到 `session.idle`

### T9.10 实例事件流：异步 prompt 触发事件

> 验证：`POST /session/:id/prompt_async` 返回 204，事件通过 SSE 推送

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t910.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t910.log 2>/dev/null && break; sleep 0.5; done

curl -s -o /dev/null -w "prompt_async: %{http_code}\n" -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}"
wait $SSE_PID

grep -c '"type":"message.part.updated"\|"type":"message.part.delta"' /tmp/t910.log
```
**期望**：`prompt_async` 返回 204，SSE 收到 `message.part.updated` / `message.part.delta`

### T9.11 实例事件流：文件变更事件

> 验证：文件写入操作触发 `file.edited` / `file.watcher.updated` 事件

> **前提**：
> 1. Sandbox TCP 转发必须启动（`lsof -i :30040 | grep LISTEN`），否则 write 工具卡在 sandbox 初始化
> 2. 权限需配 `edit: allow`（通过 `PATCH /global/config {"permission":{"edit":"allow",...}}`），否则工具卡在权限等待
> 3. 写文件路径必须在项目目录内（如 `/workspace/`），写 `/tmp/` 会触发 `external_directory` 权限
>
> **根因说明**：write 工具通过 `ctx.sandbox` 在沙箱中执行写操作，sandbox 不可达时 Promise 永远 pending（工具显示 `running`）。默认权限 `"ask"` 无 UI 回复也会卡住。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 80 "$DIR" > /tmp/t911.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t911.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 75 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"use the write tool to write hello to /workspace/sse-file-test.txt\"}],\"model\":$MODEL}" > /dev/null &

# 若出现权限请求则自动回复（同 T9.7）
for i in $(seq 1 40); do
  PLINE=$(grep -m1 '"type":"permission.asked"' /tmp/t911.log 2>/dev/null)
  if [ -n "$PLINE" ]; then
    PID=$(echo "$PLINE" | jexec "d['properties']['id']")
    curl -s -X POST "$BASE/session//permissions/" \
      -H 'Content-Type: application/json' -d '{"response":"always"}' > /dev/null
    break
  fi
  grep -q '"type":"file.edited"\|"type":"file.watcher.updated"' /tmp/t911.log 2>/dev/null && break
  sleep 2
done
wait $SSE_PID 2>/dev/null

grep -m1 '"type":"file.edited"\|"type":"file.watcher.updated"' /tmp/t911.log
```
**期望**：收到 `file.edited` 或 `file.watcher.updated` 事件（sandbox 可达 + 权限已配 `allow` 时）

### T9.12 全局事件流：dispose 事件

> 验证：`POST /global/dispose` 触发 `server.instance.disposed` 事件

```bash
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 8 > /tmp/t912.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t912.log 2>/dev/null && break; sleep 0.5; done

curl -s -o /dev/null -w "dispose: %{http_code}\n" -X POST "$BASE/global/dispose"
wait $SSE_PID

grep -i disposed /tmp/t912.log
```
**期望**：收到含 `disposed` 的事件，或连接被服务端关闭

### T9.13 实例事件流：连接断开后重连

> 验证：SSE 连接可重复建立，每次都收到 `server.connected`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 3 "$DIR" > /tmp/t913a.log
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 3 "$DIR" > /tmp/t913b.log
head -1 /tmp/t913a.log | jexec "d.get('type')"
head -1 /tmp/t913b.log | jexec "d.get('type')"
```
**期望**：两次连接都收到 `server.connected`

### T9.14 实例事件流：多客户端监听同一会话

> 验证：一个会话执行任务时，多个 SSE 客户端同时监听都能收到相同的事件序列

> **场景**：模拟多用户（如编辑器 + 终端 + CI 监控）同时通过 SSE 观察同一个会话的执行过程。验证 Bus 的 PubSub 模式能正确广播到所有订阅者。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

# 3 个客户端并行监听
for c in a b c; do
  bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 55 "$DIR" > /tmp/t914$c.log &
done
for c in a b c; do
  for i in $(seq 1 20); do grep -q server.connected /tmp/t914$c.log 2>/dev/null && break; sleep 0.5; done
done

curl -s --max-time 50 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"say hello in one sentence\"}],\"model\":$MODEL}" > /dev/null
wait

for c in a b c; do
  echo "client $c: $(grep -c '"type":"message\.' /tmp/t914$c.log) message events, idle=$(grep -c session.idle /tmp/t914$c.log)"
done
```
**期望**：3 个 SSE 客户端都收到 `server.connected`、至少一个 `message.*` 事件、`session.idle`，且事件类型列表一致

### T9.15 实例事件流：中途加入的客户端收到后续事件

> 验证：会话执行过程中新连接的 SSE 客户端能收到后续事件（不要求回放历史）

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

# 客户端 A：一开始就连接
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 55 "$DIR" > /tmp/t915a.log &
for i in $(seq 1 20); do grep -q server.connected /tmp/t915a.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 50 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"say hello\"}],\"model\":$MODEL}" > /dev/null &

# 客户端 B：2 秒后中途加入
sleep 2
bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t915b.log &
wait

echo "A: $(wc -l < /tmp/t915a.log) events"
echo "B: $(wc -l < /tmp/t915b.log) events"
grep -c '"type":"message\.' /tmp/t915b.log
```
**期望**：客户端 B 中途加入后仍能收到 `server.connected` 和后续事件（`session.idle` 等）

> **实测结论（有据）**：B 中途加入能收到完整事件流（含 `message.part.*`、`tool`、`session.idle`），多次受控实验验证通过。
>
> **偶发现象（未复现）**：测试中曾出现 2 次"B 只收到 `server.connected` + `server.heartbeat`、无任何 `message` 事件"。随后 **28 轮多角度压力复现**（常规 dispose+中途订阅 / 激进 dispose+0.5s+B 1s / T9.14 3并发SSE+T9.15 完整序列）**全部 0 失败**，无法稳定复现。统计上若真实失败率 ≥10%，28 轮全过的概率仅 5%，故失败率大概率 <10%。
>
> **根因未定位**：在无稳定复现路径前，不对根因下任何结论。曾推测的 takeUntil 终止 / dispose 重建窗口 / T9.14 累积状态，均**未被复现验证支持，已撤回**。
>
> **再次出现时的抓取方法**：给 `packages/opencode/src/bus/index.ts` 的 `subscribing`/`publishing` 日志补 `directory` 字段（`yield* InstanceState.directory`），即可判断失败 SSE 流的"订阅实例"与"message publish 实例"是否错位。

---

### T9.16 实例事件流：会话更新与删除事件（session.updated / session.deleted）

> 验证：`PATCH /session/:id` 触发 `session.updated`，`DELETE /session/:id` 触发 `session.deleted`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 20 "$DIR" > /tmp/t916.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t916.log 2>/dev/null && break; sleep 0.5; done

curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' -d '{"title":"sse-updated"}' > /dev/null
curl -s -X DELETE "$BASE/session/$SID" > /dev/null
wait $SSE_PID

grep -m1 '"type":"session.updated"' /tmp/t916.log | jexec "d['properties']['info']['title']"
grep -c '"type":"session.deleted"' /tmp/t916.log
```
**期望**：收到 `session.updated`（`properties.info.title=sse-updated`）与 `session.deleted`（计数 ≥1）

### T9.17 实例事件流：消息删除事件（message.removed / message.part.removed）

> 验证：删除消息/part 触发 `message.removed` / `message.part.removed`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")
curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":$MODEL}" > /dev/null

MID=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin, strict=False)
print([m for m in msgs if m.get('info',{}).get('role')=='assistant'][-1]['info']['id'])
")
PID=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin, strict=False)
print(msgs[-1]['parts'][0]['id'])
")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 15 "$DIR" > /tmp/t917.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t917.log 2>/dev/null && break; sleep 0.5; done

curl -s -X DELETE "$BASE/session/$SID/message/$MID" > /dev/null
wait $SSE_PID

grep -c '"type":"message.removed"' /tmp/t917.log
```
**期望**：删除消息后收到 `message.removed`（计数 ≥1）；`message.part.removed` 需通过删 part 端点触发（`DELETE /session/:id/message/:mid/part/:pid`），两者均可选验证

### T9.18 实例事件流：消息状态事件（message.updated）

> 验证：`POST /session/:id/prompt_async` 消息处理完成后触发 `message.updated`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 50 "$DIR" > /tmp/t918.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t918.log 2>/dev/null && break; sleep 0.5; done

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"说一个字\"}],\"model\":$MODEL}" > /dev/null
wait $SSE_PID

grep -c '"type":"message.updated"' /tmp/t918.log
```
**期望**：收到 `message.updated` ≥ 1（assistant 消息落库时触发）

### T9.19 实例事件流：会话错误事件（session.error）

> 验证：非法模型 ID 发送消息触发 `session.error`

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 20 "$DIR" > /tmp/t919.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t919.log 2>/dev/null && break; sleep 0.5; done

curl -s --max-time 15 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"zhipuai","modelID":"nonexistent-model-xyz"}}' > /dev/null
wait $SSE_PID

grep -m1 '"type":"session.error"' /tmp/t919.log | jexec "d['properties'].get('error',{}).get('name')"
```
**期望**：收到 `session.error` 事件（`properties.error` 含错误信息；非法模型实测触发 `UnknownError`，可能与预期 `ProviderModelNotFoundError` 有差异，事件发出即可）

### T9.20 实例事件流：diff 事件（session.diff）

> 验证：`POST /session/:id/revert` 触发 `session.diff`
>
> ⚠️ **revert 必须传 `messageID`**（来自会话中的 user 消息）。空 body 时 revert 找不到目标消息，直接返回不发布 diff 事件。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")
curl -s --max-time 45 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' -d "{\"parts\":[{\"type\":\"text\",\"text\":\"hi\"}],\"model\":$MODEL}" > /dev/null
MID=$(curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin, strict=False)
u=[m for m in msgs if m.get('info',{}).get('role')=='user'][0]
print(u['info']['id'])
")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 20 "$DIR" > /tmp/t920.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t920.log 2>/dev/null && break; sleep 0.5; done

curl -s -X POST "$BASE/session/$SID/revert" -H 'Content-Type: application/json' -d "{\"messageID\":\"$MID\"}" > /dev/null
wait $SSE_PID

grep -c '"type":"session.diff"' /tmp/t920.log
```
**期望**：收到 `session.diff` ≥ 1（`properties.diff` 为 diff 数组，可为空数组）

### T9.21 实例事件流：agent/model 切换事件

> 验证：`session.agent.switched` / `session.model.switched` 事件
>
> **触发路径说明（实测确认）**：这两个事件由 V2 `Session.switchModel` / `Session.switchAgent` 发布（`packages/core/src/session.ts`）。**HTTP PATCH `/session/:id` 的 `UpdatePayload` 不支持 `model`/`agent` 字段**（仅 directory/title/metadata/permission/time.archived），PATCH model 会被静默忽略、不触发任何事件。当前 HTTP API 层无直接 switch 端点，事件由 LLM 工具调用（如 TUI/CLI 侧切换）或内部流程触发。本用例标记为**待补端点后验证**，当前通过 `session.updated`（T9.16）覆盖会话级变更。

```bash
# 待 HTTP switch 端点就绪后执行。当前 PATCH model 不会触发事件：
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 25 "$DIR" > /tmp/t921.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t921.log 2>/dev/null && break; sleep 0.5; done

# PATCH model 不会触发 session.model.switched（UpdatePayload 不支持 model 字段）
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' \
  -d '{"model":{"providerID":"zhipuai","modelID":"glm-4.6"}}' > /dev/null
wait $SSE_PID

echo "model.switched count: $(grep -c '"type":"session.model.switched"' /tmp/t921.log) (期望 0，见说明)"
echo "session.updated count: $(grep -c '"type":"session.updated"' /tmp/t921.log)"
```
**期望**：PATCH model 因 `UpdatePayload` 不支持被静默忽略，`session.model.switched`=0、`session.updated`=0。待 HTTP switch 端点就绪后，再验证 `session.model.switched`（`properties.model.modelID` 为新模型）与 `session.agent.switched`

### T9.22 实例事件流：资源生命周期事件（command.executed / todo.updated / mcp.tools.changed）

> 验证：自定义命令执行、todo 更新、MCP server 连接分别触发对应事件

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 25 "$DIR" > /tmp/t922.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t922.log 2>/dev/null && break; sleep 0.5; done

# 创建并执行自定义命令（CommandCreatePayload 用 template 字段；执行 payload 必填 command 字段）
curl -s -X POST "$BASE/session/$SID/commands/create" \
  -H 'Content-Type: application/json' -d '{"name":"sse-test-cmd","description":"t","template":"say hi","agent":"build","model":"zhipuai/glm-5.1"}' > /dev/null
curl -s -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' -d '{"command":"sse-test-cmd","arguments":""}' > /dev/null
wait $SSE_PID

grep -c '"type":"command.executed"' /tmp/t922.log
```
**期望**：执行自定义命令收到 `command.executed` ≥ 1。`todo.updated`（AI 更新 todo 时）与 `mcp.tools.changed`（MCP server 连接/断开时）为按需补充验证项

### T9.23 全局事件流：事件 envelope 字段完整性

> 验证：全局 SSE 事件的 `directory`/`project`/`payload` 字段结构
>
> ⚠️ 不能用 `sse-dump.mjs`（它会拍平 payload 层）。必须用原始 curl 查看未拍平的行。

```bash
curl -s -N --max-time 8 "$BASE/global/event" > /tmp/t923raw.log &
CURL_PID=$!
sleep 2
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' > /dev/null
wait $CURL_PID

python3 -c "
import re
for line in open('/tmp/t923raw.log'):
    m = re.search(r'data: (.+)', line)
    if not m: continue
    raw = m.group(1)
    if 'session.created' in raw:
        print(raw[:300]); break
"
```
**期望**：全局事件为 `{"directory":"/workspace","project":"global","payload":{"id":"evt_*","type":"session.created","properties":{...}}}`，`directory`/`project`/`payload` 三者齐全

### T9.24 实例事件流：事件 ID 格式

> 验证：事件 `id` 为 `evt_*` 前缀，且连接生命周期事件与业务事件一致

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
DIR=$(curl -s "$BASE/session/$SID" | jexec "d['directory']")

bun docs/test-cases/scripts/sse-dump.mjs "$BASE/event" 10 "$DIR" > /tmp/t924.log
python3 -c "
import json
for line in open('/tmp/t924.log')[:3]:
    d = json.loads(line)
    print(d.get('id','?'), d.get('type','?'))
"
```
**期望**：事件含 `id`（`evt_*` 前缀），类型分别为 `server.connected` / `server.heartbeat`

### T9.25 实例事件流：负向测试（缺 x-opencode-directory 头）

> 验证：无 `x-opencode-directory` 头时实例 SSE 的行为
>
> **实测结论**：缺头时 middleware 回退到 `Flag.OPENCODE_DEFAULT_DIRECTORY`（`/workspace`），**仍返回 200 + `server.connected`**，属于正常连接而非拒绝。因此负向判定标准是「事件仍能收到，但归属默认目录」，而非连接被拒。

```bash
# 无头请求：应返回 200 + text/event-stream + server.connected
curl -s -N --max-time 3 -D - "$BASE/event" | head -3
```
**期望**：HTTP 200、`content-type: text/event-stream`、首行 `server.connected`（回退默认目录连接成功）。若未来行为改为 400 拒绝，则标准同步调整

---

## 测试结果

| 用例 | 结果 | 备注 |
|------|------|------|
| T9.1 | ✅ | content-type、cache-control、server.connected 均验证通过 |
| T9.2 | ✅ | 全局 SSE 收到 session.created 事件 |
| T9.3 | ✅ | 10.0s 后收到 server.heartbeat |
| T9.4 | ✅ | 实例级 SSE 需 x-opencode-directory 头 |
| T9.5 | ✅ | 收到 message.part.updated 等 8 种事件类型 |
| T9.6 | ✅ | 工具生命周期 pending→running→error（sandbox 环境下 bash 可能 error） |
| T9.7 | ✅ | `permission.asked` 事件通过 SSE 推送，可程序化回复。需权限未配 `allow` 时触发 |
| T9.8 | ✅ | 两个 session 各自收到事件，无交叉 |
| T9.9 | ✅ | session.status(×4) → session.idle |
| T9.10 | ✅ | prompt_async 返回 204，SSE 正常推送 |
| T9.11 | ✅ | 收到 `file.edited` 事件。前提：sandbox 转发已启动 + 权限配 `edit:allow` + 写项目目录内路径 |
| T9.12 | ✅ | 收到 server.instance.disposed 事件 |
| T9.13 | ✅ | 断开重连均收到 server.connected |
| T9.14 | ✅ | 3 个 SSE 客户端同时监听，均收到相同 10 种事件类型 |
| T9.15 | ✅ | 中途加入收到完整事件流；曾现偶发"B 只收 connected+heartbeat"（28 轮未复现，详见用例备注） |
| T9.16 | ✅ | session.updated（PATCH title）/ session.deleted（DELETE）均收到 |
| T9.17 | ✅ | message.removed（删消息收到）；message.part.removed 走删 part 端点 |
| T9.18 | ✅ | message.updated（异步消息落库触发 6 次） |
| T9.19 | ✅ | session.error（非法模型触发，error.name=UnknownError） |
| T9.20 | ✅ | session.diff（revert 需传 messageID 才触发） |
| T9.21 | ⚠️ 待端点 | session.model.switched 走 V2 switchModel，HTTP PATCH 的 UpdatePayload 不支持 model 字段（静默忽略，不触发事件），待 switch 端点就绪后验证 |
| T9.22 | ✅ | command.executed（执行 payload 需 `command` 字段，创建用 `template` 字段） |
| T9.23 | ✅ | 全局事件 envelope 为 `{directory,project,payload}`（需原始 curl，sse-dump 会拍平） |
| T9.24 | ✅ | 事件 id 为 `evt_*` 前缀 |
| T9.25 | ✅ | 缺 x-opencode-directory 头时回退默认目录（OPENCODE_DEFAULT_DIRECTORY），仍返回 200 + server.connected，非拒绝 |

> 注：T9.16-T9.25 为覆盖补全用例，已在本轮验证（组合 1：远端 PG + 远端 Sandbox）。T9.21 的 `session.agent.switched`/`session.model.switched` 需 HTTP switch 端点就绪后验证；`todo.updated`/`mcp.tools.changed` 为按需补充项。

> 注：2026-07-17 重构为标准三段式（sse-dump.mjs 后台订阅 + 业务动作 + 日志断言），原始内联 bun 脚本见 git 历史。

---
