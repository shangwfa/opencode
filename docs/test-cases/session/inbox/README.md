# V2 Session Inbox（会话待处理输入队列）

> Inbox 是会话的「忙时收件箱 + 转向控制」：prompt 提交后先进 `session_inbox` 持久化，
> 由执行器在安全边界（step boundary / idle boundary）统一消费，投递后成为正式消息。
> 实现依据：`packages/core/src/session/inbox.ts`（admit/promote/cancel/steer/queue）、
> `packages/core/src/session/session.ts:148-188`（prompt→admit→wake）、
> `packages/core/src/session/run-coordinator.ts`（wake/doorbell 语义）、
> 迁移 `20260812181746_session_inbox`（PG 表，pending-only）。
> API 契约：`packages/protocol/src/groups/session.ts:938-981`、事件 `packages/schema/src/session-event.ts:217-246`。

## 核心语义（用例断言依据）

| 维度 | 语义 | 代码依据 |
|---|---|---|
| prompt 默认 delivery | `steer`（`input.delivery ?? "steer"`） | `session.ts:175` |
| `resume:false` | 入队但**不 wake**，消息停留 inbox —— 最稳定的测试钩子 | `session.ts:187` |
| 投递顺序 | steer 优先于 queue；同类内按 `enqueued_seq` FIFO | `inbox.ts:533-568`（promote） |
| 控制项 | `compaction`/`move` 不是普通输入，promote 让 runner 先处理；compact 默认 steer（step boundary 运行，排在 queued prompts 之前） | `inbox.ts:544,558`；`protocol session.ts:550` |
| PATCH→steer | 修改投递模式为 steer 会 **wake** 会话执行；→queue 不 wake | `session.ts:133-142` |
| cancel | 未投递项可删；**不可用项是 no-op**（不报错，204） | handler `session.ts:874-882` |
| 幂等 | 同 id 且仍在 inbox → reconcile 返回已有项，不重复入队；同 id 已投递为 message → 409 PromptConflict | `inbox.ts:156-168`；`session.ts:180-184` |
| PATCH 已投递项 | 409（`Pending input cannot change to ...`） | handler `session.ts:87-93` |
| PG pending-only | 投递即删行，表中只存未消费项；`(session_id, enqueued_seq)` 唯一；FK `ON DELETE CASCADE` | `inbox.ts:361-373`；迁移 |
| SSE 事件 | `session.inbox.enqueued`（含 item）→ `delivered` / `cancelled` / `delivery.changed` | `session-event.ts` |

**HTTP API**：

| 端点 | 语义 |
|---|---|
| `POST /api/session/:sid/prompt` | 入队一条 user 输入；payload 含 `delivery`（默认 steer）、`resume`（默认 true）、`id`（消息 ID，幂等键）；响应 `{data: <inbox item>}` |
| `GET /api/session/:sid/inbox` | 列出未投递项（user/synthetic/compaction/move），按入队序 |
| `PATCH /api/session/:sid/inbox/:inboxID` | `{delivery:"steer"\|"queue"}` 切换投递模式；steer 唤醒执行 |
| `DELETE /api/session/:sid/inbox/:inboxID` | 取消未投递项；不可用项 no-op |
| `POST /api/session/:sid/compact` | 入队 compaction 控制项（默认 steer） |
| `POST /api/session/:sid/move` | 入队 move 控制项（目标 location） |
| `POST /api/experimental/session/:sid/wait` | 阻塞等待会话空闲 |
| `GET /api/session/:sid/message` | 消息历史（验证投递后可见性） |
| `GET /api/session/:sid/event`（SSE） | 会话级事件流（过程断言） |

## 前置条件与通用变量

