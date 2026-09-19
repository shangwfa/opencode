#!/bin/bash
# 会话 appId 用例（session-appid.md T41.x）——v2 端点形状适配版。
#
# 语义：创建传业务侧 appId（校验 [\w\-.]{1,128}）落 sessions.app_id；
# GET /api/session?appId= 按业务维度过滤；默认按 time_updated 降序。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"

PASS=0; FAIL=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }

api() { curl -s -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
code() { curl -s -o /tmp/appid-body.json -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
mk() { api -X POST "$BASE/api/session" -d "$1" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',{});print(d.get('id',''))" 2>/dev/null; }
jqfield() { python3 -c "import json,sys;d=json.load(sys.stdin);d=d.get('data',d);print($1)" 2>/dev/null; }

echo "===== T41.1.1 创建带 appId 并持久化 ====="
R=$(api -X POST "$BASE/api/session" -d '{"appId":"biz-proj-001","title":"app session 1","model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}')
SID1=$(printf '%s' "$R" | jqfield "d.get('id','')")
A1=$(printf '%s' "$R" | jqfield "d.get('appId','MISSING')")
PG1=$(psql "$PG_URL" -tAc "SELECT app_id FROM session_v2 WHERE id='$SID1'" | tr -d ' ')
[ "$A1" = "biz-proj-001" ] && [ "$PG1" = "biz-proj-001" ] && pass "T41.1.1（响应 + PG 落库一致）" "resp=$A1 pg=$PG1" || fail "T41.1.1" "resp=$A1 pg=$PG1"

echo ""
echo "===== T41.1.2 不带 appId ====="
R2=$(api -X POST "$BASE/api/session" -d '{"title":"no app"}')
A2=$(printf '%s' "$R2" | jqfield "repr(d.get('appId'))")
[ "$A2" = "None" ] && pass "T41.1.2（appId 为空）" || fail "T41.1.2" "appId=$A2"

echo ""
echo "===== T41.1.3 非法 appId 被拒绝 ====="
C3=$(code -X POST "$BASE/api/session" -d '{"appId":"bad id!"}')
[ "$C3" = "400" ] && pass "T41.1.3（非法 appId → 400）" || fail "T41.1.3" "http=$C3"

echo ""
echo "===== T41.2.1 按 appId 过滤 ====="
mk '{"appId":"biz-proj-001","title":"a1","model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}' > /dev/null
mk '{"appId":"biz-proj-002","title":"a2","model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}' > /dev/null
mk '{"title":"none","model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}' > /dev/null
LIST=$(api "$BASE/api/session?appId=biz-proj-001&limit=50")
N1=$(printf '%s' "$LIST" | jqfield "len(d)")
ALLMATCH=$(printf '%s' "$LIST" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(all(x.get('appId')=='biz-proj-001' for x in d))" 2>/dev/null)
HAS2=$(printf '%s' "$LIST" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(any(x.get('appId')=='biz-proj-002' for x in d))" 2>/dev/null)
[ "${N1:-0}" -ge 2 ] && [ "$ALLMATCH" = "True" ] && [ "$HAS2" = "False" ] && pass "T41.2.1（只返回匹配 appId）" "count=$N1 allmatch=$ALLMATCH" || fail "T41.2.1" "count=$N1 allmatch=$ALLMATCH has-002=$HAS2"

echo ""
echo "===== T41.2.2 不存在的 appId ====="
N2=$(api "$BASE/api/session?appId=no-such-app" | jqfield "len(d)")
[ "${N2:-1}" = "0" ] && pass "T41.2.2（空列表）" || fail "T41.2.2" "count=$N2"

echo ""
echo "===== T41.2.3 与 limit/search 组合 ====="
C23=$(code "$BASE/api/session?appId=biz-proj-001&limit=10&search=app")
[ "$C23" = "200" ] && pass "T41.2.3（组合参数正交）" "http=$C23" || fail "T41.2.3" "http=$C23"

echo ""
echo "===== T41.3.1 最后活动时间降序 ====="
S_OLD=$(mk '{"appId":"sort-app","title":"older","model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}')
sleep 1
S_NEW=$(mk '{"appId":"sort-app","title":"newer","model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}')
FIRST=$(api "$BASE/api/session?appId=sort-app" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(d[0].get('title',''))" 2>/dev/null)
api -X POST "$BASE/api/session/$S_OLD/prompt" -d '{"text":"回复:好"}' > /dev/null
sleep 12
AFTER=$(api "$BASE/api/session?appId=sort-app" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(d[0].get('title',''))" 2>/dev/null)
DELTA=$(psql "$PG_URL" -tAc "SELECT time_updated-time_created FROM session_v2 WHERE id='$S_OLD'" | tr -d ' ')
if [ "$FIRST" = "newer" ] && [ "$AFTER" = "older" ]; then
  pass "T41.3.1（发消息后排序翻转 newer→older）" "delta=${DELTA}ms"
else
  fail "T41.3.1" "first=$FIRST after=$AFTER delta=$DELTA"
fi

echo ""
echo "===== T41.4.1 消息详情回归 + 详情含 appId ====="
SID4=$(mk '{"appId":"verify-app","title":"verify","model":{"providerID":"'$PROVIDER'","id":"'$MODEL'"}}')
api -X POST "$BASE/api/session/$SID4/prompt" -d '{"text":"1+1等于几"}' > /dev/null
sleep 22
TXT=$(api "$BASE/api/session/$SID4/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='assistant':
        t=' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text').strip()
        if t: print(t)
" 2>/dev/null | tail -1)
DET=$(api "$BASE/api/session/$SID4" | jqfield "d.get('appId','MISSING')")
printf '%s' "$TXT" | grep -q "2" && [ "$DET" = "verify-app" ] && pass "T41.4.1（消息链 + 详情 appId）" "reply=${TXT:0:20}" || fail "T41.4.1" "reply='${TXT:0:30}' detail=$DET"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
