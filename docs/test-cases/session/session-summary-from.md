# 会话派生：summaryFrom 摘要上下文（V2）

> **2026-09-30：V2 已实现。**`POST /api/session` 新增 `summaryFrom`（`packages/protocol/src/groups/session.ts`），
> Core 走 `SessionCompaction.deriveSummary({ sourceSessionID, target })`（`packages/core/src/session/compaction.ts`），
> 在 `Session.create` 创建完成后后台 fork（`packages/core/src/session.ts`）。复用 compaction 的提示词、历史切分、模型调用与重试，
> 但结果通过标准 `session.step.*` / `session.text.*` 事件流成为目标会话的**普通 assistant 消息**；不创建 compaction 记录。
>
> **核心契约：源会话只读。**`deriveSummary` 用源会话的消息作为输入，所有 assistant 消息、事件与 usage 都写目标会话；
> 源会话的消息、事件、`time_updated` 一律不变。摘要以 `session.text.delta` 实时输出，并以 `session.text.ended` 完成持久化。
> Core 单测 `packages/core/test/session-compaction.test.ts` 有两条用例把这钉死。
>
> 下方为 V1 需求基线原文与历史复测记录（保留作为行为参考）。**V1 命令（`/session`、`/message`、`/event`、
> `message`/`part`/`exec_log` 表）为历史记录，不要执行。**V2 可复跑脚本见文末。

> **V1 原始功能说明**：`POST /session` 创建新会话时传 `summaryFrom: <源会话ID>`，服务端创建会话后**异步**为源会话**现场生成一份全新摘要**（每次都调 LLM），写入**新会话**（user 消息带 compaction part + assistant 消息 `summary: true`），生成过程走正常消息事件流（`message.part.delta` → `session.idle`）。**源会话零写入**。

> **功能**：`POST /session` 创建新会话时传 `summaryFrom: <源会话ID>`，服务端创建会话后**异步**为源会话**现场生成一份全新摘要**（每次都调 LLM），写入**新会话**（user 消息带 compaction part + assistant 消息 `summary: true`），生成过程走正常消息事件流（`message.part.delta` → `session.idle`）。**源会话零写入**。
>
> **摘要策略（方案 C，统一生成）**：**不依赖、也不复用**源会话已有的 compaction 摘要——无论有没有，都单独生成最新摘要。区别仅在生成**输入**：无旧摘要时序列化源会话全部消息；有旧摘要时以旧摘要为 `<prior-summary>` 锚点、只序列化其后新消息（避免长会话全量序列化超上下文，复用 compaction 连续压缩的既有链式机制）。两条路径输出都是**新 LLM 生成的摘要**，不是旧摘要原文。
>
> **依赖**：镜像需包含 `summaryFrom` 支持（2026-09-10 开发，镜像 tag 见复测记录）。
>
> **注意**：一律使用 `$MODEL`（Yd-DeepSeek）；摘要为异步 LLM 生成，断言前需轮询等待。

## 通用变量

```bash
source docs/test-cases/test-env.sh [1|2|3]
source docs/test-cases/test-lib.sh

# 等待派生会话内摘要生成完毕（assistant summary=true 且 finish 已落库；仅消息数≥2 不够——finish 在流式末尾才写入，提前断言会遇到摘要未完成竞态）
wait_derived() {
  for i in $(seq 1 45); do
    OK=$(curl -s "$BASE/session/$1/message" | jq '[.[] | select(.info.role=="assistant" and .info.summary==true and .info.finish!=null)] | length')
    [ "$OK" -ge 1 ] && return 0
    sleep 2
  done
  return 1
}
```

## SUM-1: 基本派生（源会话有对话历史）

### T43.1.1 派生会话生成摘要消息对

```bash
# 准备源会话（一段有具体事实的对话）
SRC=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"summary-source"}' | jq -r .id)
curl -s --max-time 60 -X POST "$BASE/session/$SRC/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"记住：项目代号是凤凰，上线日期定在下周一\"}],\"model\":$MODEL}" >/dev/null

# 带 summaryFrom 创建新会话 —— 立即返回，不等摘要
NEW=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC\",\"title\":\"derived\"}" | jq -r '.id')
echo "NEW: $NEW"

wait_derived "$NEW" || fail "T43.1.1" "摘要消息超时未生成"

# 验证消息结构：user 带 compaction part；assistant summary=true 且有非空文字
curl -s "$BASE/session/$NEW/message" | jq '[.[] | {role: .info.role, summary: .info.summary,
  parts: [.parts[] | .type]}]'
curl -s "$BASE/session/$NEW/message" | jq -r '.[] | select(.info.role=="assistant")
  | .parts[] | select(.type=="text") | .text' | head -20
```