```bash
source docs/test-cases/test-env.sh   # BASE / OPENCODE_PASSWORD / PG_URL / V2_MODEL

CURL_AUTH=()
[[ -n "$OPENCODE_PASSWORD" ]] && CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
export SSE_AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64)"

# 建会话（沙箱 + /workspace）
new_sid() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"inbox-t\",\"location\":{\"directory\":\"/workspace\"},\"model\":$V2_MODEL}" | jq -r '.data.id'
}

# 入队一条输入。用法: inbox_put <sid> <text> [delivery] [resume] [id]
inbox_put() {
  local sid="$1" text="$2" delivery="${3:-steer}" resume="${4:-true}" mid="${5:-}"
  jq -n --arg text "$text" --arg delivery "$delivery" --argjson resume "$resume" --arg id "$mid" \
    '{text:$text, metadata:{}, delivery:$delivery, resume:$resume} + (if $id == "" then {} else {id:$id} end)' \
    | curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/prompt" \
        -H 'Content-Type: application/json' --data-binary @-
}

# 入队但不消费（停留 inbox，制造稳定待处理态）
park() { inbox_put "$1" "$2" "${3:-queue}" false; }

# 忙碌制造：一条长任务（模型会调 bash 执行 sleep，约 30s）
busy_prompt() {
  inbox_put "$1" '依次运行 sleep 25 和 echo busy-done，然后报告输出。不要做别的事。' steer true
}

# PG 待处理项
pg_inbox() {
  psql "$PG_URL" -P pager=off -c \
    "SELECT id, type, delivery, enqueued_seq FROM session_inbox WHERE session_id='$1' ORDER BY enqueued_seq;"
}

# SSE 过程采集（先订阅 → 动作 → 断言；遵循 streaming-output-spec.md）
# 用法: dump_session <sid> <seconds>，输出由调用方重定向到文件
dump_session() {
  SSE_AUTH="$SSE_AUTH" bun docs/test-cases/scripts/sse-dump.mjs "$BASE/api/session/$1/event" "$2"
}
wait_idle() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/experimental/session/$1/wait" \
    -H 'Content-Type: application/json' -d '{}'
}
```

执行期间遵守 `docs/test-cases/skills/streaming-output-spec.md`：SSE 实时观察执行过程，
模型 `question` 提问按规范自动代答；本专项多数用例不触发表单，出现时按规范处理。

---

## T1 入队与消费基础

### T1.1 空闲会话：默认 steer 提交即入队、被消费

```bash
sid=$(new_sid)
dump_session "$sid" 25 > /tmp/t11.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t11.log 2>/dev/null && break; sleep 0.5; done
inbox_put "$sid" '只回答：收到' > /tmp/t11.json
wait $SSE_PID
jq -r '.data.delivery' /tmp/t11.json          # 响应是入队后的 inbox item
grep -m1 'session.inbox.enqueued' /tmp/t11.log | jq -r '.data.item.delivery'
grep -c 'session.inbox.delivered' /tmp/t11.log
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq '.data | length'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=user" | jq '.data | length'
pg_inbox "$sid"
```

**期望**：
- 结果：prompt 响应 `.data.delivery == "steer"`（默认值）；消息历史出现 1 条 user 消息。
- 过程：SSE 依次出现 `session.inbox.enqueued`（`data.item.delivery=="steer"`）→ `session.execution.started` → `session.inbox.delivered` → `session.execution.succeeded`（入队即 wake，空闲态立即消费；实测顺序 started 先于 delivered）。
- PG：`session_inbox` 该会话 **0 行**（pending-only，投递即删）。

### T1.2 `resume:false`：入队但不唤醒（稳定待处理态）

```bash
sid=$(new_sid)
dump_session "$sid" 8 > /tmp/t12.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t12.log 2>/dev/null && break; sleep 0.5; done
park "$sid" 'parked-1' > /dev/null
park "$sid" 'parked-2' > /dev/null
wait $SSE_PID
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq -r '.data[] | "\(.type) \(.delivery)"'
pg_inbox "$sid"
grep -c 'session.execution.started' /tmp/t12.log
```

**期望**：
- 结果：inbox 列表 2 项，均 `type=user delivery=queue`，顺序与提交一致。
- 过程：SSE 出现 2 次 `session.inbox.enqueued`，**0 次** `session.inbox.delivered`、**0 次** `session.execution.started`（resume:false 不 wake）。
- PG：`session_inbox` 恰 2 行，`enqueued_seq` 递增。

### T1.3 inbox 项结构契约

```bash
sid=$(new_sid); park "$sid" 'shape-check' > /tmp/t13.json
jq -r '.data | {id, sessionID, type, delivery, time: .time.created}' /tmp/t13.json
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" \
  | jq '.data[0] | {id, sessionID, type, delivery, text: .payload.text, hasTime: (.time.created != null)}'
```

**期望**：响应与列表项同构：`id`（`ses_*` 消息 ID 格式）、`sessionID`、`type=="user"`、`delivery=="queue"`、`payload.text` 为提交文本、`time.created` 非空（PublicInboxInfo 契约）。

---

## T2 投递模式：queue 与 steer

### T2.1 queue：忙碌中提交，当前轮结束后才投递（新 turn）

```bash
sid=$(new_sid)
dump_session "$sid" 90 > /tmp/t21.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t21.log 2>/dev/null && break; sleep 0.5; done
busy_prompt "$sid" > /dev/null
sleep 6                                        # 等第一轮进入执行（工具 sleep 25 运行中）
inbox_put "$sid" '第二轮：只回答：B' queue true > /dev/null
echo "enqueued=$(grep -c 'session.inbox.enqueued' /tmp/t21.log) delivered=$(grep -c 'session.inbox.delivered' /tmp/t21.log)"
wait $SSE_PID
jq -r 'select(.type=="session.inbox.delivered" or .type=="session.execution.started" or .type=="session.execution.succeeded") | .type' /tmp/t21.log
```

