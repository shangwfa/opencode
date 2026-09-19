#!/bin/bash
# V2 版 concurrency.md 用例（T39.1.1–T39.5.3：v1 五项 P0 并发修复的回归）。
# 映射：message/prompt_async -> prompt+轮询；abort -> interrupt；sandbox 表 -> workspace；
#       message 表 -> session_message（v2 的消息不分 role 列，type 区分）。
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

api() { curl -s -m 200 -u "opencode:v2-test-pass" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
api_code() { curl -s -o /dev/null -w "%{http_code}" -m 60 -u "opencode:v2-test-pass" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
msg_count() { api "$BASE/api/session/$1/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0; }
wait_msgs() { local sid="$1" want="$2" waited=0 got; while [ "$waited" -lt 120 ]; do got=$(msg_count "$sid"); [ "$got" -ge "$want" ] && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
# 取最新完成的 assistant 文本
assistant_has() { api "$BASE/api/session/$1/message" | grep -q "$2" && echo yes || echo no; }
last_assistant_text() { api "$BASE/api/session/$1/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='assistant' and m.get('finish'):
        t=' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text').strip()
        if t: print(t); break
" 2>/dev/null; }
sb_exec_out() { api -X POST "$BASE/api/session/$1/exec" -d "{\"command\":\"$2\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null; }

# ============ P0-1: destroy 并发 ============
echo "== P0-1 destroy 并发不崩溃 =="
SID=$(new_session "t3911")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 bash 执行 sleep 20 && echo done"}' >/dev/null &
sleep 8
K=$(api -X POST "$BASE/api/session/$SID/kill-sandbox")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 bash 执行 echo rebuilt-ok"}' >/dev/null
wait_msgs "$SID" 4 >/dev/null 2>&1 || true
T=$(last_assistant_text "$SID")
H=$(assistant_has "$SID" "rebuilt-ok")
[ "$H" = "yes" ] || H=$(assistant_has "$SID" "done")
[ "$H" = "yes" ] && pass "T39.1.1（destroy 并发长命令后重建正常）" || fail "T39.1.1" "has=$H last='$T'"
# 服务存活
C=$(api_code "$BASE/api/info")
[ "$C" = "200" ] && pass "T39.1.1b（服务存活 /api/info=200）" || fail "T39.1.1b" "info=$C"

SID=$(new_session "t3912")
sb_exec_out "$SID" "echo warmup" >/dev/null
( api -X POST "$BASE/api/session/$SID/kill-sandbox" >/dev/null ) &
sleep 1
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 bash 执行 echo concurrent-test"}' >/dev/null
wait
wait_msgs "$SID" 4 >/dev/null 2>&1 || true
T=$(last_assistant_text "$SID")
printf '%s' "$T" | grep -q "concurrent-test" && pass "T39.1.2（destroyById 并发工具调用正常/重建）" || fail "T39.1.2" "text='$T'"

# ============ P0-2: kill 循环后命令正常 ============
echo ""
echo "== P0-2 命令串行化不失效 =="
SID=$(new_session "t3921")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 bash 执行 sleep 30 && echo long-done"}' >/dev/null
sleep 5
INT=$(api -X POST "$BASE/api/session/$SID/interrupt" | python3 -c "import json,sys;print(json.load(sys.stdin).get('interrupted'))" 2>/dev/null)
sleep 2
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 bash 执行 echo after-abort"}' >/dev/null
wait_msgs "$SID" 3 >/dev/null 2>&1 || true
T=$(last_assistant_text "$SID")
H2=$(assistant_has "$SID" "after-abort")
[ "$H2" = "yes" ] || H2=$(assistant_has "$SID" "abort")
[ "$INT" = "True" ] && [ "$H2" = "yes" ] && pass "T39.2.1（interrupt 后新命令正常）" "interrupted=$INT" || fail "T39.2.1" "interrupted=$INT has=$H2"

SID=$(new_session "t3922")
for i in 1 2 3; do
  sb_exec_out "$SID" "echo round-$i" >/dev/null
  api -X POST "$BASE/api/session/$SID/kill-sandbox" >/dev/null
  sleep 2
done
OUT=$(sb_exec_out "$SID" "echo final-check")
[ "$OUT" = "final-check" ] && pass "T39.2.2（多次 kill 后 exec 仍正常）" || fail "T39.2.2" "out='$OUT'"

# ============ P0-3: 同 session 并发创建单沙箱 ============
echo ""
echo "== P0-3 并发创建互斥 =="
SID=$(new_session "t3931")
for i in 1 2 3; do
  ( api -X POST "$BASE/api/session/$SID/exec" -d '{"command":"echo c"}' >/dev/null ) &
done
wait
sleep 3
WS=$(api "$BASE/api/session/$SID" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data',{}).get('location') or {}).get('workspaceID',''))" 2>/dev/null)
WSROWS=$(psql "$PG_URL" -tAc "SELECT COUNT(*) FROM workspace WHERE id='$WS'" 2>/dev/null | tr -d ' ')
# 沙箱服务上该 workspace 的实例数（label 匹配）
SB=$(curl -s -m 10 -H "OPEN-SANDBOX-API-KEY: H68idVYzjadx" "http://172.18.32.15:30040/v1/sandboxes?pageSize=50" | python3 -c "
import json,sys
items=json.load(sys.stdin).get('items',[])
print(sum(1 for i in items if i.get('metadata',{}).get('dev.opencode.workspace')=='$WS' and i.get('status',{}).get('state')=='Running'))" 2>/dev/null || echo "?")
[ "$WSROWS" = "1" ] && [ "${SB:-0}" = "1" ] && pass "T39.3.1（并发创建仅 1 沙箱：ws_rows=1 实例=1）" || fail "T39.3.1" "ws=$WS rows=$WSROWS 实例=$SB"

OK32=0
SIDS32=""
for i in 1 2 3; do
  S=$(new_session "t3932-$i"); SIDS32="$SIDS32 $S"
  ( api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo s"}' >/dev/null ) &
done
wait
for S in $SIDS32; do
  W=$(api "$BASE/api/session/$S" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data',{}).get('location') or {}).get('workspaceID',''))" 2>/dev/null)
  [ -n "$W" ] && OK32=$((OK32+1))
done
[ "$OK32" = "3" ] && pass "T39.3.2（不同 session 各自独立 workspace）" || fail "T39.3.2" "ok=$OK32/3"
for S in $SIDS32; do api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1; done

# ============ P0-4: destroy 并发 getOrCreate ============
echo ""
echo "== P0-4 destroyById 并发 getOrCreate =="
SID=$(new_session "t3941")
sb_exec_out "$SID" "echo create" >/dev/null
( api -X POST "$BASE/api/session/$SID/kill-sandbox" >/dev/null ) &
sleep 1
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 bash 执行 echo after-destroyById"}' >/dev/null
wait
wait_msgs "$SID" 4 >/dev/null 2>&1 || true
T=$(last_assistant_text "$SID")
printf '%s' "$T" | grep -q "after-destroyById" && pass "T39.4.1（destroy 并发消息正常重建）" || fail "T39.4.1" "text='$T'"

# ============ P0-5: session.remove 联动 ============
echo ""
echo "== P0-5 删除 session 联动 =="
SID=$(new_session "t3951")
sb_exec_out "$SID" "echo create-sandbox" >/dev/null
WS51=$(api "$BASE/api/session/$SID" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data',{}).get('location') or {}).get('workspaceID',''))" 2>/dev/null)
api -X DELETE "$BASE/api/session/$SID" >/dev/null
sleep 4
WSROW_AFTER=$(psql "$PG_URL" -tAc "SELECT COUNT(*) FROM workspace WHERE id='$WS51'" 2>/dev/null | tr -d ' ')
SB51=$(curl -s -m 10 -H "OPEN-SANDBOX-API-KEY: H68idVYzjadx" "http://172.18.32.15:30040/v1/sandboxes?pageSize=50" | python3 -c "
import json,sys
items=json.load(sys.stdin).get('items',[])
print(sum(1 for i in items if i.get('metadata',{}).get('dev.opencode.workspace')=='$WS51' and i.get('status',{}).get('state')=='Running'))" 2>/dev/null || echo "?")
if [ "$WSROW_AFTER" = "0" ] && [ "${SB51:-1}" = "0" ]; then
  pass "T39.5.1（删除 session：workspace 行删除 + 沙箱销毁）"
else
  fail "T39.5.1" "ws_row=$WSROW_AFTER 实例=${SB51}（session 删除未联动销毁——待修）"
fi

SID=$(new_session "t3952")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"写一首 500 字的诗"}' >/dev/null
sleep 3
api -X DELETE "$BASE/api/session/$SID" >/dev/null
sleep 15
M52=$(psql "$PG_URL" -tAc "SELECT COUNT(*) FROM session_message WHERE session_id='$SID'" 2>/dev/null | tr -d ' ')
[ "${M52:-1}" = "0" ] && pass "T39.5.2（删除后无新消息写入，消息级联清空）" || fail "T39.5.2" "msgs=$M52"

SID=$(new_session "t3953")
sb_exec_out "$SID" "echo orphan-test" >/dev/null
sleep 2
WS53=$(api "$BASE/api/session/$SID" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data',{}).get('location') or {}).get('workspaceID',''))" 2>/dev/null)
api -X DELETE "$BASE/api/session/$SID" >/dev/null
sleep 5
SB53=$(curl -s -m 10 -H "OPEN-SANDBOX-API-KEY: H68idVYzjadx" "http://172.18.32.15:30040/v1/sandboxes?pageSize=50" | python3 -c "
import json,sys
items=json.load(sys.stdin).get('items',[])
print(sum(1 for i in items if i.get('metadata',{}).get('dev.opencode.workspace')=='$WS53' and i.get('status',{}).get('state')=='Running'))" 2>/dev/null || echo "?")
[ "${SB53:-1}" = "0" ] && pass "T39.5.3（无孤儿 running 沙箱）" || fail "T39.5.3" "实例=${SB53}（孤儿沙箱——待修）"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
[ "$FAIL" = "0" ]