**期望**：
- `POST /session` 同步返回新会话 ID（HTTP 200）
- 消息恰好 2 条：第 1 条 `role=user` 且 parts 含 `compaction`；第 2 条 `role=assistant`、`summary=true`、有非空 text
- 摘要文字应能体现源会话要点（含「凤凰」或「上线」相关信息）

### T43.1.2 PG 落库验证

```bash
psql "$PG_URL" -t -A -c "
SELECT m.data->>'role' || ' summary=' || coalesce(m.data->>'summary','null')
FROM message m WHERE m.session_id='$NEW' ORDER BY m.time_created;"
psql "$PG_URL" -t -A -c "
SELECT count(*) FROM part p WHERE p.session_id='$NEW' AND p.data->>'type'='compaction';"
```

**期望**：`user summary=null` + `assistant summary=true` 两行；compaction part 计数 = 1

### T43.1.3 exec_log 审计与 title 行为

```bash
psql "$PG_URL" -t -A -c "SELECT source, command FROM exec_log WHERE session_id='$NEW' AND source='session-create';"
curl -s "$BASE/session/$NEW" | jq -r .title
```

**期望**：`session-create` 的 command 含 `"summaryFrom":"<SRC>"`（审计可追溯）；新会话 title 为默认「New session - …」，**不继承**源会话标题（与 fork 的 `(fork #n)` 后缀行为不同）

## SUM-2: 摘要生成走消息事件流

### T43.2.1 SSE 订阅可见摘要流式生成

```bash
# 先发起派生，返回后立即订阅（LLM 生成摘要需数秒，通常能赶上流式阶段）
NEW=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC\"}" | jq -r .id)
curl -s -N --max-time 90 "$BASE/session/$NEW/event" > /tmp/sse-derive.log &

wait_derived "$NEW"; sleep 2; kill %1 2>/dev/null

grep -oE '"type":"[a-z.]+"' /tmp/sse-derive.log | sort | uniq -c | sort -rn | head
grep -c '"type":"message.part.delta"' /tmp/sse-derive.log
grep -oE '"type":"session.idle"' /tmp/sse-derive.log | head -1
```

**期望**：事件流中至少出现 `message.part.updated`（part 写入）、`message.part.delta`（摘要文字增量）与 `session.idle`（生成结束）中的多项；`message.part.delta` 计数 > 0

## SUM-3: 源会话零污染

### T43.3.1 派生前后源会话消息数一致

```bash
BEFORE=$(curl -s "$BASE/session/$SRC/message" | jq 'length')
NEW3=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC\"}" | jq -r .id)
wait_derived "$NEW3"
AFTER=$(curl -s "$BASE/session/$SRC/message" | jq 'length')
echo "before=$BEFORE after=$AFTER"
[ "$BEFORE" = "$AFTER" ] && pass "T43.3.1" || fail "T43.3.1" "源会话被写入"
```

**期望**：before == after（deriveSummary 只读源会话）

## SUM-4: 摘要上下文端到端生效

### T43.4.1 派生会话能答出源会话的事实

```bash
NEW4=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC\"}" | jq -r .id)
wait_derived "$NEW4" || fail "T43.4.1" "摘要未生成"

curl -s --max-time 60 -X POST "$BASE/session/$NEW4/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"这个会话之前提到的项目代号是什么？只回答代号\"}],\"model\":$MODEL}" \
  | jq -r '.parts[] | select(.type=="text") | .text' | head -5
```

**期望**：回复含「凤凰」（摘要已作为上下文注入新会话的 LLM 请求）

## SUM-5: 源会话有 compaction 历史（生成输入含旧摘要锚点）

### T43.5.1 长会话派生仍生成全新摘要（旧摘要仅作输入锚点）

```bash
# 构造长会话触发自动 compaction（多轮消息），或手动 compact
SRC5=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"compact-source"}' | jq -r .id)
curl -s --max-time 60 -X POST "$BASE/session/$SRC5/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"第一轮：记住暗号是芝麻开门\"}],\"model\":$MODEL}" >/dev/null
curl -s -X POST "$BASE/session/$SRC5/summarize" -H 'Content-Type: application/json' \
  -d "{\"providerID\":$(echo $MODEL | jq -r .providerID),\"modelID\":$(echo $MODEL | jq -r .modelID)}"

# compact 后追加新事实
curl -s --max-time 60 -X POST "$BASE/session/$SRC5/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"第二轮：新暗号改为西瓜开门\"}],\"model\":$MODEL}" >/dev/null

NEW5=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC5\"}" | jq -r .id)
wait_derived "$NEW5"
curl -s "$BASE/session/$NEW5/message" | jq -r '.[] | select(.info.role=="assistant")
  | .parts[] | select(.type=="text") | .text'
```

