# 并发与隔离

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 并发调用 API | 全部成功，无冲突 |
| 2. PG 记录 | 查询 sandbox/message 表 | 记录独立，状态正确 |
| 3. 文件隔离 | exec API 验证 | session 间文件不互相可见 |

## 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

---

## 六、并发与隔离

### T6.1 并发创建 session

```bash
SIDS=()
for i in {1..5}; do
  SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  SIDS+=($SID)
  echo "  Session $i: $SID"
done

UNIQUE=$(printf '%s\n' "${SIDS[@]}" | sort -u | wc -l | tr -d '[:space:]')
echo "创建数: ${#SIDS[@]}, 唯一数: $UNIQUE"

echo "--- PG 验证 ---"
for sid in "${SIDS[@]}"; do
  EXISTS=$(psql "$PG_URL" -t -c "SELECT COUNT(*) FROM session WHERE id='$sid'" | tr -d '[:space:]')
  echo "  $sid: EXISTS=$EXISTS"
done
```

**期望**：5 个不同 sessionID，PG 全部 EXISTS=1

### T6.2 跨 session 文件隔离

```bash
# Session A 创建文件
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Session A: $SID_A"

curl -s --max-time 180 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"创建 /workspace/sessionA.txt 内容 A"}],"model":'$MODEL'}' > /dev/null

curl -s -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/sessionA.txt"}' | python3 -c "
import json,sys; print(f\"  Session A 读取: {json.load(sys.stdin).get('stdout','').strip()}\")
"

# Session B 列出目录
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Session B: $SID_B"

curl -s -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls /workspace/ 2>&1"}' | python3 -c "
import json,sys
out=json.load(sys.stdin).get('stdout','').strip()
has_isolation = 'sessionA.txt' not in out
print(f\"  Session B ls: {out or '(空)'}\")
print('✅ T6.2 PASS' if has_isolation else '❌ T6.2 FAIL')
"

echo "--- PG 验证 ---"
psql "$PG_URL" -c "SELECT session_id, id, state FROM sandbox WHERE session_id IN ('$SID_A','$SID_B')"
```

**期望**：B 看不到 `sessionA.txt`，sandbox id 不同

### T6.3 并发消息发送

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

for i in {1..3}; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 -X POST "$BASE/session/$SID/prompt_async" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"第${i}条\"}],\"model\":$MODEL}")
  echo "  第${i}条: status=$STATUS"
done

sleep 30
echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT COUNT(*) as msg_count FROM message WHERE session_id='$SID'"
psql "$PG_URL" -t -c "SELECT COUNT(*) as part_count FROM part WHERE session_id='$SID'"
```

**期望**：全部 204，PG 消息数 > 0

> **定位说明**：同 session 消息为串行处理（见已废弃的 T6.10），本用例验证的是 **prompt_async 的 204 接纳语义**（快速连续提交均被接受且不丢消息），而非并发执行能力。

### T6.4 并发 sandbox 创建

```bash
SIDS=()
for i in {1..5}; do
  SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  SIDS+=($SID)
done

echo "并发触发 5 个 sandbox 创建..."
for sid in "${SIDS[@]}"; do
  curl -s --max-time 120 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d '{"parts":[{"type":"text","text":"执行 hostname"}],"model":'$MODEL'}' > /dev/null &
done
wait

echo "--- PG 验证 ---"
for sid in "${SIDS[@]}"; do
  STATE=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='$sid'" | tr -d '[:space:]')
  echo "  $sid: state=$STATE"
done
```

**期望**：5 个 sandbox 全部创建成功（state=running 或 destroyed）

### T6.5 并发写同名文件隔离

```bash
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Session A: $SID_A"
echo "Session B: $SID_B"

# 并发写同名文件
curl -s --max-time 180 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"创建 /workspace/shared.txt 内容 AAA"}],"model":'$MODEL'}' > /dev/null &

curl -s --max-time 180 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"创建 /workspace/shared.txt 内容 BBB"}],"model":'$MODEL'}' > /dev/null &
wait

# 验证各自内容独立
echo "--- 验证文件内容 ---"
CONTENT_A=$(curl -s -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/shared.txt 2>&1"}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','').strip())")

