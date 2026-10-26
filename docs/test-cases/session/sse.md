# V2 SSE 事件流

> 本文按当前 V2 HTTP API 重写。V2 只有一个统一事件流 `GET /api/event`（不再有 `/global/event` 与实例级 `/event` 之分），
> 并新增会话级 `GET /api/session/:sessionID/event` 与 `POST /api/session/:sessionID/prompt_stream`。
> 事件契约以 `packages/schema/src/event.ts`、`session-event.ts` 与运行中服务的 `/openapi.json` 为准。
> V1 原文（`/global/event`、`/event`、`parts[]`、`properties`、`message.part.*` 等）保留在 git 历史中。

## V1 → V2 契约变化

| 维度 | V1 | V2 |
|---|---|---|
| 事件流端点 | `GET /global/event`（全局）+ `GET /event`（实例，需 `x-opencode-directory`） | `GET /api/event`（统一，无需目录头） |
| 会话事件流 | 无 | `GET /api/session/:sessionID/event`（按 sessionID 过滤） |
| 发送并跟随 | `POST /session/:id/message`（同步）+ `prompt_async` | `POST /api/session/:id/prompt`（异步接纳），`POST /api/session/:id/prompt_stream`（接纳并跟随该回合） |
| 中断 | `POST /session/:id/abort` | `POST /api/session/:id/interrupt` → `{interrupted}` |
| 断连续传 | `GET /session/:id/event?after=<seq>` | `GET /api/experimental/session/:sessionID/log?after=<seq>&follow=<bool>` |
| 事件外层 | `{directory, project, payload:{...}}`（全局）/ `{id,type,properties}` | `{id, created, type, location?, data, durable?}`（统一） |
| 字段名 | `properties` | `data` |
| 序号字段 | 顶层 `seq`（部分实现） | `durable: {aggregateID, seq, version}` |
| 心跳 | `server.heartbeat` 事件 | SSE 注释行 `: heartbeat`（默认 15s，不是事件） |
| 消息文本 | `message.part.updated` / `message.part.delta` | `session.text.started/delta/ended` |
| 工具参数增量 | `message.part.delta`（field=raw） | `session.tool.input.delta`（`id` + `delta`） |
| 工具生命周期 | `message.part.updated` 的 tool state | `session.tool.input.started` → `session.tool.called` → `session.tool.success`/`failed` |
| 完成信号 | `session.idle` | `session.execution.succeeded/failed/interrupted`（`session.idle` 仍存在但已标记 deprecated） |
| 会话更新 | `session.updated` | `session.renamed` / `session.moved` / `session.permissions` 等细分事件 |
| 文件变更 | `file.edited` / `file.watcher.updated` | `filesystem.changed`（`file` + `event: add/change/unlink`） |

**认证**：SaaS 服务所有路由在服务口令之后；V2 无匿名入口。示例统一使用 HTTP Basic（`-u opencode:$OPENCODE_PASSWORD`）。

## 前置条件与通用变量

```bash
export BASE="${BASE:-http://localhost:14096}"
MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=()
if [[ -n "${OPENCODE_PASSWORD:-}" ]]; then
  CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
fi
# sse-dump.mjs 需要同样的凭据（脚本不支持 -u，用 Authorization 头）
export SSE_AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64)"

# 创建会话（V2 的 workspace 路由靠 location.directory，不需要目录头）
new_sid() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"sse-v2\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" | jq -r '.data.id'
}

# 异步接纳一条 prompt 并等待会话空闲
send_prompt() {
  local sid="$1" text="$2"
  jq -n --arg text "$text" '{text:$text,metadata:{},delivery:"queue"}' \
    | curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/prompt" \
        -H 'Content-Type: application/json' --data-binary @- > /dev/null
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/experimental/session/$sid/wait" \
    -H 'Content-Type: application/json' -d '{}'
}

# 会话级事件采集（订阅 → 动作 → 断言）
dump_session() {
  SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/session/$1/event" "$2" > "$3"
}
```

> `sse-dump.mjs` 每个 `data:` 帧输出一行 JSON（V2 已是事件对象本身，无 `payload` 层）。

---

### T9.1 事件流：订阅与初始连接事件（`GET /api/event`）

```bash
curl -sS -N --max-time 3 -D - -o /dev/null "${CURL_AUTH[@]}" "$BASE/api/event" \
  | grep -i "content-type\|cache-control"
SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/event" 3 > /tmp/t91.log
head -1 /tmp/t91.log | jq -r '.type'
```
**期望**：`content-type: text/event-stream`、`cache-control: no-cache, no-transform`，首个事件 `server.connected`。

### T9.2 事件流：创建 session 触发事件

```bash
SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/event" 12 > /tmp/t92.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t92.log 2>/dev/null && break; sleep 0.5; done
new_sid > /dev/null
wait $SSE_PID
grep -m1 '"type":"session.created"' /tmp/t92.log | jq -r '.data.sessionID'
```
**期望**：收到 `session.created`，`data.sessionID` 非空。

### T9.3 事件流：心跳机制

> V2 心跳是 SSE 注释 `: heartbeat`（默认 15s），**不是** `server.heartbeat` 事件。`sse-dump.mjs` 会丢弃注释行，因此用原始 curl 断言。

```bash
time curl -sS -N --max-time 20 "${CURL_AUTH[@]}" "$BASE/api/event" 2>/dev/null | grep -c ': heartbeat' || true
```
**期望**：20 秒窗口内出现 `: heartbeat` ≥ 1（首次约 15s 后）。

### T9.4 事件流：不再区分全局/实例端点

> V2 只有 `/api/event`，`x-opencode-directory` 头不再参与路由；事件自带 `location`，需要按目录/会话过滤时用 `GET /api/session/:sessionID/event`。
> 本项为契约说明，与 T9.1 合并验证。