**期望**：派生摘要**非旧摘要原文**且非空，体现「西瓜开门」（compact 后新消息进入了生成输入，硬校验）；若同时含「芝麻开门」则说明旧摘要锚点也进入了输入（软校验——LLM 会改写措辞，未命中时人工抽查确认新信息已覆盖；两条路径输出的都是本次新 LLM 生成的摘要）

## SUM-6: 兜底场景

### T43.6.1 空源会话 → 新会话正常但无摘要

```bash
EMPTY=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
CODE6=$(curl -s -o /tmp/r6.json -w "%{http_code}" -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$EMPTY\"}")
NEW6=$(jq -r .id /tmp/r6.json)
echo "code=$CODE6 NEW6=$NEW6"
sleep 10
curl -s "$BASE/session/$NEW6/message" | jq 'length'
```

**期望**：HTTP 200、新会话正常返回；等待后消息数为 0（无内容可摘要，静默跳过）

### T43.6.2 不存在的源会话 → 不影响创建

```bash
NEW7=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"summaryFrom":"ses_nonexistent0000000000000000"}' | jq -r .id)
echo "NEW7: $NEW7"
```

**期望**：HTTP 200、返回有效新会话 ID（内部 NotFound 仅记日志，不阻断创建）

### T43.6.3 非法 summaryFrom 格式 → 400

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"summaryFrom":"invalid-id"}'
```

**期望**：HTTP 400（`SessionID` schema 校验要求 `ses` 前缀，payload decode 阶段拒绝）

## SUM-7: 源会话含工具调用

### T43.7.1 摘要涵盖工具产出信息

```bash
SRC7=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"tool-source"}' | jq -r .id)
curl -s --max-time 90 -X POST "$BASE/session/$SRC7/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"在 /workspace 创建 phoenix.txt 文件，内容是 hello phoenix，完成后回复done\"}],\"model\":$MODEL}" >/dev/null

NEW_T=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC7\"}" | jq -r .id)
wait_derived "$NEW_T"
curl -s "$BASE/session/$NEW_T/message" | jq -r '.[] | select(.info.role=="assistant")
  | .parts[] | select(.type=="text") | .text' | grep -i "phoenix" && pass "T43.7.1" || fail "T43.7.1" "摘要未涵盖工具产出"
```

**期望**：摘要提到 `phoenix.txt` / 文件写入相关信息（验证 serialize 对 tool parts 的序列化覆盖；软校验，LLM 措辞可变）

## SUM-8: 与 pvcMode/appId 组合

### T43.8.1 派生与 app 模式配置同时生效

```bash
NEW8=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC\",\"pvcMode\":\"app\",\"appId\":\"derive-app\"}" | jq -r .id)
curl -s "$BASE/session/$NEW8" | jq '{pvcMode, appId}'
wait_derived "$NEW8" && pass "T43.8.1" || fail "T43.8.1" "摘要未生成"
```

**期望**：详情返回 `pvcMode=app`、`appId=derive-app`，摘要照常生成（summaryFrom 与既有创建参数正交）

## SUM-9: 并发派生

### T43.9.1 同一源并行创建两个派生会话

```bash
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d "{\"summaryFrom\":\"$SRC\"}" > /tmp/d1.json &
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d "{\"summaryFrom\":\"$SRC\"}" > /tmp/d2.json &
wait
D1=$(jq -r .id /tmp/d1.json); D2=$(jq -r .id /tmp/d2.json)
echo "D1=$D1 D2=$D2"; [ "$D1" != "$D2" ] && [ -n "$D1" ] && [ -n "$D2" ]
wait_derived "$D1" && wait_derived "$D2" && pass "T43.9.1" || fail "T43.9.1" "并发派生异常"
```

**期望**：两个不同 ID 均创建成功、各自生成摘要消息对，互不干扰

## SUM-10: 摘要生成期间立即发消息

### T43.10.1 busy 状态下用户消息排队执行

```bash
NEW10=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"summaryFrom\":\"$SRC\"}" | jq -r .id)
# 不等摘要完成，立即发消息（同步 prompt 接口内部 waitForSessionLock 排队）
curl -s --max-time 120 -X POST "$BASE/session/$NEW10/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"收到请只回复ok\"}],\"model\":$MODEL}" \
  | jq -r '.parts[] | select(.type=="text") | .text'