**期望**：
- 结果：busy 提交期间 enqueued=2 / delivered=1（第 2 条停留）；最终消息历史含两条 user 消息且模型在第一条任务完成后才响应 B。
- 过程：第 2 条的 `session.inbox.delivered` 出现在第一段回复 `session.text.ended` 之后、**同一个** `session.execution` 内（queue 的 wake 按响 doorbell，drain 完成当前工作后续跑，不开启新 execution；对照 T2.2 steer 在任务中途投递）。实测事件序：`started → delivered(1) → tool.success → text.ended → delivered(2) → text.ended → succeeded`。
- PG：结束后 `session_inbox` 0 行。

### T2.2 steer：忙碌中提交，中途投递（同 turn）

```bash
sid=$(new_sid)
dump_session "$sid" 90 > /tmp/t22.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t22.log 2>/dev/null && break; sleep 0.5; done
busy_prompt "$sid" > /dev/null
sleep 6
inbox_put "$sid" '补充：结束后顺带说明你看到了这条补充。' steer true > /dev/null
wait $SSE_PID
jq -r 'select(.type=="session.inbox.delivered" or .type=="session.execution.succeeded") | "\(.type) \(.created // .data.created // "")"' /tmp/t22.log | head -5
# assistant 文本在 content[] 中（type=="text" 的 part）
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | grep -m1 'SEEN-STEER'
```

**期望**：
- 结果：最终回复提及看到了补充指令（steer 进入当前轮上下文）。
- 过程：第 2 条的 `session.inbox.delivered` 发生在 `session.execution.succeeded` **之前**（step boundary 投递，同一 turn；对照 T2.1）。
- PG：结束后 `session_inbox` 0 行。

### T2.3 PATCH steer→queue：改投递模式、不唤醒

```bash
sid=$(new_sid)
park "$sid" 'will-demote' steer > /tmp/t23.json
iid=$(jq -r '.data.id' /tmp/t23.json)
dump_session "$sid" 6 > /tmp/t23.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t23.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$sid/inbox/$iid" \
  -H 'Content-Type: application/json' -d '{"delivery":"queue"}'
wait $SSE_PID
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq -r '.data[0].delivery'
grep -c 'session.inbox.delivery.changed' /tmp/t23.log
grep -c 'session.execution.started' /tmp/t23.log
```

**期望**：
- 结果：PATCH 204；inbox 该项 `delivery` 变为 `queue`。
- 过程：SSE 出现 `session.inbox.delivery.changed`（`data.delivery=="queue"`）；**无** `session.execution.started`（queue 不 wake，注意 park 已保证不消费前提下的对照）。
- PG：行仍在，`delivery='queue'`。

### T2.4 PATCH queue→steer：改模式并唤醒消费

```bash
sid=$(new_sid)
park "$sid" 'will-promote' queue > /tmp/t24.json
iid=$(jq -r '.data.id' /tmp/t24.json)
dump_session "$sid" 40 > /tmp/t24.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t24.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$sid/inbox/$iid" \
  -H 'Content-Type: application/json' -d '{"delivery":"steer"}'
wait $SSE_PID
jq -r 'select(.type | startswith("session.inbox")) | .type' /tmp/t24.log
pg_inbox "$sid"
```

**期望**：
- 结果：PATCH 204 后该条被消费，成为 user 消息（`GET message` 可见）。
- 过程：SSE 依次 `session.inbox.delivery.changed`（`data.delivery=="steer"`）→ `session.inbox.delivered` → `session.execution.started`（**steer 唤醒执行**，从 park 态直接驱动）。
- PG：`session_inbox` 0 行（被消费）。

---

## T3 取消

### T3.1 取消停留中的项

```bash
sid=$(new_sid)
park "$sid" 'to-cancel' > /tmp/t31.json
iid=$(jq -r '.data.id' /tmp/t31.json)
dump_session "$sid" 8 > /tmp/t31.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t31.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$sid/inbox/$iid" -o /dev/null -w '%{http_code}\n'
wait $SSE_PID
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq '.data | length'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message" | jq '[.data[]] | length'
pg_inbox "$sid"
grep -c 'session.inbox.cancelled' /tmp/t31.log
```

**期望**：
- 结果：DELETE 返回 204；inbox 0 项；消息历史 0 条（取消的输入**不**进入历史）。
- 过程：SSE 出现 `session.inbox.cancelled`（`data.inboxID` 匹配）；无 `delivered`、无 `execution.started`。
- PG：`session_inbox` 0 行。