```bash
curl -sS -N --max-time 3 -D - -o /dev/null "${CURL_AUTH[@]}" "$BASE/api/event" | head -1
```
**期望**：HTTP 200 + `text/event-stream`（无需任何目录头）。

### T9.5 事件流：会话消息文本事件

> V2 用 `session.text.started` → `session.text.delta`（ephemeral，仅实时）→ `session.text.ended`（durable，全量文本）表示 assistant 文本；推理文本用 `session.reasoning.*`。

```bash
SID=$(new_sid)
dump_session "$SID" 50 /tmp/t95.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t95.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "说一个字"
wait $SSE_PID

grep -c '"type":"session.text.delta"' /tmp/t95.log
grep -c '"type":"session.text.ended"' /tmp/t95.log
grep -m1 '"type":"session.text.delta"' /tmp/t95.log | jq -r '.data.sessionID'
```
**期望**：`session.text.delta` ≥ 1（`data.sessionID` 为该会话）、`session.text.ended` ≥ 1。

### T9.6 事件流：工具调用生命周期事件

> V2 工具生命周期：`session.tool.input.started`（生成参数）→ `session.tool.input.delta`（参数增量）→ `session.tool.called`（参数就绪、开始执行，含完整 `data.input`）→ `session.tool.success` / `session.tool.failed`。

```bash
SID=$(new_sid)
dump_session "$SID" 90 /tmp/t96.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t96.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "用 shell 执行 echo hello_sse_test"
wait $SSE_PID

python3 -c "
import json
order=[]
for line in open('/tmp/t96.log'):
    line=line.strip()
    if not line: continue
    t=json.loads(line)['type']
    if t.startswith('session.tool.'): order.append(t)
print('tool events:', order)
print('has lifecycle:', 'session.tool.input.started' in order and any(t in order for t in ('session.tool.success','session.tool.failed')))
"
```
**期望**：出现 `session.tool.input.started` 及终态 `session.tool.success` 或 `session.tool.failed`（sandbox 可达时为 `success`）。

### T9.7 事件流：权限请求事件（`permission.asked`）

> **前提**：不要在配置里把相关工具权限设为 `allow`，否则不会产生 `permission.asked`。
> V2 回复端点为 `POST /api/session/:sessionID/permission/:requestID/reply`，body `{"decision":"once|always|reject"}`。

```bash
SID=$(new_sid)
dump_session "$SID" 90 /tmp/t97.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t97.log 2>/dev/null && break; sleep 0.5; done

jq -n '{text:"use the write tool to write hello to /workspace/sse-perm-test.txt",metadata:{},delivery:"queue"}' \
  | curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/prompt" \
      -H 'Content-Type: application/json' --data-binary @- > /dev/null &

for i in $(seq 1 40); do
  PLINE=$(grep -m1 '"type":"permission.asked"' /tmp/t97.log 2>/dev/null)
  if [ -n "$PLINE" ]; then
    RID=$(echo "$PLINE" | jq -r '.data.id')
    curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST \
      "$BASE/api/session/$SID/permission/$RID/reply" \
      -H 'Content-Type: application/json' -d '{"decision":"always"}'
    echo "replied: always ($RID)"
    break
  fi
  sleep 2
done
wait $SSE_PID 2>/dev/null
```
**期望**：收到 `permission.asked`（`data.id` 为请求 ID）并成功回复；若权限已配 `allow`，则无该事件、会话正常完成（两个分支均有效）。

### T9.8 事件流：多会话事件隔离

> V2 用会话级 `GET /api/session/:sessionID/event`，服务端按 sessionID 过滤。

```bash
SID_A=$(new_sid); SID_B=$(new_sid)
dump_session "$SID_A" 60 /tmp/t98.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t98.log 2>/dev/null && break; sleep 0.5; done

send_prompt "$SID_A" "说A" &
send_prompt "$SID_B" "说B" &
wait $SSE_PID

python3 -c "
import json
sids=set()
for line in open('/tmp/t98.log'):
    line=line.strip()
    if not line: continue
    d=json.loads(line)
    sid=d.get('data',{}).get('sessionID')
    if sid: sids.add(sid)
print('sessionIDs in A stream:', sids)
print('isolated:', sids <= {'$SID_A'})
"
```
**期望**：A 的流里只出现 `SID_A`（`SID_B` 零泄漏）。

### T9.9 事件流：回合状态事件

> V2 回合生命周期：`session.inbox.enqueued` → `session.inbox.delivered` → `session.execution.started` → … → `session.execution.succeeded`（或 `failed`/`interrupted`）。
> `session.status`（`busy`/`idle`/`retry`）与 `session.idle` 仍存在于 schema，但 `session.idle` 已标记 deprecated；本服务路径实测以 `session.execution.*` 为准。

```bash
SID=$(new_sid)
dump_session "$SID" 50 /tmp/t99.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t99.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "说一个字"
wait $SSE_PID

python3 -c "
import json
types=[json.loads(l)['type'] for l in open('/tmp/t99.log') if l.strip()]
print('execution.started:', types.count('session.execution.started'))
print('terminal last:', types[-1] if types else None)
"
```
**期望**：出现 `session.execution.started`，最后一个执行类事件为 `session.execution.succeeded`。

### T9.10 事件流：异步接纳 prompt 触发事件

> V2 用 `POST /api/session/:sessionID/prompt` 异步接纳（返回 HTTP 200 与已接纳的 user message，不是 V1 的 204）；事件经 SSE 推送。