curl -s "$BASE/session/$NEW10/message" | jq '[.[] | {role: .info.role, summary: .info.summary}]'
```

**期望**：不出现 5xx / 锁死；最终消息 ≥ 4 条（摘要 2 + user + assistant 回复），回复含 `ok`。
**边界**：摘要 LLM 耗时超过 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC`（默认 60s）时消息接口返回 503——属预期保护，非缺陷。

## SUM-11: 回归

### T43.11.1 不带 summaryFrom 的普通创建不受影响

```bash
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"plain"}' | jq -r .id
```

**期望**：正常创建（与既有 T4.x 行为一致）

---

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-09-10 | T43.1.1/1.2/1.3 基本派生 + PG + 审计 | ✅ | 摘要含「凤凰/下周一」标准模板；exec_log 含 summaryFrom；title 默认不继承（T43.11.1 补验） |
| 2026-09-10 | T43.2.1 SSE 事件流 | ✅ | delta×65 + `session.idle`；**修复前 idle 缺失**（deriveSummary 不走 prompt loop 无人恢复 idle），fix 后通过 |
| 2026-09-10 | T43.3.1 零污染 | ✅ | before=after=2 |
| 2026-09-10 | T43.4.1 端到端 | ✅ | 回复「凤凰」；**修复前用户消息被误触发为空 compaction 且永无回复**（缺会话锁竞态：摘要 finish 未落库时 compaction part 被判 pending），加 `withSessionLock` 后通过 |
| 2026-09-10 | T43.5.1 compaction 历史源 | ✅ | 摘要同时含「西瓜开门」（recent 硬校验）与「芝麻开门」（prior-summary 软校验），真实合并非旧文原文 |
| 2026-09-10 | T43.6.1/6.2/6.3 兜底 | ✅ | 空源 10s 无消息；不存在源 200 不阻断；非法格式 400 |
| 2026-09-10 | T43.7.1 工具调用源 | ✅ | 源含 `write` 工具，摘要涵盖 phoenix.txt 路径+内容（grep 命中 3 处） |
| 2026-09-10 | T43.8.1 pvc/appId 组合 | ✅ | pvcMode=app + appId=derive-app 生效，摘要照常 |
| 2026-09-10 | T43.9.1 并发派生 | ✅ | 两不同 ID 各自生成摘要 |
| 2026-09-10 | T43.10.1 busy 期间发消息 | ✅ | 锁修复后排队正常回复「ok」，消息流干净无多余 compaction |
| 2026-09-10 | T43.11.1 回归 | ✅ | 普通创建正常 |

> 执行环境：镜像 `opencode-saas-sandbox-test:sumfrom-fix2`（本地 PG `local` 用户 + 远程沙箱，容器 `opencode-saas-test`）。
> 本轮执行暴露并修复 2 个实现缺陷：① `deriveSummary` 缺 idle 恢复（SSE 无完成信号、状态永停 busy）→ `Effect.ensuring(status.set(idle))`；② `forkDeriveSummary` 缺会话锁 → 摘要流式期间发消息触发空 compaction 竞态 → 包 `withSessionLock`（`handlers/session.ts`）。`wait_derived` 判据同步加强为「等 summary assistant 的 finish 落库」。

| 2026-09-14 | **全量复测**（镜像 `hitl-cbf2276a-wip2`（含 pgJsonb/LEASE_TOOLS/偏离修复），本地 PG + 远端沙箱） | ✅ 15/15 | T43.1.1 ✅（user compaction part + assistant summary=true + 摘要含「凤凰」）/ T43.1.2 ✅（**行为演进**：user 行 `summary={"diffs":[]}` 而非 09-10 时的 null——compaction 元数据随消息落库，结构断言核心不变：compaction part=1 + assistant summary=true）/ T43.1.3 ✅（exec_log 审计含 summaryFrom、title 未继承源标题）/ T43.2.1 ✅（delta×47 + part.updated×6 + `session.idle`）/ T43.3.1 ✅（before=after=2 零污染）/ T43.4.1 ✅（回复「凤凰」）/ T43.5.1 ✅（西瓜开门硬校验 ×2 + 芝麻开门软校验 ×2，真实合并）/ T43.6.1/6.2/6.3 ✅（空源 0 消息 / 不存在源正常创建 / 400）/ T43.7.1 ✅（phoenix 命中 ×4）/ T43.8.1 ✅（pvcMode=app + appId + 摘要照常）/ T43.9.1 ✅（并发两 ID 各自生成）/ T43.10.1 ✅（排队回复 ok、消息数 4）/ T43.11.1 ✅ |