### T3.2 取消不存在的项：no-op

```bash
sid=$(new_sid)
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$sid/inbox/msg_nonexistent00" \
  -o /dev/null -w '%{http_code}\n'
```

**期望**：204（不可用项是 no-op，不是 404/409；handler 吞掉 InboxConflictError）。

---

## T4 幂等与冲突

### T4.1 同 id 重复提交（仍在 inbox）：幂等

```bash
sid=$(new_sid)
inbox_put "$sid" 'idem' queue false "msg_idem001" > /tmp/t41a.json
inbox_put "$sid" 'idem' queue false "msg_idem001" > /tmp/t41b.json
jq -r '.data.id' /tmp/t41a.json; jq -r '.data.id' /tmp/t41b.json
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq '.data | length'
pg_inbox "$sid"
```

**期望**：两次响应 `.data.id` 均为 `msg_idem001`（采用调用方 id）；inbox 仅 **1** 项；PG 仅 1 行（reconcile 幂等，不重复入队）。
（注意：勿用 `park` 辅助函数做此用例——它不透传 id 参数。）

### T4.2 同 id 重复提交（已投递为消息）：幂等返回原消息

```bash
sid=$(new_sid)
inbox_put "$sid" '只回答：好' queue true "msg_dup001" > /dev/null
wait_idle "$sid"
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"text":"重复使用已投递ID","delivery":"queue","resume":false,"id":"msg_dup001"}' \
  -o /tmp/t42.json -w '%{http_code}\n'; jq -c '.data | {id, text, created: .time.created}' /tmp/t42.json
```

**期望**：200；`.data` 为**原消息**（text 仍是首次提交文本、created 为原时间戳）——网络重试安全（不重复入队、不重复执行）。已投递 id 的 reconcile 命中 `promotedFromMessage` 幂等路径（`inbox.ts:156-168`）。

```bash
# 跨会话同 id → 409（LifecycleConflict：sessionID 不匹配）
sidB=$(new_sid)
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sidB/prompt" \
  -H 'Content-Type: application/json' \
  -d '{"text":"跨会话冲突","delivery":"queue","resume":false,"id":"msg_dup001"}' \
  -o /tmp/t42b.json -w '%{http_code}\n'
```

**期望**：409 ConflictError；会话 B 的 inbox 不新增（冲突不落队）。

### T4.3 PATCH 已投递项：409

```bash
sid=$(new_sid)
inbox_put "$sid" '只回答：好' queue true "msg_gone001" > /dev/null
wait_idle "$sid"
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$sid/inbox/msg_gone001" \
  -H 'Content-Type: application/json' -d '{"delivery":"steer"}' \
  -o /tmp/t43.json -w '%{http_code}\n'; jq -r '.message // empty' /tmp/t43.json
```

**期望**：409（`Pending input cannot change to steer`；已投递项不再是 pending）。

---

## T5 消费顺序与控制项

### T5.1 多条 queue 按 enqueued_seq FIFO 消费

```bash
sid=$(new_sid)
park "$sid" 'FIFO-1' queue > /dev/null; park "$sid" 'FIFO-2' queue > /dev/null; park "$sid" 'FIFO-3' queue > /dev/null
pg_inbox "$sid"
# 三条 queue 停留后，用一条 resume:true 的输入唤醒 drain，观察消费顺序
dump_session "$sid" 120 > /tmp/t51.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t51.log 2>/dev/null && break; sleep 0.5; done
inbox_put "$sid" '请按顺序复述你收到的所有编号（FIFO-x），一行一个。' steer true > /dev/null
wait $SSE_PID
jq -r 'select(.type=="session.inbox.delivered") | .data.inboxID' /tmp/t51.log > /tmp/t51.iids
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=user&order=asc" \
  | jq -r '.data[] | .text' | head -4
pg_inbox "$sid"
```

**期望**：
- 结果：user 消息顺序为 **驱动条（steer）→ FIFO-1 → FIFO-2 → FIFO-3**。注意：steer 类整体先于 queue 类投递（见 T5.2），FIFO 只在**同 delivery 类内**成立——queue 三条严格按 enqueued_seq 顺序。
- 过程：`session.inbox.delivered` 依次为驱动条、FIFO-1、FIFO-2、FIFO-3。
- PG：结束后 0 行。

### T5.2 steer 优先于 queue（后入队的 steer 先投递）

