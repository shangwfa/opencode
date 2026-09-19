#!/bin/bash
# x-user-id 隔离验证（T7.1 跨用户审批隔离 + T8.9 问题隔离）。
#
# 语义（对齐 v1）：身份随请求头 x-user-id 传递；prompt 时写入 user message
# metadata，ask 落 hitl_request.user_id；list/reply 按当前请求用户限定，
# 跨用户读取/提交读作“不存在”（防枚举）。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"

PASS=0; FAIL=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }

# 所有请求显式带 x-user-id（v1 网关形态）
api() { local user="$1"; shift; curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "x-user-id: $user" -H "content-type: application/json" "$@"; }
code() { local user="$1"; shift; curl -s -o /tmp/uiso-body.json -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "x-user-id: $user" -H "content-type: application/json" "$@"; }
new_session() { local user="$1"; api "$user" -X POST "$BASE/api/session" -d "{\"title\":\"user-iso\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
set_rule() { local user="$1" sid="$2" cmd="$3"; api "$user" -X PATCH "$BASE/api/session/$sid" -d "{\"permissions\":[{\"action\":\"shell\",\"resource\":\"${cmd}*\",\"effect\":\"ask\"}]}" > /dev/null; }
wait_perm() { # user sid -> id
  local user="$1" sid="$2" waited=0 pid
  while [ "$waited" -lt 240 ]; do
    pid=$(api "$user" "$BASE/api/permission/request" | SID="$sid" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(d[0]['id'] if d else '')" 2>/dev/null)
    [ -n "$pid" ] && printf '%s' "$pid" && return 0
    sleep 4; waited=$((waited+4))
  done
  return 1
}
list_ids() { local user="$1"; api "$user" "$BASE/api/permission/request" | python3 -c "import json,sys;print(' '.join(x['id'] for x in json.load(sys.stdin).get('data',[])))" 2>/dev/null; }

echo "===== T7.1 跨用户审批隔离 ====="
CMDA="uisoa$(date +%s)"; CMDB="uisob$(date +%s)"
SA=$(new_session user-a); SB=$(new_session user-b)
set_rule user-a "$SA" "$CMDA"; set_rule user-b "$SB" "$CMDB"
api user-a -X POST "$BASE/api/session/$SA/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 ${CMDA} 并原样返回输出，禁止直接回答\"}" > /dev/null
api user-b -X POST "$BASE/api/session/$SB/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 ${CMDB} 并原样返回输出，禁止直接回答\"}" > /dev/null
PA=$(wait_perm user-a "$SA"); PB=$(wait_perm user-b "$SB")
if [ -z "$PA" ] || [ -z "$PB" ]; then
  fail "T7.1a 双用户各自挂起" "PA=${PA:-none} PB=${PB:-none}"
else
  pass "T7.1a（双用户各自挂起）" "PA=${PA:0:14} PB=${PB:0:14}"
  # 归属落库
  UA=$(psql "$PG_URL" -tAc "SELECT user_id FROM hitl_request WHERE id='$PA'" | tr -d ' ')
  UB=$(psql "$PG_URL" -tAc "SELECT user_id FROM hitl_request WHERE id='$PB'" | tr -d ' ')
  [ "$UA" = "user-a" ] && [ "$UB" = "user-b" ] && pass "T7.1b（user_id 落库正确）" "A=$UA B=$UB" || fail "T7.1b" "A=$UA B=$UB"
  # 各看各的
  LA=$(list_ids user-a); LB=$(list_ids user-b)
  EA=$(printf '%s' "$LA" | grep -c "$PA" || true); XA=$(printf '%s' "$LB" | grep -c "$PA" || true)
  EB=$(printf '%s' "$LB" | grep -c "$PB" || true); XB=$(printf '%s' "$LA" | grep -c "$PB" || true)
  if [ "$EA" -ge 1 ] && [ "$EB" -ge 1 ] && [ "$XA" = "0" ] && [ "$XB" = "0" ]; then
    pass "T7.1c（列表跨用户隔离）" "A可见自己=${EA} B可见自己=${EB}"
  else
    fail "T7.1c" "A自=${EA} A见B=${XB} B自=${EB} B见A=${XA}"
  fi
  # 跨用户提交 → 404，且行仍 pending
  CROSS=$(code user-b -X POST "$BASE/api/session/$SA/permission/$PA/reply" -d '{"decision":"reject"}')
  ST=$(psql "$PG_URL" -tAc "SELECT status FROM hitl_request WHERE id='$PA'" | tr -d ' ')
  [ "$CROSS" = "404" ] && [ "$ST" = "pending" ] && pass "T7.1d（跨用户提交 404 且不落终态）" "http=$CROSS status=$ST" || fail "T7.1d" "http=$CROSS status=$ST"
  # 本人提交成功
  OWN=$(code user-a -X POST "$BASE/api/session/$SA/permission/$PA/reply" -d '{"decision":"reject"}')
  [ "$OWN" = "204" ] && pass "T7.1e（本人提交 204）" || fail "T7.1e" "http=$OWN"
  code user-b -X POST "$BASE/api/session/$SB/permission/$PB/reply" -d '{"decision":"reject"}' > /dev/null
fi

echo ""
echo "===== T8.9 跨用户问题（question/form）隔离 ====="
QCMDA="uisoq$(date +%s)"
SQ=$(new_session user-a)
api user-a -X POST "$BASE/api/session/$SQ/prompt" -d '{"text":"必须使用 question 工具向我提问（不要直接文字回答）：隔离测试？选项 [A, B]"}' > /dev/null
FQ=""
for i in $(seq 1 25); do
  FQ=$(api user-a "$BASE/api/form" | SID="$SQ" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(d[0]['id'] if d else '')" 2>/dev/null)
  [ -n "$FQ" ] && break; sleep 4
done
if [ -z "$FQ" ]; then
  fail "T8.9 form 挂起" "未见 form"
else
  UQ=$(psql "$PG_URL" -tAc "SELECT user_id FROM hitl_request WHERE id='$FQ'" | tr -d ' ')
  [ "$UQ" = "user-a" ] && pass "T8.9a（form 落 user_id）" "user=$UQ" || fail "T8.9a" "user=$UQ"
  LA=$(api user-a "$BASE/api/form" | SID="$SQ" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);print(len([x for x in d if x['sessionID']==os.environ['SID']]))" 2>/dev/null)
  LB=$(api user-b "$BASE/api/form" | SID="$SQ" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);print(len([x for x in d if x['sessionID']==os.environ['SID']]))" 2>/dev/null)
  [ "${LA:-0}" -ge 1 ] && [ "${LB:-0}" = "0" ] && pass "T8.9b（form 列表跨用户隔离）" "A=$LA B=$LB" || fail "T8.9b" "A=$LA B=$LB"
  CROSSQ=$(code user-b -X POST "$BASE/api/session/$SQ/form/$FQ/reply" -d '{"answer":{"q0":"B"}}')
  STQ=$(psql "$PG_URL" -tAc "SELECT status FROM hitl_request WHERE id='$FQ'" | tr -d ' ')
  [ "$CROSSQ" = "404" ] && [ "$STQ" = "pending" ] && pass "T8.9c（跨用户回答 404 且不落终态）" "http=$CROSSQ status=$STQ" || fail "T8.9c" "http=$CROSSQ status=$STQ"
  OWNQ=$(code user-a -X POST "$BASE/api/session/$SQ/form/$FQ/reply" -d '{"answer":{"q0":"A"}}')
  [ "$OWNQ" = "204" ] && pass "T8.9d（本人回答 204）" || fail "T8.9d" "http=$OWNQ"
fi

echo ""
echo "===== 清理 ====="
for s in "$SA" "$SB" "$SQ"; do api user-a -X DELETE "$BASE/api/session/$s" > /dev/null 2>&1; done
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