---

## V2 实现与实测（2026-09-30）

### 实现落点

| 层 | 文件 | 改动 |
|---|---|---|
| 契约 | `packages/protocol/src/groups/session.ts` | `session.create` payload 增 `summaryFrom: Session.ID`（可选） |
| 服务 | `packages/core/src/session/compaction.ts` | 新增 `DeriveInput` / `Interface.deriveSummary`；复用 `execute`/`executeProvider` |
| 接线 | `packages/core/src/session.ts` | `CreateBaseInput.summaryFrom`；创建完成后 `instances.provide(created)(…)` 后台 fork，失败只 log |
| 传输 | `packages/server/src/handlers/session.ts` | `createInput` 透传 `summaryFrom` |

**输出语义**：V2 复用 compaction 生成逻辑（源历史切分、旧摘要锚点、摘要模板、LLM stream 与重试），但 `deriveSummary` 将输出模式设为 `assistant`：
`session.step.started` 创建普通 assistant 行，`session.text.delta` 逐段实时广播，`session.text.ended` 把完整文本投影到该行，最后 `session.step.ended` 收尾。不会发布 `Compaction.Started/Ended/Delta`，也不会写 `type=compaction` 或 history checkpoint。

**与 V1 的差异**：V1 生成普通 assistant 消息并绕过 prompt loop 直接跑 processor，因此要手补 `status.set(idle)` 和 `withSessionLock`。V2 通过 Step/Text 生命周期落一条完整 assistant 消息；创建后台任务不会占用 prompt runner 的忙闲状态。

### 源会话只读（契约，Core 单测锁定）

```
deriveSummary:
  源会话  → sessionMessages（输入）                      ← 只读
  目标会话 → Step.Started/ Text.Started/ Text.Delta/ Text.Ended/ Step.Ended
             → 一条普通 assistant 消息 + usage           ← 全部写
             → 不写 compaction 消息 / checkpoint / historyPath
```

`packages/core/test/session-compaction.test.ts`：

- `deriveSummary installs the source's summary in the target and leaves the source untouched`
  —— 断言目标得到 assistant 文本与实时 `Text.Delta`、没有 compaction 行、源 `store.context` 不变、模型请求归属目标；
- `deriveSummary reports an empty source as unavailable instead of writing anything`
  —— 空源直接 `compaction.unavailable`，不 resolve 模型、不产生摘要。

`packages/core/test/session-compaction.test.ts` 全 19 例、compaction 相关回归 31 例、session 相关回归 217 例均通过。

**普通消息流改造后的实测（2026-09-30）**：Docker 临时容器 `opencode-sumfrom-stream`（14107）、本地 PG `opencode-v2-test`、真实模型与沙箱；V2 脚本 **18/18 断言通过**。观测到目标会话 285 个 `session.text.delta` 事件，增量拼接文本与最终持久化文本完全一致；PG 有 1 条 assistant 摘要行、没有 compaction 行。额外验证了源会话已有 compaction checkpoint 且之后有新消息时，两部分信息都进入派生摘要。源会话消息数、事件数与 `time_updated` 均未变化。测试后临时容器和测试会话已清理。

### V2 可复跑脚本

```bash
BASE=http://localhost:14107 PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-test' \
  OPENCODE_PASSWORD=... MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}' \
  node docs/test-cases/scripts/session-summary-from-v2.mjs
```

映射到 V2 断言：

| V1 用例 | V2 断言 |
|---|---|
| T43.1.1 摘要消息 | `summaryFrom` 创建后轮询到普通 assistant 完成消息，摘要含源会话要点 |
| T43.1.2 PG 落库 | `session_message` 中目标会话有 assistant 摘要行、无 compaction 行 |
| T43.3.1 零污染 | 源会话消息逐字节不变 + 源 `event` 表 0 行 + `time_updated` 不变 |
| T43.4.1 端到端 | 目标会话追问源会话事实，回复含「凤凰」 |
| T43.6.1/6.2/6.3 兜底 | 空源 200、不存在源 200、非法格式 400 |
| T43.9.1 并发 | 同一源并发两个派生，各自生成摘要 |