```bash
sid=$(new_sid)
park "$sid" 'QUEUE-first' queue > /dev/null
park "$sid" 'STEER-late' steer > /dev/null
dump_session "$sid" 60 > /tmp/t52.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t52.log 2>/dev/null && break; sleep 0.5; done
inbox_put "$sid" 'TRIGGER' steer true > /dev/null   # resume:true 唤醒 drain
wait $SSE_PID
# 首个 delivered 的 inboxID 对应哪条？
iid1=$(jq -r 'select(.type=="session.inbox.delivered") | .data.inboxID' /tmp/t52.log | head -1)
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message/$iid1" | jq -r '.data.text'
```

**期望**：首个投递项是 `STEER-late`（steer 类先于 queue 类投递，尽管入队更晚）；随后才是 `QUEUE-first`；PG 最终 0 行。
（说明：TRIGGER 与 STEER-late 同为 steer，二者按 seq 排序；断言点是 steer 类整体先于 queue 类。）

### T5.3 compact：控制项默认 steer，优先于 queued prompts

```bash
sid=$(new_sid)
# 先积累真实上下文（否则压缩报 compaction.unavailable: Nothing to compact yet）
inbox_put "$sid" '介绍一下你自己，两三句话即可' steer true > /dev/null
wait_idle "$sid"
park "$sid" 'queued-before-compact' queue > /dev/null
dump_session "$sid" 120 > /tmp/t53.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t53.log 2>/dev/null && break; sleep 0.5; done
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/compact" \
  -H 'Content-Type: application/json' -d '{}' | jq -r '.data.type'
wait $SSE_PID
jq -r 'select(.type | startswith("session.inbox") or startswith("session.compaction")) | "\(.created) \(.type)"' /tmp/t53.log
pg_inbox "$sid"
```

**期望**：
- 结果：compact 响应 `.data.type=="compaction"`、`delivery=="steer"`；压缩完成（`compaction.ended`；空会话会得到 `compaction.unavailable: Nothing to compact yet`，属预期拒绝，因此先积累一轮对话）。
- 过程：SSE 出现 compaction 项的 `session.inbox.enqueued/delivered`，且 `session.compaction.started → ended` 发生在 queued prompt 的 `delivered` 之前（steer 默认，控制项优先于 queued prompts）。
- PG：结束后 0 行。

### T5.4 move：控制项入队可见

```bash
sid=$(new_sid)
park "$sid" 'keep-busy-marker' queue > /dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/move" \
  -H 'Content-Type: application/json' -d '{"directory":"/tmp/inbox-move-target"}' -o /dev/null -w '%{http_code}\n'
pg_inbox "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq -r '.data[] | "\(.type) \(.delivery)"'
```

**期望**：204 后 inbox 出现 `type=move` 项（payload 含目标 location）；busy 期间停在队列等待投递边界。
（完整迁移行为由 session move 专项覆盖，本用例只验 inbox 视角；目标目录须是服务已注册的 location，若 400 视为环境分诊而非产品失败。）

---

## T6 SSE 事件契约

### T6.1 enqueued/delivered 事件载荷形状

```bash
sid=$(new_sid)
dump_session "$sid" 25 > /tmp/t61.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/t61.log 2>/dev/null && break; sleep 0.5; done
inbox_put "$sid" '只回答：契约' steer true > /dev/null
wait $SSE_PID
jq -c 'select(.type=="session.inbox.enqueued") | .data | {sessionID, inboxID, itemType: .item.type, delivery: .item.delivery}' /tmp/t61.log
jq -c 'select(.type=="session.inbox.delivered") | .data' /tmp/t61.log
```

**期望**：
- `enqueued.data` 含 `sessionID`、`inboxID`、`item{type,payload,delivery}`；`item.delivery=="steer"`。
- `delivered.data` 仅 `{sessionID, inboxID}`。
- 事件流中断线不重放、以 `server.connected` 开始（同 sse.md T9 通用契约）。

### T6.2 cancelled / delivery.changed 事件载荷

（分别在 T3.1、T2.3/T2.4 中采集；此处汇聚断言）

```bash
jq -c 'select(.type=="session.inbox.cancelled") | .data' /tmp/t31.log
jq -c 'select(.type=="session.inbox.delivery.changed") | .data' /tmp/t23.log /tmp/t24.log
```

**期望**：`cancelled.data={sessionID,inboxID}`；`delivery.changed.data={sessionID,inboxID,delivery}` 且与 PATCH 方向一致。

---

## T7 PG 数据完整性

### T7.1 pending-only 与 enqueued_seq 唯一性

```bash
sid=$(new_sid)
park "$sid" 'a' queue > /dev/null; park "$sid" 'b' queue > /dev/null
pg_inbox "$sid"
psql "$PG_URL" -P pager=off -c \
  "SELECT count(*) AS rows, count(DISTINCT enqueued_seq) AS seqs, min(enqueued_seq), max(enqueued_seq) FROM session_inbox WHERE session_id='$sid';"
```

