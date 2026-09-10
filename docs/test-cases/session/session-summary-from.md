# 会话派生：summaryFrom 摘要上下文

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