```bash
SID=$(new_sid)
dump_session "$SID" 50 /tmp/t910.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t910.log 2>/dev/null && break; sleep 0.5; done

jq -n '{text:"说一个字",metadata:{},delivery:"queue"}' \
  | curl -sS --noproxy '*' "${CURL_AUTH[@]}" -o /tmp/t910-admit.json -w '%{http_code}\n' \
      -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' --data-binary @-
jq -r '.data.id' /tmp/t910-admit.json
wait $SSE_PID

grep -c '"type":"session.text.delta"' /tmp/t910.log
```
**期望**：接纳返回 HTTP 200 且含 `.data.id`；SSE 收到 `session.text.delta`。

### T9.11 事件流：文件变更事件（`filesystem.changed`）

> V2 对应 V1 的 `file.edited`/`file.watcher.updated`：`filesystem.changed`，`data.file` + `data.event`（`add`/`change`/`unlink`）。
> **前提**：sandbox 可达；写项目目录内路径（`/workspace/`）。

```bash
SID=$(new_sid)
dump_session "$SID" 90 /tmp/t911.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t911.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "use the write tool to write hello to /workspace/sse-file-test.txt" &
wait $SSE_PID
grep -m1 '"type":"filesystem.changed"' /tmp/t911.log | jq -c '{file:.data.file,event:.data.event}'
```
**期望**：收到 `filesystem.changed`（sandbox 可达时）。

### T9.12 事件流：dispose 事件

> V2 无 `POST /global/dispose`。相关事件为 `global.disposed` / `location.shutdown`（由服务处置/关闭路径发布）。
> **待补**：当前 HTTP 层无对应触发端点，本项待端点就绪后验证。

```bash
# 待 HTTP 处置端点就绪后执行。
echo "T9.12 待补端点" 
```
**期望**：端点就绪后，收到 `global.disposed` 或 `location.shutdown`，或连接被服务端关闭。

### T9.13 事件流：连接断开后重连

```bash
for n in a b; do
  SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/event" 3 > /tmp/t913$n.log
  head -1 /tmp/t913$n.log | jq -r '.type'
done
```
**期望**：两次连接都收到 `server.connected`。

### T9.14 事件流：多客户端监听同一会话

```bash
SID=$(new_sid)
for c in a b c; do
  SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/session/$SID/event" 55 > /tmp/t914$c.log &
done
for c in a b c; do
  for i in $(seq 1 20); do grep -q server.connected /tmp/t914$c.log 2>/dev/null && break; sleep 0.5; done
done
send_prompt "$SID" "say hello in one sentence"
wait

for c in a b c; do
  echo "client $c: $(grep -c '"type":"session.text' /tmp/t914$c.log) text events, terminal=$(grep -c 'session.execution.succeeded' /tmp/t914$c.log)"
done
```
**期望**：3 个客户端都收到 `server.connected`、≥1 个 `session.text.*` 事件与 `session.execution.succeeded`。

### T9.15 事件流：中途加入的客户端收到后续事件

> **注意**：prompt 不宜过短——SSE 不回放历史，B 必须在执行**进行中**加入才能收到后续事件。

```bash
SID=$(new_sid)
SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/session/$SID/event" 55 > /tmp/t915a.log &
for i in $(seq 1 20); do grep -q server.connected /tmp/t915a.log 2>/dev/null && break; sleep 0.5; done

send_prompt "$SID" "写一段 150 字的中文故事" &
sleep 2
SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/session/$SID/event" 50 > /tmp/t915b.log &
wait

echo "A: $(wc -l < /tmp/t915a.log) events"
echo "B: $(wc -l < /tmp/t915b.log) events"
grep -c '"type":"session.text' /tmp/t915b.log
```
**期望**：B 中途加入后收到 `server.connected` 与后续 `session.text.*`/`session.execution.succeeded`。

### T9.16 事件流：会话重命名与删除事件

> V2 用 `PATCH /api/session/:id`（title）触发 `session.renamed`，`DELETE /api/session/:id` 触发 `session.deleted`（不再有笼统的 `session.updated`）。

```bash
SID=$(new_sid)
dump_session "$SID" 20 /tmp/t916.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t916.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" \
  -H 'Content-Type: application/json' -d '{"title":"sse-renamed"}' > /dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" > /dev/null
wait $SSE_PID

grep -m1 '"type":"session.renamed"' /tmp/t916.log | jq -r '.data.title'
grep -c '"type":"session.deleted"' /tmp/t916.log
```
**期望**：`session.renamed` 的 `data.title=sse-renamed`，`session.deleted` ≥ 1。

### T9.17 事件流：消息内容更新事件

> V2 没有 V1 的 `message.removed`/`message.part.removed`，也没有删除消息的 HTTP 端点。
> 相关事件为 `session.message.content.updated`（replay-only），以及 `GET /api/session/:id/diff` 查询差异。
> 本项标注为 **V2 不适用**，如需消息级删除需另立需求。

### T9.18 事件流：消息完成状态事件

> V2 无 `message.updated`。消息落库后可用 `session.step.ended`（含 `assistantMessageID`/`finish`/`cost`/`tokens`）与 `session.usage.updated` 表示。

```bash
SID=$(new_sid)
dump_session "$SID" 50 /tmp/t918.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t918.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "说一个字"
wait $SSE_PID
grep -c '"type":"session.step.ended"' /tmp/t918.log
```
**期望**：`session.step.ended` ≥ 1。

### T9.19 事件流：回合错误事件

> V2 用 `session.execution.failed`（含 `data.error`）；模型不可用时也可能是 `session.step.failed` 或 `session.retry.scheduled`。非法模型需在**创建会话**时指定。

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"sse-err","location":{"directory":"/workspace"},"model":{"id":"nonexistent-model-xyz","providerID":"Yd-DeepSeek"}}' \
  | jq -r '.data.id' > /tmp/t919-sid