**期望**：2 行、`enqueued_seq` 无重复且严格递增（唯一索引 `session_inbox_session_enqueued_seq_idx`）。

### T7.2 删除会话级联清空 inbox

```bash
sid=$(new_sid)
park "$sid" 'cascade-me' queue > /dev/null
pg_inbox "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$sid" -o /dev/null -w '%{http_code}\n'
pg_inbox "$sid"
```

**期望**：删除会话 204 后 `session_inbox` 该会话 **0 行**（FK `ON DELETE CASCADE`）。

---

## R 真实用户场景（E2E 组合）

> 单点用例验证契约；本组按真实用户行为模式组合操作，断言"用户体验"层面的结果。
> 场景均有明确代码依据；R1a 含 2026-10-08 现场实测证据。

### R1a 服务重启：执行中断的消息不丢、重启后自动恢复

**用户故事**：AI 正在处理我的消息时 SaaS 发版/崩溃重启，我的消息不能丢，恢复后要继续处理。

```bash
sid=$(new_sid)
inbox_put "$sid" '只回答：收到' steer true > /dev/null   # resume:true，执行启动后立即重启
sleep 3                                                   # 让消息进入 inbox/执行中
docker restart opencode-saas-test
sleep 15
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq '.data | length'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=user" | jq '.data | length'
pg_inbox "$sid"
```

**期望**：
- 结果：重启后 inbox 0 项；user 消息 1 条（文本完整）；最终有 assistant 回复。
- 过程：重启前 `session.inbox.enqueued` 已持久化（durable 事件），重启后 drain 恢复消费。
- PG：重启前后 `session_inbox` 行数从 1 → 0（恢复消费后删除）。

> **现场证据（2026-10-08）**：`ses_ee56d1547ffeYgs89afWpjF4zW` 因服务 PG 连接池卡死滞留 inbox
> （重启前：inbox 1 行、user 消息 0；`docker restart` 后：inbox 0 行、user 消息 1 条
> "只回答：收到" + assistant 回复）。恢复语义实测通过。

### R1b 服务重启：纯排队项保留、不自动执行

**用户故事**：我排了一条消息但还没触发执行，服务重启后消息应仍在队列，而不是被执行或丢失。

```bash
sid=$(new_sid)
park "$sid" 'restart-parked' queue > /tmp/r1b.json
pg_inbox "$sid"
docker restart opencode-saas-test
sleep 15
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq -c '.data[] | {id, delivery}'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=user" | jq '.data | length'
```

**期望**：重启后 inbox 仍有该项（id 一致、delivery=queue）；user 消息 0 条（无持久化 wake 意图，不自动消费；等下一条输入或 PATCH steer 驱动）。

### R2 连珠炮：忙碌中混合 steer 补充 + queue 新任务

**用户故事**：AI 在跑长任务，我一会儿补充细节（要它当前就记住）、一会儿又丢个新任务（等它忙完再做）。

```bash
sid=$(new_sid)
dump_session "$sid" 150 > /tmp/r2.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/r2.log 2>/dev/null && break; sleep 0.5; done
busy_prompt "$sid" > /dev/null
sleep 6
inbox_put "$sid" '补充：完成后在报告末尾加一行 [SEEN-STEER]' steer true > /dev/null
inbox_put "$sid" '新任务：只回答：QUEUE-DONE' queue true > /dev/null
wait $SSE_PID
grep -c 'session.inbox.enqueued' /tmp/r2.log
jq -r 'select(.type=="session.inbox.delivered") | .data.inboxID' /tmp/r2.log | wc -l
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant&order=asc" | jq -r '.data[].text' | grep -cE 'SEEN-STEER|QUEUE-DONE'
pg_inbox "$sid"
```

**期望**：
- 结果：最终回复包含 `[SEEN-STEER]`（第一轮内生效）与 `QUEUE-DONE`（第二轮响应）。
- 过程：3 次 enqueued / 3 次 delivered；steer 条的 delivered 在第一轮 `execution.succeeded` 之前，queue 条在之后。
- PG：0 行。

### R3 中途改需求：转向覆盖原指令

**用户故事**：AI 按方案 A 干活干到一半，我喊停换方案——不需要打断，一条 steer 就够。

```bash
sid=$(new_sid)
dump_session "$sid" 150 > /tmp/r3.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/r3.log 2>/dev/null && break; sleep 0.5; done
busy_prompt "$sid" > /dev/null
sleep 6
inbox_put "$sid" '改变需求：不用等 sleep 结束了。直接终止当前 shell 任务，改为只输出：PIVOTED' steer true > /dev/null
wait $SSE_PID
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant&order=asc" | jq -r '.data[].text' | grep -m1 'PIVOTED'
```

