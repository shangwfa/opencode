#!/bin/bash
# 会话用户标识字段用例（session-user-fields.md T25.1-T25.8）——v2 适配版。
#
# v1→v2 映射：userName/userId 由网关请求头 x-user-name / x-user-id 传递，
# 服务端写入 user message 的 metadata；message 列表以 {type, text, metadata}
# 返回（v1 是 {info, parts}）。v1 的 prompt_async / 同步双接口在 v2 合并为
# session.prompt：响应 data.payload.metadata 即 admission 回显。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"

PASS=0; FAIL=0; SKIP=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "➖ $1 SKIP: ${2:-}"; SKIP=$((SKIP+1)); }

api() { # uname uid -- curl args...
  local uname="$1" uid="$2"; shift 2
  curl -s -m 200 -u "opencode:$PASSWORD" \
    -H "x-opencode-directory: /workspace" -H "x-user-id: $uid" -H "x-user-name: $uname" \
    -H "content-type: application/json" "$@"
}
new_session() { # uid uname -> session id
  api "$1" "$2" -X POST "$BASE/api/session" \
    -d "{\"title\":\"user-fields\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" |
    python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null
}
prompt() { # uid uname sid text -> admission echo json
  local body
  body=$(python3 -c "import json,sys;print(json.dumps({'text':sys.argv[1]}))" "$4")
  api "$1" "$2" -X POST "$BASE/api/session/$3/prompt" -d "$body"
}
wait_finished() { # sid expected -> wait until >= expected finished assistant messages
  # A prior turn's idle marker persists, so waiting on "any idle" returns early.
  # Wait for the finished-assistant count instead (v1 wait_for_finish semantics).
  local i ok
  for i in $(seq 1 80); do
    ok=$(assistant_finished "$1")
    [ "${ok:-0}" -ge "$2" ] && return 0
    sleep 3
  done
  return 1
}
user_meta() { # sid -> lines "userName|userId" for user messages, oldest first
  # v2 message list is newest-first; reverse to chronological order.
  api "" "" "$BASE/api/session/$1/message" | python3 -c "
import json,sys
rows=[m for m in json.load(sys.stdin).get('data',[]) if m.get('type')=='user']
for m in reversed(rows):
    md=m.get('metadata') or {}
    print(str(md.get('userName',''))+'|'+str(md.get('userId','')))" 2>/dev/null
}
assistant_finished() { # sid -> count of finished assistant messages
  api "" "" "$BASE/api/session/$1/message" |
    python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(sum(1 for m in d if m.get('type')=='assistant' and m.get('finish')))" 2>/dev/null
}

echo "===== T25.1 发送消息时携带 userName/userId ====="
SID=$(new_session alice user-123)
ECHO1=$(prompt alice user-123 "$SID" "hello")
M1=$(printf '%s' "$ECHO1" | python3 -c "import json,sys;md=(json.load(sys.stdin).get('data',{}).get('payload',{}) or {}).get('metadata',{}) or {};print(f\"{md.get('userName','')}|{md.get('userId','')}\")" 2>/dev/null)
[ "$M1" = "alice|user-123" ] && pass "T25.1（admission 回显用户标识）" "$M1" || fail "T25.1" "meta=$M1 echo=${ECHO1:0:120}"

echo ""
echo "===== T25.2 消息列表包含 userName/userId ====="
wait_finished "$SID" 1
[ "$(user_meta "$SID")" = "alice|user-123" ] && pass "T25.2（userName/userId 正确持久化）" "$(user_meta "$SID" | tr '\n' ' ')" || fail "T25.2" "meta=$(user_meta "$SID" | tr '\n' ' ')"
PGU=$(psql "$PG_URL" -tAc "SELECT data::jsonb->'metadata'->>'userId' FROM session_message WHERE session_id='$SID' AND type='user' ORDER BY seq DESC LIMIT 1" | tr -d ' ')
[ "$PGU" = "user-123" ] && pass "T25.2-db（落库校验）" "userId=$PGU" || fail "T25.2-db" "userId=$PGU"

echo ""
echo "===== T25.3 不传 userName/userId 时向后兼容 ====="
SID2=$(new_session "" "")
prompt "" "" "$SID2" "hello" >/dev/null
wait_finished "$SID2" 1
M3=$(user_meta "$SID2")
[ "$M3" = "|" ] && pass "T25.3（无标识 → metadata 为空）" "meta=$M3" || fail "T25.3" "meta=$M3"