SID=$(cat /tmp/t919-sid)
dump_session "$SID" 60 /tmp/t919.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t919.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "hi"
wait $SSE_PID
grep -m1 '"type":"session.execution.failed"' /tmp/t919.log | jq -c '.data.error'
```
**期望**：收到 `session.execution.failed`（`data.error` 含错误信息）。

### T9.20 事件流：revert/diff 事件

> V2 用 `POST /api/session/:sessionID/revert/stage`（**必须传 `messageID`**）触发 `session.revert.staged`；差异用 `GET /api/session/:sessionID/diff` 查询。

```bash
SID=$(new_sid)
send_prompt "$SID" "hi"
MID=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/message?order=asc&limit=50" \
  | jq -r '[.data[] | select(.type=="user")][0].id')

dump_session "$SID" 20 /tmp/t920.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t920.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/revert/stage" \
  -H 'Content-Type: application/json' -d "{\"messageID\":\"$MID\"}" > /dev/null
wait $SSE_PID
grep -c '"type":"session.revert.staged"' /tmp/t920.log
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/diff" | jq -c '.data | length'
```
**期望**：收到 `session.revert.staged` ≥ 1；`/diff` 返回差异数组（可为空）。

### T9.21 事件流：agent/model 切换事件

> V2 有直接端点：`POST /api/session/:sessionID/model` 与 `POST /api/session/:sessionID/agent`，分别发布 `session.model.selected` / `session.agent.selected`。
> **注意**：只有在值**实际变化**时才发布；创建时已指定同一模型后再 POST 同模型不会产生事件（实测 `session.model.selected`=0）。

```bash
SID=$(new_sid)
dump_session "$SID" 25 /tmp/t921.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t921.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'switchAgent=%{http_code}\n' \
  -X POST "$BASE/api/session/$SID/agent" -H 'Content-Type: application/json' -d '{"agent":"plan"}'
wait $SSE_PID
grep -m1 '"type":"session.agent.selected"' /tmp/t921.log | jq -c '.data'
```
**期望**：`switchAgent` 返回 204，并收到 `session.agent.selected`（`data.agent` 为新 agent）。切到不同模型同理产生 `session.model.selected`。

### T9.22 事件流：命令执行触发事件

> V2 无 `command.executed` 事件；`POST /api/session/:sessionID/command` 会把命令结果作为会话输入接纳，产生 `session.inbox.enqueued`。

```bash
SID=$(new_sid)
dump_session "$SID" 25 /tmp/t922.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t922.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/command" \
  -H 'Content-Type: application/json' -d '{"name":"init","text":""}' > /dev/null
wait $SSE_PID
grep -c '"type":"session.inbox.enqueued"' /tmp/t922.log
```
**期望**：命令执行产生 `session.inbox.enqueued` ≥ 1（`command.executed` 在 V2 不存在）。

### T9.23 事件流：事件 envelope 字段完整性

> ⚠️ 用原始 curl（`sse-dump.mjs` 只保留事件对象，不保留未解析原文）。V2 envelope 为 `{id, created, type, location?, data, durable?}`。

```bash
curl -sS -N --max-time 8 "${CURL_AUTH[@]}" "$BASE/api/event" > /tmp/t923raw.log &
CURL_PID=$!
sleep 2
new_sid > /dev/null
wait $CURL_PID

python3 -c "
import json, re
for line in open('/tmp/t923raw.log'):
    m=re.match(r'data: (.+)', line)
    if not m: continue
    ev=json.loads(m.group(1))
    if ev.get('type')=='session.created':
        print('keys:', sorted(ev.keys()))
        print('has id/type/data:', all(k in ev for k in ('id','type','data')))
        break
"
```
**期望**：`session.created` 事件含 `id`/`created`/`type`/`data`（durable 事件含 `durable`；`location` 视发布路径可有可无）。

### T9.24 事件流：事件 ID 格式

```bash
SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/event" 3 > /tmp/t924.log
python3 -c "
import json, itertools
for line in itertools.islice(open('/tmp/t924.log'), 2):
    d=json.loads(line)
    print(d.get('id','?'), d.get('type','?'))
"
```
**期望**：事件 `id` 为 `evt_*` 前缀；首个类型为 `server.connected`（V2 无 `server.heartbeat` 事件，心跳是注释行）。

### T9.25 事件流：目录头不再是必需

> V2 `/api/event` 不读取 `x-opencode-directory`；会话级流靠路径中的 `:sessionID` 路由。带或不带该头行为一致。

```bash
curl -sS -N --max-time 3 -D - -o /dev/null "${CURL_AUTH[@]}" \
  -H "x-opencode-directory: /workspace" "$BASE/api/event" | head -1
```
**期望**：HTTP 200 + `text/event-stream`（该头被忽略，不影响连接）。

### T9.26 事件流：write 参数早期可用性（running 态预渲染）

> V2 对应 V1 `message.part.updated`(tool running)：工具参数定稿事件是 `session.tool.input.ended`（`data.text` 为原始参数 JSON），随后 `session.tool.called` 携带完整 `data.input` 且 `data.executed`。
> 前端可在收到 `session.tool.called` 时即用 `data.input` 预渲染，早于 `session.tool.success` 与回合结束。

```bash
SID=$(new_sid)
dump_session "$SID" 150 /tmp/t926.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t926.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "use ONLY the write tool (not shell) to create /workspace/prerender-test.html containing a minimal HTML page with title 'sse prerender test'" &
wait $SSE_PID

python3 -c "
import json
input_ended=called=success=None
for n,line in enumerate(open('/tmp/t926.log')):
    if not line.strip(): continue
    d=json.loads(line); t=d['type']; data=d.get('data',{})
    if t=='session.tool.input.ended' and data.get('name','').startswith('write'): input_ended=n
    if t=='session.tool.called' and data.get('input') is not None: called=(n,data['input'])
    if t=='session.tool.success': success=n
print('input_ended',input_ended,'called',called and called[0],'success',success)
assert called, '缺少 session.tool.called'
assert '<html' in json.dumps(called[1]).lower() or 'filePath' in called[1], 'called.input 应含完整参数'
if success is not None: assert called[0] < success, 'called 应早于 success'
print('✅ called 时参数已完整')
"
```
**期望**：`session.tool.called` 早于 `session.tool.success`，且其 `data.input` 已含完整参数（前端可在执行完成前预渲染）。

### T9.27 事件流：工具参数流式增量（`session.tool.input.delta`）

> V2 原生支持：LLM 生成工具参数期间推送 `session.tool.input.delta`（ephemeral，`data.id` 为工具调用 ID，`data.delta` 为参数片段），`session.tool.input.ended` 为定稿。

```bash
SID=$(new_sid)
dump_session "$SID" 150 /tmp/t927.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t927.log 2>/dev/null && break; sleep 0.5; done
send_prompt "$SID" "use ONLY the write tool (not shell) to create /workspace/stream-test.html containing an HTML page with title 'stream test' and three paragraphs" &
wait $SSE_PID

python3 -c "
import json
deltas=[]; ended=None
for n,line in enumerate(open('/tmp/t927.log')):
    if not line.strip(): continue
    d=json.loads(line); t=d['type']; data=d.get('data',{})
    if t=='session.tool.input.delta': deltas.append((n,data.get('id'),data.get('delta') or ''))
    if t=='session.tool.input.ended': ended=(n,data.get('id'))
assert deltas, '缺少 session.tool.input.delta'
assert ended, '缺少 session.tool.input.ended'
raw=''.join(x[2] for x in deltas)
print('deltas=%d ended_line=%d raw_bytes=%d' % (len(deltas), ended[0], len(raw)))
print('all deltas before ended:', max(x[0] for x in deltas) < ended[0])
"
```
**期望**：`session.tool.input.delta` ≥ 1 且全部早于 `session.tool.input.ended`；拼接 `delta` 可还原工具参数。

---

### T9.28 会话事件流：订阅与初始连接事件（`GET /api/session/:sessionID/event`）

> 按会话过滤的 SSE 端点，`sessionID` 在路径中自动路由，无需目录头。

```bash
SID=$(new_sid)
curl -sS -N --max-time 3 -D - -o /dev/null "${CURL_AUTH[@]}" "$BASE/api/session/$SID/event" \
  | grep -i "content-type\|cache-control"
SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/session/$SID/event" 3 > /tmp/t928.log
head -1 /tmp/t928.log | jq -r '.type'
```
**期望**：`content-type` 含 `text/event-stream`、`cache-control` 为 `no-cache, no-transform`；首个事件 `type` 为 `server.connected`。

### T9.29 会话事件流：只推该会话的事件（隔离性）

```bash
SID_A=$(new_sid); SID_B=$(new_sid); sleep 1
dump_session "$SID_A" 12 /tmp/t929.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q server.connected /tmp/t929.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID_A" -H 'Content-Type: application/json' -d '{"title":"sse-a"}' > /dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID_B" -H 'Content-Type: application/json' -d '{"title":"sse-b"}' > /dev/null
wait $SSE_PID

echo "renamed count: $(grep -c '"type":"session.renamed"' /tmp/t929.log) (期望 1)"
grep -m1 '"type":"session.renamed"' /tmp/t929.log | jq -r '.data.sessionID'
echo "B leak: $(grep -c "$SID_B" /tmp/t929.log) (期望 0)"
```
**期望**：`session.renamed` 恰好 1 条且 `data.sessionID` 为 `SID_A`；整份日志中 `SID_B` 出现 0 次。

### T9.30 会话事件流：负向测试（session 不存在）

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -N --max-time 3 "${CURL_AUTH[@]}" \
  "$BASE/api/session/ses_missing/event"
```
**期望**：`404`。

### T9.31 会话事件流：发送 prompt 并跟随事件（`POST /api/session/:sessionID/prompt_stream`）

> 一次请求完成「接纳 prompt」+「跟随该回合事件」；服务端在该输入被投递且执行到达终态后主动关流。

```bash
SID=$(new_sid)
START=$(date +%s)
curl -sS -N --max-time 90 -D /tmp/t931-headers.txt "${CURL_AUTH[@]}" \
  "$BASE/api/session/$SID/prompt_stream" \
  -H 'Content-Type: application/json' \
  -d '{"text":"只回复两个字：收到","metadata":{},"delivery":"queue"}' > /tmp/t931.log
CURL_EXIT=$?
echo "curl_exit=$CURL_EXIT elapsed=$(( $(date +%s) - START ))s"
grep -i "content-type" /tmp/t931-headers.txt

python3 -c "
import re
types=re.findall(r'\"type\":\"([a-z.]+)\"', open('/tmp/t931.log').read())
print('total events:', len(types))
print('first:', types[0] if types else None)
print('terminal last:', types[-1] in ('session.execution.succeeded','session.execution.failed','session.execution.interrupted') if types else False)
"
```
**期望**：`HTTP 200` + `text/event-stream`；流含完整回合事件（`server.connected` → `session.inbox.*` → `session.execution.*`）；**最后一帧为执行终态且 curl_exit=0**（服务端主动关流，而非 `--max-time` 截断）。

### T9.32 会话事件流：prompt_stream 错误路径

> 非法模型需在创建会话时指定；错误回合同样以终态关流，客户端不会挂死。

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"sse-ps-err","location":{"directory":"/workspace"},"model":{"id":"nonexistent-model-xyz","providerID":"Yd-DeepSeek"}}' \
  | jq -r '.data.id' > /tmp/t932-sid
