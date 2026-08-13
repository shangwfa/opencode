# Session 用户标识字段

> 本文档覆盖 `userName` / `userId` 字段在会话消息中的传递、存储和读取。

## 二十五、Session 用户标识

> **前提**：所有测试用例使用 `prompt_async`（异步接口）发送消息，通过轮询等待 assistant 消息 `finish` 字段出现后验证，确保不依赖同步返回、不依赖 sandbox 可用。

### 通用辅助函数

```bash
# 等待 session 中最后一条 assistant 消息出现 finish 字段
# 用法: wait_for_finish $SID $TIMEOUT
# 默认超时 60s
wait_for_finish() {
  local sid=$1 timeout=${2:-60}
  local start=$(date +%s)
  while true; do
    local finished=$(curl -s "$BASE/session/$sid/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for m in reversed(msgs):
    if m.get('info',{}).get('role') == 'assistant' and m.get('info',{}).get('finish'):
        print('done')
        break
" 2>/dev/null)
    if [ "$finished" = "done" ]; then
      return 0
    fi
    local now=$(date +%s)
    if [ $((now - start)) -ge $timeout ]; then
      echo "⚠️ wait_for_finish timed out after ${timeout}s for $sid" >&2
      return 1
    fi
    sleep 2
  done
}
```

### T25.1 发送消息时携带 userName 和 userId

```bash
# 创建 session
SID=$(curl -s -X POST "$BASE/session" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "SID=$SID"

# 发送带用户标识的异步消息
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},"userName":"alice","userId":"user-123"}' \
  -o /dev/null -w "status: %{http_code}\n"
```

**期望**：`status: 204`

### T25.2 消息列表包含 userName 和 userId

```bash
# 等待 AI 回复完成
wait_for_finish "$SID"

# 查询消息列表，验证用户字段
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
user_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'user']
if not user_msgs:
    print('❌ 无 user 消息')
    sys.exit(1)
info = user_msgs[-1]['info']
print(f'  userName: {info.get(\"userName\", \"(missing)\")}')
print(f'  userId: {info.get(\"userId\", \"(missing)\")}')
assert info.get('userName') == 'alice', f'Expected userName=alice, got {info.get(\"userName\")}'
assert info.get('userId') == 'user-123', f'Expected userId=user-123, got {info.get(\"userId\")}'
print('✅ userName/userId 正确持久化')
"
```

**期望**：
- `userName: alice`
- `userId: user-123`
- 字段已正确写入数据库

### T25.3 不传 userName/userId 时消息正常（向后兼容）

```bash
# 新建 session
SID2=$(curl -s -X POST "$BASE/session" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 发送不带用户标识的消息
curl -s -X POST "$BASE/session/$SID2/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' \
  -o /dev/null -w "status: %{http_code}\n"

# 等待完成并验证
wait_for_finish "$SID2"
curl -s "$BASE/session/$SID2/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
user_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'user']
if not user_msgs:
    print('❌ 无 user 消息')
    sys.exit(1)
info = user_msgs[-1]['info']
print(f'  userName: {info.get(\"userName\", \"(none)\")}')
print(f'  userId: {info.get(\"userId\", \"(none)\")}')
assert info.get('userName') is None, f'Expected userName=None, got {info.get(\"userName\")}'
assert info.get('userId') is None, f'Expected userId=None, got {info.get(\"userId\")}'
print('✅ 不传 userName/userId 时向后兼容')
"
```

**期望**：
- `status: 204`
- 消息列表正常返回
- `userName` 和 `userId` 为 `null`

### T25.4 同步消息接口也支持 userName/userId

```bash
SID3=$(curl -s -X POST "$BASE/session" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 使用同步接口发送（POST /message）
RESULT=$(curl -s --max-time 120 -X POST "$BASE/session/$SID3/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"1+1等于几"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},"userName":"bob","userId":"user-456"}')

# 验证消息列表中的用户字段
curl -s "$BASE/session/$SID3/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
user_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'user']
if not user_msgs:
    print('❌ 无 user 消息')
    sys.exit(1)
info = user_msgs[-1]['info']
assert info.get('userName') == 'bob', f'Expected userName=bob, got {info.get(\"userName\")}'
assert info.get('userId') == 'user-456', f'Expected userId=user-456, got {info.get(\"userId\")}'
print('✅ 同步接口 userName/userId 正确')
"
```

**期望**：
- 同步接口正常返回 AI 回复
- `userName: bob`，`userId: user-456`

### T25.5 多轮对话中每条 user 消息独立携带用户标识