echo ""
echo "===== T25.4 admission 回显即同步面（v2 单端点） ====="
SID3=$(new_session bob user-456)
ECHO4=$(prompt bob user-456 "$SID3" "1+1等于几")
M4=$(printf '%s' "$ECHO4" | python3 -c "import json,sys;md=(json.load(sys.stdin).get('data',{}).get('payload',{}) or {}).get('metadata',{}) or {};print(f\"{md.get('userName','')}|{md.get('userId','')}\")" 2>/dev/null)
wait_finished "$SID3" 1
L4=$(user_meta "$SID3")
if [ "$M4" = "bob|user-456" ] && [ "$L4" = "bob|user-456" ]; then
  pass "T25.4（回显与列表一致）" "$M4"
else
  fail "T25.4" "echo=$M4 list=$(printf '%s' "$L4" | tr '\n' ' ')"
fi

echo ""
echo "===== T25.5 多轮对话每条 user 消息独立携带标识 ====="
SID4=$(new_session alice user-111)
prompt alice user-111 "$SID4" "记住我叫 alice" >/dev/null
wait_finished "$SID4" 1
prompt bob user-222 "$SID4" "我是谁？" >/dev/null
wait_finished "$SID4" 2
M5=$(user_meta "$SID4" | tr '\n' ',')
[ "$M5" = "alice|user-111,bob|user-222," ] && pass "T25.5（多轮各自独立）" "$M5" || fail "T25.5" "$M5"

echo ""
echo "===== T25.6 多人协作讨论（三人依次发言） ====="
TEAM=$(new_session alice pm-001)
prompt alice pm-001 "$TEAM" "我需要一个用户登录功能，支持邮箱和手机号登录，请给出技术方案" >/dev/null
wait_finished "$TEAM" 1
prompt bob fe-002 "$TEAM" "前端需要 OAuth 第三方登录（GitHub/Google），另外登录页要有记住我功能，请在方案中补充前端部分的接口约定" >/dev/null
wait_finished "$TEAM" 2
prompt carol be-003 "$TEAM" "后端用 Node.js + PostgreSQL，需要考虑 token 刷新机制和密码加密存储，请在方案中补充后端实现细节" >/dev/null
wait_finished "$TEAM" 3
M6=$(user_meta "$TEAM" | tr '\n' ',')
AF=$(assistant_finished "$TEAM")
[ "$M6" = "alice|pm-001,bob|fe-002,carol|be-003," ] && pass "T25.6a（三人标识正确）" "$M6" || fail "T25.6a" "$M6"
[ "${AF:-0}" -ge 3 ] && pass "T25.6b（AI 每轮均有回复）" "assistant=$AF" || fail "T25.6b" "assistant=$AF"

echo ""
echo "===== T25.7 按 userId 筛选消息 ====="
CNT=$(api "" "" "$BASE/api/session/$TEAM/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
u=lambda uid: sum(1 for m in d if m.get('type')=='user' and (m.get('metadata') or {}).get('userId')==uid)
print(f'{u(\"pm-001\")},{u(\"fe-002\")},{u(\"be-003\")}')" 2>/dev/null)
[ "$CNT" = "1,1,1" ] && pass "T25.7（按 userId 精确筛选）" "$CNT" || fail "T25.7" "$CNT"

echo ""
echo "===== T25.8 同一用户多轮追问（交叉时序） ====="
CROSS=$(new_session alice pm-001)
prompt alice pm-001 "$CROSS" "列出 REST API 设计的最佳实践" >/dev/null
wait_finished "$CROSS" 1
prompt bob fe-002 "$CROSS" "补充一下 GraphQL 的对比" >/dev/null
wait_finished "$CROSS" 2
prompt alice pm-001 "$CROSS" "给出一个 REST 和 GraphQL 混合架构的例子" >/dev/null
wait_finished "$CROSS" 3
M8=$(user_meta "$CROSS" | tr '\n' ',')
ALICE8=$(user_meta "$CROSS" | grep -c '^alice|pm-001$' || true)
AF8=$(assistant_finished "$CROSS")
if [ "$M8" = "alice|pm-001,bob|fe-002,alice|pm-001," ] && [ "${ALICE8:-0}" = "2" ] && [ "${AF8:-0}" -ge 3 ]; then
  pass "T25.8（交叉时序/同人多轮可追溯）" "alice=$ALICE8 assistant=$AF8"
else
  fail "T25.8" "order=$M8 alice=$ALICE8 assistant=$AF8"
fi

echo ""
echo "===== 清理 ====="
for s in "$SID" "$SID2" "$SID3" "$SID4" "$TEAM" "$CROSS"; do api "" "" -X DELETE "$BASE/api/session/$s" >/dev/null 2>&1; done
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
[ "$FAIL" = "0" ]