SID=$(cat /tmp/t932-sid)
curl -sS -N --max-time 60 "${CURL_AUTH[@]}" "$BASE/api/session/$SID/prompt_stream" \
  -H 'Content-Type: application/json' -d '{"text":"hi","metadata":{}}' > /tmp/t932.log
echo "curl_exit=$?"
grep -o '"type":"session.execution.failed"' /tmp/t932.log | head -1
python3 -c "
import re
types=re.findall(r'\"type\":\"([a-z.]+)\"', open('/tmp/t932.log').read())
print('terminal last:', types[-1] in ('session.execution.succeeded','session.execution.failed','session.execution.interrupted') if types else False)
"
```
**期望**：流内出现 `session.execution.failed`，且以执行终态结尾、curl_exit=0。

### T9.33 会话事件流：prompt_stream 多会话并发隔离

> **注意**：sessionID 含大写字母，正则字符类须用 `[A-Za-z0-9]`。

```bash
SID_A=$(new_sid); SID_B=$(new_sid)
curl -sS -N --max-time 60 "${CURL_AUTH[@]}" "$BASE/api/session/$SID_A/prompt_stream" \
  -H 'Content-Type: application/json' -d '{"text":"只回复A","metadata":{}}' > /tmp/t933a.log &
PA=$!
sleep 0.3
curl -sS -N --max-time 60 "${CURL_AUTH[@]}" "$BASE/api/session/$SID_B/prompt_stream" \
  -H 'Content-Type: application/json' -d '{"text":"只回复B","metadata":{}}' > /tmp/t933b.log &