**期望**：最终回复以新指令为准（含 `PIVOTED`，不再等完原 sleep 25）；steer 的 delivered 发生在第一轮 succeeded 之前（同 turn 生效，无需打断）。

### R4 发错撤回：AI 永远看不到

**用户故事**：手滑把别处的消息发进这个会话，趁 AI 还没处理赶紧撤回。

```bash
sid=$(new_sid)
park "$sid" '发错的私密内容-IGNORE-ME' queue > /tmp/r4.json
iid=$(jq -r '.data.id' /tmp/r4.json)
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$sid/inbox/$iid" -o /dev/null -w 'cancel=%{http_code}\n'
inbox_put "$sid" '复述你收到的所有用户消息原文' steer true > /dev/null
wait_idle "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message" | jq -r '.data[].text // empty' | grep -c 'IGNORE-ME' || echo "not-seen=ok"
```

**期望**：撤回成功 204；后续对话上下文**不包含**被撤回文本（grep 0 次）；该轮执行正常完成（撤回不破坏会话）。

### R5 双击发送：并发 admit 不丢不重

**用户故事**：手抖双击发送，两条消息几乎同时到达服务端。

```bash
sid=$(new_sid)
dump_session "$sid" 60 > /tmp/r5.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/r5.log 2>/dev/null && break; sleep 0.5; done
inbox_put "$sid" '双击-第一条' steer true > /dev/null &
inbox_put "$sid" '双击-第二条' steer true > /dev/null &
wait $SSE_PID || true; wait_idle "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=user&order=asc" | jq -r '.data[].text'
psql "$PG_URL" -P pager=off -t -c "SELECT count(*), count(DISTINCT enqueued_seq) FROM session_inbox WHERE session_id='$sid';"
```

**期望**：两条都成为 user 消息（不丢）；PG count=0, distinct=0（消费后无残留，入队时序竞争由 `serialized` KeyedMutex 保证 `enqueued_seq` 唯一）。

### R6 双会话并发：inbox 按 session 隔离

**用户故事**：我开了两个会话窗口同时操作，各自排队互不影响。

```bash
sidA=$(new_sid); sidB=$(new_sid)
park "$sidA" 'A-parked' queue > /dev/null
park "$sidB" 'B-parked' queue > /dev/null
inbox_put "$sidA" '只回答：A' steer true > /dev/null
wait_idle "$sidA"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sidA/inbox" | jq '.data | length'   # A 空
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sidB/inbox" | jq -c '.data[].payload.text'  # B 仍在
```

**期望**：A 会话消费完毕 inbox 空；B 会话 `B-parked` 原样停留（同进程 KeyedMutex 按 sessionID 隔离，A 的 drain 不触碰 B 的队列）。

### R7 用户打断：排队消息保留、不误投

**用户故事**：AI 跑偏了，我打断它；排着队的新任务应该原地保留，等我确认再继续，而不是打断瞬间被丢弃或误投。

```bash
sid=$(new_sid)
dump_session "$sid" 90 > /tmp/r7.log &
SSE_PID=$!; for i in $(seq 1 20); do grep -q server.connected /tmp/r7.log 2>/dev/null && break; sleep 0.5; done
busy_prompt "$sid" > /dev/null
sleep 6
inbox_put "$sid" '打断后的新任务：只回答：RESUMED' queue true > /dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/interrupt" \
  -H 'Content-Type: application/json' -d '{"reason":"user"}' > /dev/null
sleep 3
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/inbox" | jq -c '.data[] | {delivery: .delivery, text: .payload.text}'
wait $SSE_PID
```

**期望**：
- 打断后 queue 项仍在 inbox（`Queued next-turn prompts stay parked`，execution.ts 中断恢复注释）；打断事件 `session.execution.interrupted(reason=user)` 出现。
- 若后续再驱动（下一条 steer/PATCH），该项才被投递并响应 `RESUMED`（作为 R7 续接步骤验证）。

### R8 过夜任务清单：批量 queue + compact 收尾

**用户故事**：睡前丢一堆任务让 AI 顺序做，做完压缩上下文省 token——第二天全都要在。

> **语义要点（实测）**：queue 只在 **idle boundary（当前 turn 完整结束）** 投递。驱动条若让模型进入长工具循环（turn 不结束），queue 会被压后——直到 watchdog 打断或 turn 完成后依次消费。真实用户含义：**AI 跑偏死循环时排队任务不会自动开始**，需打断（见 R7）后恢复。驱动条应是快速完成的简单指令。

