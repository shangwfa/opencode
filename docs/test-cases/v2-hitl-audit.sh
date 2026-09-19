#!/bin/bash
# T7.7 拒绝审计（exec_log）验证：deny 规则命中 → 落 exec_log（source=permission-deny）。
# 对齐 v1 recordDenial：deny 不弹窗、直接拒绝，审计是唯一记录。
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
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"audit\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }

echo "===== T7.7 deny 审计落 exec_log ====="
CMD="t77deny$(date +%s)"
SID=$(new_session)
api -X PATCH "$BASE/api/session/$SID" -d "{\"permissions\":[{\"action\":\"shell\",\"resource\":\"${CMD}*\",\"effect\":\"deny\"}]}" > /dev/null
api -X POST "$BASE/api/session/$SID/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $CMD 并原样返回输出，禁止直接回答\"}" > /dev/null
sleep 25

ROW=$(psql "$PG_URL" -tAc "SELECT source||'|'||status||'|'||coalesce(rule,'-')||'|'||substring(command,1,90) FROM exec_log WHERE session_id='$SID' ORDER BY time_created DESC LIMIT 1")
echo "   审计行: $ROW"
if printf '%s' "$ROW" | grep -q "^permission-deny|denied|"; then
  pass "T7.7a（source=permission-deny + status=denied + rule）" "${ROW:0:70}"
else
  fail "T7.7a" "row=$ROW"
fi
# 命令载荷含 permission/patterns
if printf '%s' "$ROW" | grep -q "permission"; then
  pass "T7.7b（command 载荷含 permission/patterns）"
else
  fail "T7.7b" "row=$ROW"
fi
# deny 不产生待办
N=$(api "$BASE/api/permission/request" | SID="$SID" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);print(len([x for x in d if x['sessionID']==os.environ['SID']]))" 2>/dev/null)
[ "${N:-1}" = "0" ] && pass "T7.7c（deny 不落待办）" || fail "T7.7c" "pending=$N"
# 会话删除级联清理审计行（v1 FK cascade）
api -X DELETE "$BASE/api/session/$SID" > /dev/null
sleep 2
LEFT=$(psql "$PG_URL" -tAc "SELECT count(*) FROM exec_log WHERE session_id='$SID'" | tr -d ' ')
[ "${LEFT:-1}" = "0" ] && pass "T7.7d（会话删除级联清理审计行）" || fail "T7.7d" "left=$LEFT"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