PB=$!
wait $PA $PB

python3 -c "
import re
for name,sid,f in [('A','$SID_A','/tmp/t933a.log'),('B','$SID_B','/tmp/t933b.log')]:
    content=open(f).read()
    sids=set(re.findall(r'\"sessionID\":\"(ses_[A-Za-z0-9]+)\"', content))
    types=re.findall(r'\"type\":\"([a-z.]+)\"', content)
    terminal=types[-1] in ('session.execution.succeeded','session.execution.failed','session.execution.interrupted') if types else False
    print(f'{name}: terminal-last={terminal}, cross-leak={sids-{sid} or \"none\"}')
"
```
**期望**：A/B 两条流各自 `sessionID` 集合只含本会话（cross-leak=none），均以执行终态结尾。

### T9.34 会话事件流：prompt_stream 负向测试（session 不存在）

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -N --max-time 3 "${CURL_AUTH[@]}" \
  -X POST "$BASE/api/session/ses_missing/prompt_stream" \
  -H 'Content-Type: application/json' -d '{"text":"hi","metadata":{}}'
```
**期望**：`404`。

### T9.35 会话事件流：断连续传（`GET /api/experimental/session/:sessionID/log`）

> V2 的 durable 事件本应按聚合序号补发：`GET /api/experimental/session/:sessionID/log?after=<seq>&follow=<bool>`。
> `after` 为**排他**游标，必须 ≥ 0（`after=-1` 返回 400）；读取到达水位时发出一次 `log.synced`；与 V1 不同，该端点**不含** `server.connected`。
>
> **配置相关**：durable 事件是否持久化由 `events.persist` 控制；SaaS 容器通过 `OPENCODE_EVENTS_PERSIST` 配置。未启用时 event 表为空，补发无历史事件；启用后应验证 PG 落库与 `?after=` 补发。

```bash
SID=$(new_sid)
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" \
  -H 'Content-Type: application/json' -d '{"title":"t935-gap"}' > /dev/null

SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs \
  "$BASE/api/experimental/session/$SID/log?after=0&follow=false" 3 > /tmp/t935c.log
python3 -c "
import json
events=[json.loads(l) for l in open('/tmp/t935c.log') if l.strip()]
print('types:', [e['type'] for e in events])
print('renamed:', len([e for e in events if e['type']=='session.renamed']))
"
curl -sS -o /dev/null -w "after=-1: %{http_code}\n" --max-time 3 "${CURL_AUTH[@]}" \
  "$BASE/api/experimental/session/$SID/log?after=-1"
curl -sS -o /dev/null -w "after=abc: %{http_code}\n" --max-time 3 "${CURL_AUTH[@]}" \
  "$BASE/api/experimental/session/$SID/log?after=abc"
```
**期望**：非法 `after`（负数/非数字）返回 `400`；持久化开启时，`after=0` 应补发 `seq>0` 的 durable 事件（`session.renamed` 恰 1 条）。

### T9.36 会话事件流：断连续传并发窗口（补发/实时不丢不重）

> 持久化未开启时无法验证本用例；应在 `events.persist=true` 的环境中检查补发与实时窗口无丢失、无重复。

```bash
SID=$(new_sid)
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' -d '{"title":"t936-1"}' > /dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' -d '{"title":"t936-2"}' > /dev/null

SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs \
  "$BASE/api/experimental/session/$SID/log?after=0&follow=true" 12 > /tmp/t936.log &
SSE_PID=$!
for i in $(seq 1 20); do grep -q log.synced /tmp/t936.log 2>/dev/null && break; sleep 0.5; done
for i in 1 2 3; do
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" \
    -H 'Content-Type: application/json' -d "{\"title\":\"t936-c$i\"}" > /dev/null
done
wait $SSE_PID

python3 -c "
import json
seqs=sorted(json.loads(l).get('durable',{}).get('seq') for l in open('/tmp/t936.log') if l.strip() and json.loads(l)['type']=='session.renamed')
print('renamed seqs:', seqs)
print('✅ 零丢失零重复' if seqs==[1,2,3,4,5] else '⚠️ 未落库，等待持久化后复测')
"
```
**期望**：本例产生的 `session.renamed` 的 `durable.seq` 连续，补发与实时各一次，无丢失、无重复。