```bash
SID4=$(curl -s -X POST "$BASE/session" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 第一轮：alice
curl -s -X POST "$BASE/session/$SID4/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"记住我叫 alice"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},"userName":"alice","userId":"user-111"}' \
  -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$SID4"

# 第二轮：bob
curl -s -X POST "$BASE/session/$SID4/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"我是谁？"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},"userName":"bob","userId":"user-222"}' \
  -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$SID4"

# 验证两条消息各自携带正确的用户标识
curl -s "$BASE/session/$SID4/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
user_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'user']
assert len(user_msgs) >= 2, f'Expected >= 2 user messages, got {len(user_msgs)}'
first = user_msgs[0]['info']
second = user_msgs[1]['info']
assert first.get('userName') == 'alice', f'First msg userName: {first.get(\"userName\")}'
assert first.get('userId') == 'user-111', f'First msg userId: {first.get(\"userId\")}'
assert second.get('userName') == 'bob', f'Second msg userName: {second.get(\"userName\")}'
assert second.get('userId') == 'user-222', f'Second msg userId: {second.get(\"userId\")}'
print('✅ 多轮消息各自携带独立的用户标识')
"
```

**期望**：
- 两条 user 消息分别携带各自的 `userName`/`userId`
- 第一条：`alice` / `user-111`
- 第二条：`bob` / `user-222`

### T25.6 多人协作讨论——同一会话中不同用户交替发言

> 模拟场景：一个会话中，产品经理、前端工程师、后端工程师依次提出需求并讨论，AI 基于上下文连贯回答。

```bash
# 创建协作讨论 session
TEAM_SID=$(curl -s -X POST "$BASE/session" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "TEAM_SID=$TEAM_SID"

# ── 第 1 轮：产品经理 alice 提出需求 ──
echo "=== alice (PM) 提出需求 ==="
curl -s -X POST "$BASE/session/$TEAM_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts":[{"type":"text","text":"我需要一个用户登录功能，支持邮箱和手机号登录，请给出技术方案"}],
    "model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},
    "userName":"alice",
    "userId":"pm-001"
  }' -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$TEAM_SID" 90
echo "  alice 轮次完成"

# ── 第 2 轮：前端工程师 bob 补充前端要求 ──
echo "=== bob (前端) 补充要求 ==="
curl -s -X POST "$BASE/session/$TEAM_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts":[{"type":"text","text":"前端需要 OAuth 第三方登录（GitHub/Google），另外登录页要有记住我功能，请在方案中补充前端部分的接口约定"}],
    "model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},
    "userName":"bob",
    "userId":"fe-002"
  }' -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$TEAM_SID" 90
echo "  bob 轮次完成"

# ── 第 3 轮：后端工程师 carol 补充后端约束 ──
echo "=== carol (后端) 补充约束 ==="
curl -s -X POST "$BASE/session/$TEAM_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts":[{"type":"text","text":"后端用 Node.js + PostgreSQL，需要考虑 token 刷新机制和密码加密存储，请在方案中补充后端实现细节"}],
    "model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},
    "userName":"carol",
    "userId":"be-003"
  }' -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$TEAM_SID" 90
echo "  carol 轮次完成"

# ── 验证：消息列表中每条 user 消息携带正确的用户标识 ──
echo "=== 验证多人协作消息记录 ==="
curl -s "$BASE/session/$TEAM_SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
user_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'user']
print(f'  user 消息总数: {len(user_msgs)}')
assert len(user_msgs) == 3, f'Expected 3 user messages, got {len(user_msgs)}'

expected = [
    {'userName': 'alice', 'userId': 'pm-001'},
    {'userName': 'bob',   'userId': 'fe-002'},
    {'userName': 'carol', 'userId': 'be-003'},
]
for i, exp in enumerate(expected):
    info = user_msgs[i]['info']
    name = info.get('userName')
    uid  = info.get('userId')
    text_preview = ''
    for p in user_msgs[i].get('parts', []):
        if p.get('type') == 'text':
            text_preview = p.get('text', '')[:40]
            break
    print(f'  [{i+1}] {name} ({uid}): {text_preview}...')
    assert name == exp['userName'], f'Msg {i+1}: expected userName={exp[\"userName\"]}, got {name}'
    assert uid  == exp['userId'],   f'Msg {i+1}: expected userId={exp[\"userId\"]}, got {uid}'

# 验证 AI 都回复了
assistant_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'assistant' and m.get('info', {}).get('finish')]
print(f'  assistant 已完成回复数: {len(assistant_msgs)}')
assert len(assistant_msgs) == 3, f'Expected 3 completed assistant replies, got {len(assistant_msgs)}'

print('✅ 三人协作讨论，每人消息标识正确，AI 基于完整上下文回答')
"
```

**期望**：
- 3 条 user 消息分别标识为 `alice/pm-001`、`bob/fe-002`、`carol/be-003`
- AI 每轮都能基于之前的完整上下文回答（产品需求 → 前端补充 → 后端约束）
- 3 条 assistant 消息都有 `finish` 状态
- 消息时间线完整，角色清晰可追溯