CONTENT_B=$(curl -s -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/shared.txt 2>&1"}' | python3 -c "import json,sys; print(json.load(sys.stdin).get('stdout','').strip())")

echo "  Session A 内容: $CONTENT_A"
echo "  Session B 内容: $CONTENT_B"
ISOLATED=$( [ "$CONTENT_A" = "AAA" ] && [ "$CONTENT_B" = "BBB" ] && echo "true" || echo "false" )
[ "$ISOLATED" = "true" ] && echo "✅ T6.5 PASS" || echo "❌ T6.5 FAIL"
```

**期望**：A 读到 AAA，B 读到 BBB，内容互不影响

### T6.6 sandbox 崩溃隔离

```bash
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Session A: $SID_A"
echo "Session B: $SID_B"

# 先在 B 中写文件
curl -s --max-time 180 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"创建 /workspace/before-crash.txt 内容 SAFE"}],"model":'$MODEL'}' > /dev/null

# A 执行 kill -9 1 自毁 sandbox
echo "--- Session A 执行 kill -9 1 ---"
curl -s --max-time 30 -X POST "$BASE/session/$SID_A/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"kill -9 1 2>&1 || echo killed"}' | python3 -c "
import json,sys; print(f\"  exitCode={json.load(sys.stdin).get('exitCode')}\")
"

sleep 3

# 验证 B 不受影响
echo "--- 验证 Session B 不受影响 ---"
curl -s -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/before-crash.txt 2>&1"}' | python3 -c "
import json,sys
out=json.load(sys.stdin).get('stdout','').strip()
print(f\"  Session B 内容: {out}\")
print('✅ T6.6 PASS' if out == 'SAFE' else '❌ T6.6 FAIL')
"
```

**期望**：B 读到 `SAFE`，证明 A 的 sandbox 崩溃不影响 B

### T6.7 同 session 并发 exec

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 先创建 sandbox
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"执行 hostname"}],"model":'$MODEL'}' > /dev/null

# 并发执行 5 个 exec
echo "--- 并发执行 5 个 exec ---"
for i in {1..5}; do
  curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"echo exec-$i && sleep 1\"}" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"  exec-$i: exitCode={d.get('exitCode')}, stdout={d.get('stdout','').strip()}\")
" &
done
wait

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT id, state FROM sandbox WHERE session_id='$SID'"
```

**期望**：5 个 exec 全部成功

### T6.8 并发删除 + 写入

```bash
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Session A: $SID_A"
echo "Session B: $SID_B"

# B 开始写文件（耗时长）
echo "--- Session B 开始写文件 ---"
curl -s --max-time 180 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"创建 /workspace/long-write.txt 内容 DONE"}],"model":'$MODEL'}' > /dev/null &

sleep 2

# A 删除自己
echo "--- Session A 删除自己 ---"
DEL=$(curl -s -X DELETE "$BASE/session/$SID_A")
echo "  delete: $DEL"

# 等 B 完成
wait

# 验证 B 的文件还在
echo "--- 验证 Session B ---"
curl -s -X POST "$BASE/session/$SID_B/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/long-write.txt 2>&1"}' | python3 -c "
import json,sys
out=json.load(sys.stdin).get('stdout','').strip()
print(f\"  Session B 内容: {out}\")
print('✅ T6.8 PASS' if out == 'DONE' else '❌ T6.8 FAIL')
"

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT COUNT(*) FROM session WHERE id='$SID_A'"
psql "$PG_URL" -t -c "SELECT id, state FROM sandbox WHERE session_id='$SID_B'"
```

**期望**：A 删除成功，B 的文件不受影响

### T6.9 sandbox 重建并发

```bash
SIDS=()
for i in {1..3}; do
  SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  SIDS+=($SID)
done

# 先触发 sandbox 创建
for sid in "${SIDS[@]}"; do
  curl -s --max-time 180 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d '{"parts":[{"type":"text","text":"执行 hostname"}],"model":'$MODEL'}' > /dev/null
done

# 销毁所有 sandbox
echo "--- 销毁所有 sandbox ---"
for sid in "${SIDS[@]}"; do
  curl -s -X POST "$BASE/session/$sid/kill-sandbox" > /dev/null
done
sleep 3

# 并发触发重建
echo "--- 并发触发重建 ---"
for sid in "${SIDS[@]}"; do
  curl -s --max-time 120 -X POST "$BASE/session/$sid/exec" \
    -H 'Content-Type: application/json' \
    -d '{"command":"hostname"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"  $sid: exitCode={d.get('exitCode')}, host={d.get('stdout','').strip()[:20]}\")
" &
done
wait

echo "--- PG 验证 ---"
for sid in "${SIDS[@]}"; do
  psql "$PG_URL" -t -c "SELECT '$sid' as sid, id, state FROM sandbox WHERE session_id='$sid'"
done
```

**期望**：3 个 sandbox 全部重建成功

### T6.10 消息队列压力（⛔ 已废弃）

> **废弃原因**：单 session 连续发送 20 条消息属于人造场景，真实用户不会如此操作。opencode 对同一 session 的消息**串行处理**，该用例实际测的是"慢模型 + 串行队列"的吞吐延迟，而非并发隔离能力。并发验证应聚焦 **session 级别**，见 [T6.11](#t611-20-会话--混合任务并发)（20 会话真并发）。原脚本已移除（历史版本见 git 历史），无需执行。

---

## 七、负载压测

### T6.11 20 会话 × 混合任务并发

```bash
# 创建 20 个会话
echo "--- 创建 20 个会话 ---"
SIDS=""
for i in $(seq 1 20); do
  SID=$(curl -s --max-time 15 -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
  SIDS="$SIDS $SID"
  echo "  [$i] $SID"
done

# 发送 20 条异步消息（不同任务）
echo "--- 发送 20 条异步消息 ---"
COUNTER=0
for SID in $SIDS; do
  COUNTER=$((COUNTER + 1))
  TASK="任务编号 $COUNTER"
  
  python3 << EOF > /tmp/payload_${SID}.json
import json
payload = {
    "parts": [{"type": "text", "text": "$TASK"}],
    "model": {"providerID": "zhipuai", "modelID": "glm-5.1"}
}
print(json.dumps(payload))
EOF
  
  curl -s -o /dev/null -w "${SID}:%{http_code}\n" --max-time 10 \
    -X POST "$BASE/session/$SID/prompt_async" \
    -H 'Content-Type: application/json' \
    -d @/tmp/payload_${SID}.json > /tmp/result_${SID}.http &
done
wait

echo "--- HTTP 状态码统计 ---"
cat /tmp/result_ses_*.http 2>/dev/null | cut -d: -f2 | sort | uniq -c | sort -rn

echo "--- 等待处理（90秒） ---"
sleep 90

echo "--- 验证结果 ---"
TOTAL_MSG=0
TOTAL_USER=0
TOTAL_ASSISTANT=0

for SID in $SIDS; do
  USER=$(psql "$PG_URL" -t -c "SELECT COUNT(*) FROM message WHERE session_id='$SID' AND data->>'role'='user'" | tr -d '[:space:]')
  ASSISTANT=$(psql "$PG_URL" -t -c "SELECT COUNT(*) FROM message WHERE session_id='$SID' AND data->>'role'='assistant'" | tr -d '[:space:]')
  TOTAL=$((USER + ASSISTANT))
  TOTAL_MSG=$((TOTAL_MSG + TOTAL))
  TOTAL_USER=$((TOTAL_USER + USER))
  TOTAL_ASSISTANT=$((TOTAL_ASSISTANT + ASSISTANT))
  echo "  $SID: user=$USER, assistant=$ASSISTANT, total=$TOTAL"
done

echo "========================================"
echo "  汇总"
echo "========================================"
echo "总会话数: 20"
echo "总消息数: $TOTAL_MSG (期望>=40)"
echo "  - user: $TOTAL_USER (期望=20)"
echo "  - assistant: $TOTAL_ASSISTANT (期望>=20)"
```

**期望**：
- HTTP：全部 204
- PG：user=20，assistant>=20，总消息数>=40

---

## 验收汇总

| 用例 | 场景 | HTTP | PG | 隔离验证 | 结果 |
|------|------|------|-----|---------|------|
| T6.1 | 并发创建 session | 5 个唯一 ID | 全部 EXISTS=1 | — | ✅ |
| T6.2 | 跨 session 文件隔离 | A/B 独立 | sandbox 不同 | B 看不到 A 文件 | ✅ |
| T6.3 | 并发消息发送 | 全部 204 | 消息数 > 0 | — | ✅ |
| T6.4 | 并发 sandbox 创建 | 5 个成功 | state 正确 | — | ✅ |
| T6.5 | 并发写同名文件 | 各自成功 | — | 内容独立 | ✅ |
| T6.6 | sandbox 崩溃隔离 | B 不受影响 | — | B 文件完整 | ✅ |
| T6.7 | 同 session 并发 exec | 5 个成功 | — | — | ✅ |
| T6.8 | 并发删除+写入 | A 删除, B 成功 | — | B 文件完整 | ✅ |
| T6.9 | sandbox 重建并发 | 3 个重建成功 | state=running | — | ✅ |
| T6.10 | 消息队列压力（⛔ 已废弃） | — | — | 单 session 串行连发，非真实场景 | ⛔ |
| T6.11 | 20 会话混合任务 | 20 条 204 | user=20, assistant>=20 | — | ✅ |