```bash
sid=$(new_sid)
park "$sid" '任务1：只回答 ONE' queue > /dev/null
park "$sid" '任务2：只回答 TWO' queue > /dev/null
park "$sid" '任务3：只回答 THREE' queue > /dev/null
inbox_put "$sid" '只回答：START' steer true > /dev/null   # 快速结束第一 turn，触发 queue 逐个消费
wait_idle "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=user&order=asc" | jq -r '.data[].text'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant&order=asc" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | grep -cE 'ONE|TWO|THREE'
# 收尾压缩（新一轮）
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/compact" -H 'Content-Type: application/json' -d '{}' | jq -r '.data.type'
wait_idle "$sid"
pg_inbox "$sid"
```

**期望**：3 条任务在第一 turn 结束后按 FIFO 逐条投递（每 turn 一条）且各自得到响应（ONE/TWO/THREE 齐全）；compact 返回 `compaction` 并完成；最终 PG 0 行。

---

## 覆盖矩阵

| 代码路径 / 行为 | 用例 |
|---|---|
| prompt 默认 delivery=steer、入队即消费 | T1.1 |
| resume:false 不 wake（稳定停留） | T1.2 |
| PublicInboxInfo 结构 | T1.3 |
| queue 在 idle 边界投递（新 turn） | T2.1 |
| steer 在 step 边界投递（同 turn） | T2.2 |
| queueInbox 不 wake | T2.3 |
| steerInbox wake（消费驱动） | T2.4 |
| cancel + InboxCancelled 事件 | T3.1 |
| cancel no-op（吞 InboxConflictError） | T3.2 |
| reconcile 幂等（同 id 在 inbox） | T4.1 |
| 已投递 id 幂等（返回原消息）；跨会话 id → 409 | T4.2 |
| PATCH 已投递项 → 409 | T4.3 |
| FIFO by enqueued_seq | T5.1 |
| steer 优先于 queue | T5.2 |
| compaction 控制项（steer 默认、先于 queued） | T5.3 |
| move 控制项入队 | T5.4 |
| SSE 事件载荷契约 | T6.1、T6.2 |
| pending-only + enqueued_seq 唯一 | T7.1 |
| 会话删除级联 | T7.2 |
| 服务重启：执行中断的消息恢复消费 | R1a |
| 服务重启：纯排队项保留、不自动执行 | R1b |
| 忙碌中 steer 补充 + queue 新任务混合 | R2 |
| steer 中途改需求（同 turn 语义生效） | R3 |
| 撤回后消息不进入模型上下文 | R4 |
| 并发 admit 不丢不重（KeyedMutex serialized） | R5 |
| 多会话 inbox 按 session 隔离 | R6 |
| 用户打断：queue 项原地保留（parked） | R7 |
| 批量任务 FIFO 全消费 + compact 收尾 | R8 |

## 已知边界（不在本专项断言，避免误判）

- **跨实例并发**：进程内 `KeyedMutex` 只在单进程内串行化 inbox 变更；多实例共享 PG 时无 advisory lock（core AGENTS.md 明示）。SaaS 单实例部署下本专项结论成立。
- **move/compaction 的完整执行语义**（Location 迁移、压缩摘要质量）分别由 move、compaction 专项覆盖。
- **interrupt 后的续接语义**（wake scope 决策，`execution.ts` interrupt+resume 注释）已沉淀为 R7 的观察断言；完整的"打断→恢复执行"链路建议在**中断专项**展开。
- **queue 消费依赖 idle boundary**（R8 实测）：当前 turn 长时间不结束（如模型工具循环跑偏）时，queue 任务会一直被压后，直到 watchdog/用户打断后恢复。真实用户含义：排队任务"等当前做完"是严格语义，死循环需打断。
- **删会话首次可能 409**（T7.2 实测）：`SandboxRetainedError`，沙箱异步 destroy 进行中；客户端应重试（5s 后 204）。
- **空会话 compact 被拒绝**（T5.3 实测）：`compaction.unavailable: Nothing to compact yet`，属预期；compact 用例需先积累上下文。
- **并发提交顺序按到达序**（R5 实测）：双击并发时 enqueued_seq 以服务端落库顺序为准，用例断言"不丢不重"而非固定顺序。

## 执行记录（2026-10-08，28/28 通过）

单实例 docker（opencode-saas-restart-fix:local，固定密码）+ 本地 PG（opencode-v2-up）。
全部用例通过；其中 T1.1/T2.1/T4.1/T4.2/T5.1/T5.3/R8 的期望按实测语义修正（见上文各用例）。
环境观察：watchdog 约 3 分钟中断长执行；postgres 3.4.7 客户端 TimeoutNegativeWarning（依赖上游，负超时被 clamp 不阻塞）。