### T25.7 多人协作讨论——讨论回顾时按用户筛选消息

> 验证能从消息列表中按 `userId` 筛选出特定用户的所有发言。

```bash
# 复用 T25.6 的 TEAM_SID，按用户筛选
echo "=== 按 userId 筛选 alice 的发言 ==="
curl -s "$BASE/session/$TEAM_SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)

# 筛选 alice 的消息
alice_msgs = [
    m for m in msgs
    if m.get('info', {}).get('role') == 'user'
    and m.get('info', {}).get('userId') == 'pm-001'
]
print(f'  alice 发言数: {len(alice_msgs)}')
assert len(alice_msgs) == 1, f'Expected 1, got {len(alice_msgs)}'

# 筛选 bob 的消息
bob_msgs = [
    m for m in msgs
    if m.get('info', {}).get('role') == 'user'
    and m.get('info', {}).get('userId') == 'fe-002'
]
print(f'  bob 发言数: {len(bob_msgs)}')
assert len(bob_msgs) == 1

# 筛选 carol 的消息
carol_msgs = [
    m for m in msgs
    if m.get('info', {}).get('role') == 'user'
    and m.get('info', {}).get('userId') == 'be-003'
]
print(f'  carol 发言数: {len(carol_msgs)}')
assert len(carol_msgs) == 1

# 统计 assistant 回复数
assistant_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'assistant']
print(f'  assistant 回复数: {len(assistant_msgs)}')

print('✅ 按用户筛选消息正确')
"
```

**期望**：
- 按 `userId` 能精确筛选出各用户的发言
- alice 1 条、bob 1 条、carol 1 条
- assistant 回复与 user 消息一一对应

### T25.8 多人协作讨论——同一用户多轮追问

> 场景：同一会话中，alice 先提问，bob 回答环节追问，alice 再次追问补充，验证消息时序和用户标识交叉正确。

```bash
CROSS_SID=$(curl -s -X POST "$BASE/session" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "CROSS_SID=$CROSS_SID"

# alice 发起
echo "=== alice 发起 ==="
curl -s -X POST "$BASE/session/$CROSS_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"列出 REST API 设计的最佳实践"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},"userName":"alice","userId":"pm-001"}' \
  -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$CROSS_SID" 90

# bob 追问
echo "=== bob 追问 ==="
curl -s -X POST "$BASE/session/$CROSS_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"补充一下 GraphQL 的对比"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},"userName":"bob","userId":"fe-002"}' \
  -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$CROSS_SID" 90

# alice 再次追问
echo "=== alice 再次追问 ==="
curl -s -X POST "$BASE/session/$CROSS_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"给出一个 REST 和 GraphQL 混合架构的例子"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"},"userName":"alice","userId":"pm-001"}' \
  -o /dev/null -w "status: %{http_code}\n"

wait_for_finish "$CROSS_SID" 90

# 验证消息交叉时序和用户标识
curl -s "$BASE/session/$CROSS_SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
user_msgs = [m for m in msgs if m.get('info', {}).get('role') == 'user']
assert len(user_msgs) == 3, f'Expected 3 user messages, got {len(user_msgs)}'

expected_order = [
    ('alice', 'pm-001'),
    ('bob',   'fe-002'),
    ('alice', 'pm-001'),
]
for i, (exp_name, exp_id) in enumerate(expected_order):
    info = user_msgs[i]['info']
    assert info.get('userName') == exp_name, f'Msg {i+1}: userName={info.get(\"userName\")}, expected {exp_name}'
    assert info.get('userId')  == exp_id,   f'Msg {i+1}: userId={info.get(\"userId\")}, expected {exp_id}'

# 验证 alice 的两条消息都能被筛选出来
alice_all = [m for m in user_msgs if m['info'].get('userId') == 'pm-001']
assert len(alice_all) == 2, f'Expected 2 alice messages, got {len(alice_all)}'
bob_all = [m for m in user_msgs if m['info'].get('userId') == 'fe-002']
assert len(bob_all) == 1, f'Expected 1 bob message, got {len(bob_all)}'

# 验证 AI 都回复了
assistant_finished = [m for m in msgs if m.get('info', {}).get('role') == 'assistant' and m.get('info', {}).get('finish')]
assert len(assistant_finished) == 3, f'Expected 3 finished assistant, got {len(assistant_finished)}'

print('✅ 交叉发言时序和用户标识正确，同一用户多轮可追溯，AI 全部回复完成')
"
```

**期望**：
- 消息按发送顺序排列：`alice → bob → alice`
- 同一用户（alice）的多条消息各自独立携带正确标识
- AI 每轮都基于完整历史上下文回答
- 3 条 assistant 消息都有 `finish` 状态