### T9.37 会话事件流：会话过滤语义单测

> V2 的会话级事件过滤由 `packages/server/src/session-stream.ts` 的 `sessionEventFilter` 实现，`EventFeed` 按订阅者过滤后再编码。
> 单测覆盖：`packages/server/test/session-stream.test.ts`（过滤 + prompt_stream 关流判定）与 `packages/server/test/event-feed.test.ts`（过滤订阅不改变全局订阅、被过滤事件不编码/不占容量）。

```bash
cd packages/server && bun test test/session-stream.test.ts test/event-feed.test.ts
```
**期望**：全部通过，覆盖
1. `sessionEventFilter`：匹配 / 其他会话 / 无 sessionID / 非对象载荷
2. `makePromptStreamTakeUntil`：未投递不结束、其他 inbox 不结束、投递后三个终态各结束一次、心跳与坏 JSON 忽略
3. `EventFeed`：过滤订阅不改变全局订阅、无订阅接受时不编码、被过滤事件不占用容量

---

## 测试结果（V2）

此前的逐项实测记录如下；更近期的 SSE smoke 复测见表后补充记录。

| 用例 | 结果 | 备注 |
|------|------|------|
| T9.1 | ✅ | 200 + `text/event-stream` + `no-cache, no-transform`；首帧 `server.connected` |
| T9.2 | ✅ | 全局流收到 `session.created`，`data.sessionID` 与新建会话一致 |
| T9.3 | ✅ | 20s 窗口内 `: heartbeat` × 2（注释行，非事件） |
| T9.13 | ✅ | 两次连接均首帧 `server.connected` |
| T9.16 | ✅ | `session.renamed`（`data.title=sse-renamed`）+ `session.deleted` ×1 |
| T9.21 | ✅ | `switchAgent` 204 → `session.agent.selected`（`data.agent=plan`）；同模型切换不发布 |
| T9.23 | ✅ | `session.created` envelope keys = `created/data/durable/id/location/type` |
| T9.24 | ✅ | `id` 为 `evt_*`；首帧 `server.connected` |
| T9.28 | ✅ | 200 + `text/event-stream` + `no-cache, no-transform`；首帧 `server.connected` |
| T9.29 | ✅ | `session.renamed` 恰 1 条且属 `SID_A`，`SID_B` 零泄漏 |
| T9.30 | ✅ | 不存在 sessionID → 404 |
| T9.31 | ✅ | 200 + SSE，15 事件，末帧 `session.execution.succeeded`，服务端主动关流（0.8s） |
| T9.32 | ✅ | 非法模型 → `session.execution.failed` 后关流 |
| T9.33 | ✅ | A/B 并发各自关流，`sessionID` 零交叉 |
| T9.34 | ✅ | 不存在 sessionID → 404 |
| 附加 | ✅ | `prompt_stream` 非法 payload → 400 |
| T9.35 | ⚠️ 当时阻塞 | 当时服务未启用 durable event 持久化；不能据此判断开启持久化时的回放功能 |
| T9.36 | ⚠️ 当时未验证 | 当时服务未启用 durable event 持久化 |
| T9.37 | ✅ | `session-stream.test.ts` + `event-feed.test.ts` 合计 21 通过（`--rerun-each 5` 稳定） |

PG 核验：上述历史测试时 `event_sequence` 有水位记录，但 `event` 表为 0 行；此结论只代表该次运行配置。

### 2026-09-30 SSE API smoke 复测

使用独立 Docker 容器 `opencode-sse-tmp`（14102）、隔离 PG `opencode-v2-test`，设置 `OPENCODE_EVENTS_PERSIST=true`，通过 `docs/test-cases/scripts/sse-smoke-v2.mjs` 和真实 HTTP API 验证：

| 覆盖项 | 结果 | 证据 |
|---|---|---|
| T9.1/T9.2 全局连接及创建事件 | ✅ | `server.connected` 与对应 `session.created` 均收到 |
| T9.5 文本事件 | ✅ | `session.text.delta` 与 `session.text.ended` 均收到 |
| T9.9/T9.31 执行生命周期 | ✅ | `prompt_stream` 末事件为 `session.execution.succeeded` |
| T9.29 会话隔离 | ✅ | 会话流未出现其他 sessionID |
| T9.35 durable 落库与补发 | ✅ | PG 该会话 `event` 行 13 条；`after=0&follow=false` 回放 13 个事件，含执行成功事件 |
| T9.36 replay + live 并发窗口 | 未完成 | 本轮 smoke 脚本等待 `follow=true` 的 `log.synced` 时超时，尚未确认 HTTP 层并发窗口行为；Core `session-log.test.ts` / `bus.test.ts` 对回放交接有覆盖 |

本轮单测：`packages/server/test/session-stream.test.ts` 与 `event-feed.test.ts` **21 pass**；`packages/core/test/session-log.test.ts` 与 `bus.test.ts` **58 pass**。成功 smoke 产生的测试会话由脚本通过 API 删除；探索 `follow=true` 时中断的 3 个测试会话按确切 ID 从隔离库清理，PG session 行数恢复为运行前的 14；临时容器已清理。

> T9.4–T9.12、T9.14、T9.15、T9.17–T9.20、T9.22、T9.25–T9.27、T9.31–T9.34 及 T9.5/T9.6 等已按 V2 契约改写，命令可直接执行，但尚未在本轮全部实跑（其中 T9.5/T9.6/T9.11/T9.26/T9.27 依赖真实 LLM 与 sandbox）。执行时若与期望不符，按上面的 V1→V2 对照表核对事件名与端点。

## 2026-10-25 阿里云后端全量复测

