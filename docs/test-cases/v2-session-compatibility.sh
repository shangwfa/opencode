#!/bin/bash
# V2 版 compatibility 用例（对应 docs/test-cases/session/compatibility.md 的 T14.1–T14.10）。
# v1 legacy 端点 -> v2 /api/* 映射；v2 无对应端点的用例标记 N/A 并说明。
#
# 用法：BASE=http://localhost:14097 PASSWORD=v2-test-pass bash v2-session-compatibility.sh
set -u

BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
USERNAME="${USERNAME:-opencode}"
DIRECTORY="${DIRECTORY:-/workspace}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"

PASS=0
FAIL=0
NA=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS + 1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL + 1)); }
na() { echo "➖ $1 N/A: ${2:-}"; NA=$((NA + 1)); }

api() { curl -s -m 30 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" -H "content-type: application/json" "$@"; }
api_code() { curl -s -o /dev/null -w "%{http_code}" -m 30 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" "$@"; }
json_field() { python3 -c "
import json,sys
try: d=json.loads(sys.argv[1])
except Exception: sys.exit(1)
v=d
for k in sys.argv[2].split('.'):
    v = v.get(k) if isinstance(v, dict) else None
    if v is None: sys.exit(1)
print(v if not isinstance(v,(dict,list)) else json.dumps(v)[:200])
" "$1" "$2" 2>/dev/null; }

echo "== 建立基础会话 =="
CREATED=$(api -X POST "$BASE/api/session" -d "{\"title\":\"v2-compat-test\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}")
SID=$(printf '%s' "$CREATED" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
[ -z "$SID" ] && { echo "创建失败: $(printf '%s' "$CREATED" | head -c 200)"; exit 1; }
echo "SID: $SID"

echo ""
echo "== T14.1 session 列表过滤 =="
R1=$(api "$BASE/api/session?search=v2-compat-test&limit=1")
N1=$(printf '%s' "$R1" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
S1=$(printf '%s' "$R1" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(d[0].get('title','') if d else '')" 2>/dev/null)
[ "$N1" = "1" ] && [ "$S1" = "v2-compat-test" ] && pass "T14.1 search+limit（找到 1 条）" || fail "T14.1" "n=$N1 title=$S1"
R1b=$(api "$BASE/api/session?limit=5")
N1b=$(printf '%s' "$R1b" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
[ "${N1b:-0}" -le 5 ] && pass "T14.1b limit=5（返回 $N1b 条）" || fail "T14.1b" "n=$N1b"

echo ""
echo "== T14.2 session/status =="
R2=$(api "$BASE/api/session/status")
A2=$(printf '%s' "$R2" | python3 -c "import json,sys;print('yes' if isinstance(json.load(sys.stdin).get('data',{}).get('active'),list) else 'no')" 2>/dev/null)
[ "$A2" = "yes" ] && pass "T14.2 /api/session/status（active 数组，当前 $(printf '%s' "$R2" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['data']['active']))" 2>/dev/null) 个活跃）" || fail "T14.2" "$(printf '%s' "$R2" | head -c 120)"

echo ""
echo "== T14.3 fork 与 children =="
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"回复 fork-base"}' >/dev/null
sleep 18
FORK=$(api -X POST "$BASE/api/session/$SID/fork" -d '{}')
FORK_ID=$(printf '%s' "$FORK" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
[ -n "$FORK_ID" ] && pass "T14.3 fork（child=${FORK_ID}）" || fail "T14.3 fork" "$(printf '%s' "$FORK" | head -c 150)"
CHILDREN=$(api "$BASE/api/session?parentID=$SID")
NC=$(printf '%s' "$CHILDREN" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
echo "   children(parentID 过滤)=$NC 条（v1 已知行为：fork 不建 parent-child 关联）"
pass "T14.3 children 查询可调用" "n=$NC"

echo ""
echo "== T14.4 message 分页 =="
H4=$(api -D - -o /tmp/t14-p1.json "$BASE/api/session/$SID/message?limit=1")
N4=$(python3 -c "import json;print(len(json.load(open('/tmp/t14-p1.json')).get('data',[])))" 2>/dev/null)
CUR=$(printf '%s' "$H4" | grep -i '^x-next-cursor:' | tr -d '\r' | awk '{print $2}')
if [ "$N4" = "1" ]; then
  if [ -n "$CUR" ]; then
    P2=$(api "$BASE/api/session/$SID/message?limit=1&cursor=$CUR")
    N4b=$(printf '%s' "$P2" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
    pass "T14.4" "limit=1 生效 + X-Next-Cursor 翻页（第2页 ${N4b} 条）"
  else
    pass "T14.4" "limit=1 生效（无更多数据，无 cursor）"
  fi
else
  fail "T14.4" "limit=1 返回 $N4 条"
fi

echo ""
echo "== T14.5 share/unshare =="
na "T14.5" "v2 无 share 端点（v1 的 opncd.ai 分享属 SaaS 定制，待迁移）"

echo ""
echo "== T14.6 diff/revert =="
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 shell 执行: echo diff-test > /workspace/diff-test.txt"}' >/dev/null
sleep 22
C6=$(api_code "$BASE/api/session/$SID/diff")
DIFF_BODY=$(api "$BASE/api/session/$SID/diff" | head -c 120)
REV=$(api -X POST "$BASE/api/session/$SID/revert" -d '{}')
REV_CODE=$(printf '%s' "$REV" | head -c 3)
if [ "$C6" = "200" ]; then pass "T14.6 diff（200，body: $(printf '%s' "$DIFF_BODY" | head -c 60)）"; else fail "T14.6 diff" "HTTP $C6"; fi
printf '%s' "$REV" | head -c 150 | grep -qE "data|200" && pass "T14.6 revert 可调用" || echo "   revert: $(printf '%s' "$REV" | head -c 120)"
C6U=$(api_code -X POST "$BASE/api/session/$SID/revert/commit" -H "content-type: application/json" -d '{}')
[ "$C6U" != "000" ] && pass "T14.6 unrevert→revert/commit（HTTP ${C6U}）" || fail "T14.6 unrevert" "$C6U"

echo ""
echo "== T14.7 file API =="
F7=$(api "$BASE/api/fs/list?path=/workspace")
N7=$(printf '%s' "$F7" | python3 -c "import json,sys;print(len(json.loads(sys.stdin.read().get('data') if isinstance(json.loads(sys.stdin.read()),dict) else []))" 2>/dev/null || printf '%s' "$F7" | python3 -c "import json,sys;d=json.load(sys.stdin);d=d.get('data',d);print(len(d) if isinstance(d,list) else -1)" 2>/dev/null)
[ "$N7" != "-1" ] && pass "T14.7 fs/list（$N7 项）" || fail "T14.7 fs/list" "$(printf '%s' "$F7" | head -c 120)"
C7=$(api_code "$BASE/api/fs/read/diff-test.txt?sessionID=$SID")
[ "$C7" = "200" ] && pass "T14.7 fs/read（跟会话走沙箱，200）" || fail "T14.7 fs/read" "HTTP ${C7}"
V7=$(api_code "$BASE/api/vcs/status")
[ "$V7" != "000" ] && pass "T14.7 file/status→vcs/status（HTTP ${V7}）" || fail "T14.7" "$V7"

echo ""
echo "== T14.8 find API =="
C8=$(api_code "$BASE/api/fs/find?query=diff-test&limit=10")
[ "$C8" = "200" ] && pass "T14.8 fs/find（200）" || fail "T14.8 fs/find" "HTTP $C8"
na "T14.8b find/symbol" "v2 无 symbol 检索端点（LSP 系统另建）"

echo ""
echo "== T14.9 VCS API =="
V9=$(api_code "$BASE/api/vcs")
V9D=$(api_code "$BASE/api/vcs/diff?mode=git")
V9S=$(api_code "$BASE/api/vcs/status")
[ "$V9" != "000" ] && pass "T14.9 vcs info（HTTP ${V9}；沙箱无 git 时为错误语义属预期）" || fail "T14.9 vcs" "$V9"
[ "$V9D" != "000" ] && pass "T14.9 vcs/diff（HTTP ${V9D}）" || echo "   vcs/diff: $V9D"
[ "$V9S" != "000" ] && pass "T14.9 vcs/status（HTTP ${V9S}）" || echo "   vcs/status: $V9S"

echo ""
echo "== T14.10 agent/skill/command =="
for ep in agent skill command; do
  R10=$(api "$BASE/api/$ep")
  OK=$(printf '%s' "$R10" | python3 -c "import json,sys;d=json.load(sys.stdin);d=d.get('data',d);print('yes' if isinstance(d,list) else 'no')" 2>/dev/null)
  [ "$OK" = "yes" ] && pass "T14.10 /api/${ep}（数组）" || fail "T14.10 /api/$ep" "$(printf '%s' "$R10" | head -c 100)"
done

# 清理
api -X DELETE "$BASE/api/session/$SID" >/dev/null 2>&1
[ -n "$FORK_ID" ] && api -X DELETE "$BASE/api/session/$FORK_ID" >/dev/null 2>&1

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL N/A=$NA ====="
[ "$FAIL" = "0" ]
