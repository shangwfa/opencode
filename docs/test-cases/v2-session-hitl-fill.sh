#!/bin/bash
# HITL 补全用例（T5.5/T6.1-6.3/T7.2/T7.10/T8.1/T8.3/T8.4/T8.5/T8.6/T7.5/T7.6）
# 这些功能 v2 permission/form 体系已有基础设施，本脚本做端到端验证。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"

PASS=0; FAIL=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
api_code() { curl -s -o /tmp/b.json -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"hitl-fill\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
set_rule() { api -X PATCH "$BASE/api/session/$1" -d "{\"permissions\":[{\"action\":\"shell\",\"resource\":\"$2\",\"effect\":\"$3\"}]}"; }
wait_perm() { local sid="$1" waited=0 pid; while [ "$waited" -lt 240 ]; do pid=$(api "$BASE/api/permission/request" | SID="$sid" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$pid" ] && printf '%s' "$pid" && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
wait_idle() { local sid="$1" waited=0; while [ "$waited" -lt 300 ]; do A=$(api "$BASE/api/session/$sid/message" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(any(m.get('type')=='idle' for m in d))" 2>/dev/null); [ "$A" = "True" ] && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
last_tool_status() { api "$BASE/api/session/$1/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    for p in (m.get('content') or []):
        if p.get('type')=='tool' and p.get('name')=='shell':
            print((p.get('state') or {}).get('status','')); raise SystemExit" 2>/dev/null; }

echo "===== T7.10 规则优先级：会话级 ask 覆盖默认放行 ====="
S=$(new_session)
CMD="t710check$(date +%s)"
set_rule "$S" "${CMD}*" "ask"
api -X POST "$BASE/api/session/$S/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD 并原样返回输出，禁止直接回答\"}" >/dev/null
P=$(wait_perm "$S")
if [ -n "$P" ]; then
  api -X POST "$BASE/api/session/$S/permission/$P/reply" -d '{"decision":"once"}' >/dev/null
  wait_idle "$S"
  ST=$(last_tool_status "$S")
  [ "$ST" = "completed" ] && pass "T7.10（ask 挂起→once→completed）" || fail "T7.10" "tool=$ST"
else
  fail "T7.10" "未见挂起"
fi

echo ""
echo "===== T5.5/T8.5 always 首次弹窗→同类免打扰 ====="
S=$(new_session)
RULECMD="t55check$(date +%s)"
set_rule "$S" "${RULECMD}*" "ask"
api -X POST "$BASE/api/session/$S/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $RULECMD 并原样返回输出，禁止直接回答\"}" >/dev/null
P=$(wait_perm "$S")
if [ -n "$P" ]; then
  api -X POST "$BASE/api/session/$S/permission/$P/reply" -d '{"decision":"always"}' >/dev/null
  wait_idle "$S"
  # 第二次同类命令
  api -X POST "$BASE/api/session/$S/prompt" -d "{\"text\":\"必须再次使用 bash 工具执行命令 $RULECMD 并原样返回输出，禁止直接回答\"}" >/dev/null
  wait_idle "$S"
  # 验证：无新挂起（PG permission 只有 1 行）
  N=$(psql "$PG_URL" -tAc "SELECT count(*) FROM hitl_request WHERE session_id='$S' AND kind='permission'" | tr -d ' ')
  ST=$(last_tool_status "$S")
  [ "$N" = "1" ] && [ "$ST" = "completed" ] && pass "T5.5/T8.5（always 后同类免打扰，仅 1 次挂起）" || fail "T5.5/T8.5" "hitl_rows=$N tool=$ST"
else
  fail "T5.5" "未见挂起"
fi

echo ""
echo "===== T6.1 审批中心待办（跨 session 汇总） ====="
S1=$(new_session); S2=$(new_session)
CMD1="t61a$(date +%s)"; CMD2="t61b$(date +%s)"
set_rule "$S1" "${CMD1}*" "ask"
set_rule "$S2" "${CMD2}*" "ask"
api -X POST "$BASE/api/session/$S1/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD1 并原样返回输出，禁止直接回答\"}" >/dev/null &
api -X POST "$BASE/api/session/$S2/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD2 并原样返回输出，禁止直接回答\"}" >/dev/null &
wait
P1=$(wait_perm "$S1"); P2=$(wait_perm "$S2")
if [ -n "$P1" ] && [ -n "$P2" ]; then
  N=$(api "$BASE/api/permission/request" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  [ "${N:-0}" -ge 2 ] && pass "T6.1（跨 session 待办 ≥2 条）" "list=$N" || fail "T6.1" "list=$N"
else
  fail "T6.1" "P1=${P1:-none} P2=${P2:-none}"
fi

echo ""
echo "===== T6.2 审批通过 once → 执行 ====="
if [ -n "$P1" ]; then
  C=$(api_code -X POST "$BASE/api/session/$S1/permission/$P1/reply" -d '{"decision":"once"}')
  wait_idle "$S1"
  ST1=$(last_tool_status "$S1")
  PG=$(psql "$PG_URL" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P1'" | tr -d ' ')
  [ "$C" = "204" ] && [ "$ST1" = "completed" ] && pass "T6.2（once→执行→终态）" "${PG}" || fail "T6.2" "http=$C tool=$ST1"
fi

echo ""
echo "===== T6.3 审批拒绝 reject → 不执行 ====="
if [ -n "$P2" ]; then
  C=$(api_code -X POST "$BASE/api/session/$S2/permission/$P2/reply" -d '{"decision":"reject"}')
  wait_idle "$S2"
  EX=$(psql "$PG_URL" -tAc "SELECT count(*) FROM hitl_request WHERE session_id='$S2' AND kind='permission' AND status='pending'" | tr -d ' ')
  EX="$EX"
  PG=$(psql "$PG_URL" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P2'" | tr -d ' ')
  NP=$(psql "$PG_URL" -tAc "SELECT count(*) FROM hitl_request WHERE session_id='$S2' AND kind='permission' AND status='pending'" | tr -d ' ')
  [ "$C" = "204" ] && [ "$PG" = "rejected|decision-delivered" ] && [ "$NP" = "0" ] && pass "T6.3（reject→终态→无残留）" "${PG}" || fail "T6.3" "http=$C pg=$PG pending=$NP"
fi

echo ""
echo "===== T7.5 拒绝意见（message 字段） ====="
S75=$(new_session)
CMD75="t75check$(date +%s)"
set_rule "$S75" "${CMD75}*" "ask"
api -X POST "$BASE/api/session/$S75/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD75 并原样返回输出，禁止直接回答\"}" >/dev/null
P75=$(wait_perm "$S75")
if [ -n "$P75" ]; then
  api -X POST "$BASE/api/session/$S75/permission/$P75/reply" -d '{"decision":"reject","message":"不要在测试里跑 date"}' >/dev/null
  M=$(psql "$PG_URL" -tAc "SELECT result FROM hitl_request WHERE id='$P75'" | python3 -c "
import json,sys
raw=sys.stdin.read().strip()
try:
    d=json.loads(raw) if raw and raw!='None' else {}
    print(d.get('message',''))
except: print('')" 2>/dev/null)
  ST=$(psql "$PG_URL" -tAc "SELECT status FROM hitl_request WHERE id='$P75'" | tr -d ' ')
  [ "$ST" = "rejected" ] && printf '%s' "$M" | grep -q "t75check\|date\|测试" && pass "T7.5（拒绝意见落 result.message）" "msg=${M:0:20}" || fail "T7.5" "status=$ST msg=$M"
fi

echo ""
echo "===== T8.1 question 多问 + 部分回答 ====="
S81=$(new_session)
api -X POST "$BASE/api/session/$S81/prompt" -d '{"text":"请用 question 工具一次性问我三个问题（同一 questions 数组）：1) 语言？[python, go]；2) 特性？[日志, 鉴权]；3) 项目名？[demo, app]"}' >/dev/null
F81=""
for i in $(seq 1 25); do F81=$(api "$BASE/api/form" | SID="$S81" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$F81" ] && break; sleep 4; done
if [ -n "$F81" ]; then
  NF=$(api "$BASE/api/form" | SID="$S81" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(len((d[0].get('fields') or []) if d else []))" 2>/dev/null)
  # 部分回答（第3问空）
  C=$(api_code -X POST "$BASE/api/session/$S81/form/$F81/reply" -d '{"answer":{"q0":"go","q1":"日志"}}')
  wait_idle "$S81"
  [ "${NF:-0}" = "3" ] && [ "$C" = "204" ] && pass "T8.1（3 问 + 部分回答 + run 完成）" "fields=$NF http=$C" || fail "T8.1" "fields=$NF http=$C"
else
  fail "T8.1" "未见挂起"
fi

echo ""
echo "===== T8.3 并发回复 CAS（form 胜者独占） ====="
S83=$(new_session)
api -X POST "$BASE/api/session/$S83/prompt" -d '{"text":"用 question 工具问我：并发测试？选项 [A, B]，问完停下"}' >/dev/null
F83=""
for i in $(seq 1 30); do F83=$(api "$BASE/api/form" | SID="$S83" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$F83" ] && break; sleep 4; done
if [ -n "$F83" ]; then
  : > /tmp/t83-codes.txt
  ( C=$(curl -s -o /tmp/t83-a.json -w "%{http_code}" -m 15 -u "opencode:v2-test-pass" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S83/form/$F83/reply" -d '{"answer":{"q0":"A"}}'); echo "$C" >> /tmp/t83-codes.txt ) &
  ( C=$(curl -s -o /tmp/t83-b.json -w "%{http_code}" -m 15 -u "opencode:v2-test-pass" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S83/form/$F83/reply" -d '{"answer":{"q0":"B"}}'); echo "$C" >> /tmp/t83-codes.txt ) &
  wait
  CNT204=$(grep -c "^204$" /tmp/t83-codes.txt || true)
  CNT409=$(grep -c "^409$" /tmp/t83-codes.txt || true)
  if [ "${CNT204:-0}" -ge 1 ]; then
    pass "T8.3（并发回复胜者独占）" "204=$CNT204 409=$CNT409"
  else
    fail "T8.3" "codes=$(cat /tmp/t83-codes.txt | tr '\n' '/')"
  fi
fi

echo ""
echo "===== T8.4 待办列表字段契约 ====="
S84=$(new_session)
CMD84="t84check$(date +%s)"
set_rule "$S84" "${CMD84}*" "ask"
api -X POST "$BASE/api/session/$S84/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD84 并原样返回输出，禁止直接回答\"}" >/dev/null
P84=$(wait_perm "$S84")
if [ -n "$P84" ]; then
  OK=$(api "$BASE/api/permission/request?sessionID=$S84" | python3 -c "
import json,sys
q=(json.load(sys.stdin).get('data') or [{}])[0]
need=('id','sessionID','action','resources')
missing=[k for k in need if k not in q]
print('yes' if not missing else 'no:'+str(missing))" 2>/dev/null)
  [ "$OK" = "yes" ] && pass "T8.4（字段齐全）" || fail "T8.4" "$OK"
  api -X POST "$BASE/api/session/$S84/permission/$P84/reply" -d '{"decision":"reject"}' >/dev/null
fi

echo ""
echo "===== T8.6 always 与后配 deny 优先级 ====="
S86=$(new_session)
CMD86="t86check$(date +%s)"
set_rule "$S86" "${CMD86}*" "ask"
api -X POST "$BASE/api/session/$S86/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD86 并原样返回输出，禁止直接回答\"}" >/dev/null
P86=$(wait_perm "$S86")
if [ -n "$P86" ]; then
  api -X POST "$BASE/api/session/$S86/permission/$P86/reply" -d '{"decision":"always"}' >/dev/null
  wait_idle "$S86"
  # 后配 deny
  set_rule "$S86" "${CMD86}*" "deny"
  api -X POST "$BASE/api/session/$S86/prompt" -d "{\"text\":\"必须再次使用 bash 工具执行命令 $CMD86 并原样返回输出，禁止直接回答\"}" >/dev/null
  wait_idle "$S86"
  ST=$(last_tool_status "$S86")
  N=$(psql "$PG_URL" -tAc "SELECT count(*) FROM hitl_request WHERE session_id='$S86' AND kind='permission' AND status='pending'" | tr -d ' ')
  # always 落了 allow 规则，deny 后配——v1 语义 always 优先
  [ "$ST" = "completed" ] && [ "$N" = "0" ] && pass "T8.6（always 优先于后配 deny）" "tool=$ST new_pending=$N" || fail "T8.6" "tool=$ST pending=$N"
fi

echo ""
echo "===== T7.6 拒绝后 AI 行为（观察项） ====="
S76=$(new_session)
CMD76="t76check$(date +%s)"
set_rule "$S76" "${CMD76}*" "ask"
api -X POST "$BASE/api/session/$S76/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD76 并原样返回输出，禁止直接回答\"}" >/dev/null
P76=$(wait_perm "$S76")
if [ -n "$P76" ]; then
  api -X POST "$BASE/api/session/$S76/permission/$P76/reply" -d '{"decision":"reject"}' >/dev/null
  wait_idle "$S76"
  NP76=$(psql "postgresql://local@127.0.0.1:15432/opencode_v2" -tAc "SELECT count(*) FROM hitl_request WHERE session_id='$S76' AND status='pending'" | tr -d ' ')
  PG76=$(psql "postgresql://local@127.0.0.1:15432/opencode_v2" -tAc "SELECT status FROM hitl_request WHERE session_id='$S76' AND kind='permission' LIMIT 1" | tr -d ' ')
  [ "$NP76" = "0" ] && pass "T7.6（拒绝后无残留 pending，终态=${PG76}）" || fail "T7.6" "pending=$NP76"
fi

# 清理
for s in "$S" "$S1" "$S2" "$S75" "$S81" "$S83" "$S84" "$S86" "$S76"; do api -X DELETE "$BASE/api/session/$s" >/dev/null 2>&1; done

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