环境：镜像 `opencode-saas:aliyun-sse-fixed-20261025`（含本轮 tool-input-delta 接线修复）、独立 PG `opencode-v2-sse-test`、`OPENCODE_EVENTS_PERSIST=1`、阿里云 `base-5wa5`、`deepseek/deepseek-flash`。执行器 `docs/test-cases/scripts/sse-v2-full.mjs` 按本文逐条断言（订阅→动作→断言，含原始心跳注释行、envelope 原文、replay+live 窗口、负向 404）。**结果：32 PASS / 2 N-A / 1 偏差**：

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T9.1/T9.4/T9.25 | ✅ | 200 + `text/event-stream` + `no-cache, no-transform`；首帧 `server.connected`；目录头被忽略 |
| T9.2 | ✅ | 全局流 `session.created`，`data.sessionID` 一致 |
| T9.3 | ✅ | 20s 窗口 `: heartbeat` ×2（注释行） |
| T9.5/T9.10 | ✅ | `text.delta`/`text.ended`；异步接纳 HTTP 200 + `msg_*` |
| T9.6 | ✅ | `input.started → input.delta → input.ended → called → success` |
| T9.7 | ✅ | 权限默认放行分支：回合正常完成 |
| T9.8/T9.29 | ✅ | 会话流隔离：A 流仅自身，`renamed` 恰 1 条，B 零泄漏 |
| T9.9 | ✅ | 末个执行事件 `session.execution.succeeded` |
| T9.11 | ✗ 偏差 | 沙箱内写 `/workspace` 不产生 `filesystem.changed`（见下） |
| T9.12/T9.17 | N/A | 文档标注待补/不适用 |
| T9.13 | ✅ | 两次重连首帧均 `server.connected` |
| T9.14 | ✅ | 3 客户端各收到 text×3 + 终态 |
| T9.15 | ✅ | B 中途加入（54 事件、7 text）含终态 |
| T9.16 | ✅ | `renamed(title=sse-renamed)` + `deleted` ×1（等沙箱 running 后再 DELETE） |
| T9.18 | ✅ | `session.step.ended` ×1 |
| T9.19/T9.32 | ✅ | 非法模型 → `execution.failed`（data.error / 流内终态关流） |
| T9.20 | ✅ | `revert.staged` ×1；`/diff` 返回数组 |
| T9.21/T9.22 | ✅ | `agent.selected(plan)`（204）；命令 → `inbox.enqueued` |
| T9.23/T9.24 | ✅ | envelope 含 `id/created/type/data/durable/location`；`evt_*` 前缀 |
| T9.26 | ✅ | `tool.called` 早于 `success` 且 `input` 完整 |
| T9.27 | ✅ 修复后 | `input.delta` ×4（449 字节）全部早于 `input.ended`（见下） |
| T9.28/T9.30/T9.34 | ✅ | 会话流头；不存在 sessionID → 404（流与 prompt_stream） |
| T9.31/T9.33 | ✅ | prompt_stream 服务端主动关流、末帧终态；并发隔离零交叉 |
| T9.35 | ✅ | `after=0` 补发（PG event 2 行）；`after=-1`/`abc` → 400 |
| T9.36 | ✅ 缺口关闭 | `follow=true` 收到 `log.synced`；renamed seq `[1,2,3,4,5]` 连续无重（补发 2 + 实时 3） |
| T9.37 | ✅ | `session-stream` + `event-feed` 22 pass；本轮另有 runner 工具事件单测 24 pass |

### 本轮两项产品决定（需知悉）

1. **`session.tool.input.delta` 接线补齐（T9.27）**：schema 早已定义、CLI/TUI 有消费端，但 runner 创建 toolInput fragments 时未传 delta 发布器，事件从不发布；`session-runner-tool-events.test.ts` 原断言「累积不发布」与本契约及消费端矛盾。已补上发布（ephemeral、100ms 批量、end 前冲刷）并把该单测翻转为「批量发布且早于 ended」。
2. **T9.11 架构边界（未修改产品）**：`filesystem.changed` 由宿主机 LocationWatcher 发布，watch 目标仅 VCS 元数据（`.git/HEAD`、`.hg/branch`）；沙箱 `/workspace` 内的 AI 写入不经过宿主文件系统，本就不产生该事件。原文期望需产品层决策（桥接沙箱 watch 或改文档），本轮仅记录。

另：T9.35/36 此前因服务未开持久化而阻塞，本轮 `OPENCODE_EVENTS_PERSIST=1` 下全部通过；2026-09-30 记录的「follow=true 等待 log.synced 超时」未复现，缺口 #1 关闭。

执行器要点：新库需导入 `credential` 表模型路由才可用；Dumper 需实现时长定时器（SSE 服务端不会主动关 `/api/event`）；T9.16 必须等沙箱 `running` 再 DELETE，否则 409。

## 需要讨论的 V2 缺口

1. **T9.36 HTTP follow 行为**：~~本轮 HTTP smoke 等待 `follow=true` 的 `log.synced` 超时~~ 2026-10-25 已在 `OPENCODE_EVENTS_PERSIST=1` 阿里云环境通过（`log.synced` 正常、seq `[1..5]` 连续无重），缺口关闭。
2. **无 dispose 端点**（T9.12）：`global.disposed` / `location.shutdown` 事件存在，但 HTTP 层没有触发入口；是否需要补一个处置端点。
3. **无消息删除**（T9.17）：V2 没有删除消息/part 的端点与 `message.removed` 事件；`session.message.content.updated` 为 replay-only。如需前端撤销消息，需要新端点。
4. **`session.idle` 已 deprecated**（T9.9）：当前服务路径以 `session.execution.succeeded/failed/interrupted` 判定回合结束；是否统一弃用 `session.idle`。
5. **命令事件**（T9.22）：V2 无 `command.executed`，命令执行合并进 `session.inbox.*`；如前端需要命令维度事件，需要新增。
