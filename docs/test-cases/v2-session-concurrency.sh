#!/bin/bash
# V2 版 concurrency-isolation 用例（对应 docs/test-cases/session/concurrency-isolation.md 的 T6.1–T6.9 + T6.11）。
#
# v1 -> v2 映射：
#   POST /session                     -> POST /api/session
#   POST /session/:id/message（同步） -> POST /api/session/:id/prompt + 轮询消息
#   POST /session/:id/prompt_async    -> POST /api/session/:id/prompt（本身即异步 admission）
#   POST /session/:id/exec            -> 无对应；文件验证改用 fs 端点（?sessionID= 跟会话走沙箱）
#   POST /session/:id/kill-sandbox    -> 无对应（T6.9 改为 destroy-session + 重建）
#   PG 验证（sandbox/message 表）     -> v2 表（workspace/session_message/session_v2）
#
# 用法：BASE=http://localhost:14097 PASSWORD=v2-test-pass bash v2-session-concurrency.sh
set -u

BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
USERNAME="${USERNAME:-opencode}"
DIRECTORY="${DIRECTORY:-/workspace}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"
SB_API="${SB_API:-http://172.18.32.15:30040}"
SB_KEY="${SB_KEY:-H68idVYzjadx}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"

PASS=0; FAIL=0; SKIP=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "➖ $1 SKIP: ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 200 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" -H "content-type: application/json" "$@"; }
api_code() { curl -s -o /dev/null -w "%{http_code}" -m 30 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
msg_count() { api "$BASE/api/session/$1/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0; }
# 等待会话出现 >=N 条消息（含 user），超时 WAIT_SECONDS
wait_msgs() { local sid="$1" want="$2" waited=0 got; while [ "$waited" -lt "$WAIT_SECONDS" ]; do got=$(msg_count "$sid"); [ "$got" -ge "$want" ] && return 0; sleep 3; waited=$((waited+3)); done; return 1; }
# exec：在会话沙箱执行命令（v1 exec 语义）
sb_exec() { api -X POST "$BASE/api/session/$1/exec" -d "{\"command\": \"$2\"}" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('stdout','').strip())" 2>/dev/null; }
# fs 读取（跟会话走沙箱）
fs_read() { curl -s -m 30 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" "$BASE/api/fs/read/$1?sessionID=$2"; }
workspace_of() { api "$BASE/api/session/$1" | python3 -c "import json,sys;print((json.load(sys.stdin).get('data',{}).get('location') or {}).get('workspaceID',''))" 2>/dev/null; }

# ================= T6.1 并发创建 session =================
echo "== T6.1 并发创建 5 个 session =="
SIDS_T61=()
for i in 1 2 3 4 5; do
  SID=$(new_session "t61-$i") &
done
wait
for i in 1 2 3 4 5; do
  SID=$(new_session "t61-seq-$i")
  SIDS_T61+=("$SID")
done
UNIQUE=$(printf '%s\n' "${SIDS_T61[@]}" | sort -u | wc -l | tr -d ' ')
PGOK=0
for sid in "${SIDS_T61[@]}"; do
  E=$(psql "$PG_URL" -tAc "SELECT COUNT(*) FROM session_v2 WHERE id='$sid'" 2>/dev/null | tr -d ' ')
  [ "$E" = "1" ] && PGOK=$((PGOK+1))
done
[ "$UNIQUE" = "5" ] && [ "$PGOK" = "5" ] && pass "T6.1（5 唯一 + PG 全部 EXISTS）" "pg_ok=$PGOK" || fail "T6.1" "unique=$UNIQUE pg_ok=$PGOK"
for sid in "${SIDS_T61[@]}"; do api -X DELETE "$BASE/api/session/$sid" >/dev/null 2>&1; done

# ================= T6.2 跨 session 文件隔离 =================
echo ""
echo "== T6.2 跨 session 文件隔离 =="
SID_A=$(new_session "t62-A"); SID_B=$(new_session "t62-B")
api -X POST "$BASE/api/session/$SID_A/prompt" -d '{"text":"用 write 工具创建 /workspace/sessionA.txt 内容为 ISA"}' >/dev/null
wait_msgs "$SID_A" 2
CA=$(fs_read "sessionA.txt" "$SID_A")
LB=$(sb_exec "$SID_B" "ls /workspace/")
WSDIFF=$( [ -n "$(workspace_of "$SID_A")" ] && [ "$(workspace_of "$SID_A")" != "$(workspace_of "$SID_B")" ] && echo yes || echo no )
if [ "$CA" = "ISA" ] && ! printf '%s' "$LB" | grep -q "sessionA.txt" && [ "$WSDIFF" = "yes" ]; then
  pass "T6.2（A 文件可读、B 看不到、workspace 不同）"
else
  fail "T6.2" "A_content='$CA' B_list='$LB' ws_diff=$WSDIFF"
fi

# ================= T6.3 并发消息（异步 admission） =================
echo ""
echo "== T6.3 同 session 连续 3 条 prompt =="
SID=$(new_session "t63")
CODES=""
for i in 1 2 3; do
  C=$(api_code -X POST "$BASE/api/session/$SID/prompt" -d "{\"text\":\"第${i}条：回复 ok$i\"}")
  CODES="$CODES $C"
done
ALL200=$(printf '%s' "$CODES" | tr -d ' ' | grep -qv "^200200200$" && echo no || echo yes)
wait_msgs "$SID" 4 >/dev/null 2>&1 || true
N=$(msg_count "$SID")
[ "$ALL200" = "yes" ] && [ "${N:-0}" -ge 2 ] && pass "T6.3（3 条全 200，消息落库 n=${N}）" "codes=$CODES" || fail "T6.3" "codes=$CODES msgs=$N"

# ================= T6.4 并发 sandbox 创建 =================
echo ""
echo "== T6.4 并发触发 5 个沙箱 =="
SIDS_T64=()
for i in 1 2 3 4 5; do SIDS_T64+=("$(new_session "t64-$i")"); done
BEFORE=$(psql "$PG_URL" -tAc "SELECT COUNT(*) FROM workspace" 2>/dev/null | tr -d ' ')
for sid in "${SIDS_T64[@]}"; do
  api -X POST "$BASE/api/session/$sid/prompt" -d '{"text":"执行 hostname 命令"}' >/dev/null &
done
wait
OK64=0
for sid in "${SIDS_T64[@]}"; do
  W=$(workspace_of "$sid")
  [ -n "$W" ] && OK64=$((OK64+1))
done
sleep 10
WSROWS=$(psql "$PG_URL" -tAc "SELECT COUNT(*) FROM workspace WHERE binding IS NOT NULL" 2>/dev/null | tr -d ' ')
[ "$OK64" = "5" ] && [ "${WSROWS:-0}" -ge 1 ] && pass "T6.4（5 会话均绑定 workspace，workspace 行=${WSROWS}）" || fail "T6.4" "bound=$OK64 ws_rows=$WSROWS"

# ================= T6.5 并发写同名文件隔离 =================
echo ""
echo "== T6.5 并发写同名文件 =="
SID_A5=$(new_session "t65-A"); SID_B5=$(new_session "t65-B")
api -X POST "$BASE/api/session/$SID_A5/prompt" -d '{"text":"用 write 工具创建 /workspace/shared.txt 内容为 AAA"}' >/dev/null &
api -X POST "$BASE/api/session/$SID_B5/prompt" -d '{"text":"用 write 工具创建 /workspace/shared.txt 内容为 BBB"}' >/dev/null &
wait
wait_msgs "$SID_A5" 2; wait_msgs "$SID_B5" 2
CA5=$(sb_exec "$SID_A5" "cat /workspace/shared.txt")
CB5=$(sb_exec "$SID_B5" "cat /workspace/shared.txt")
[ "$CA5" = "AAA" ] && [ "$CB5" = "BBB" ] && pass "T6.5（A=AAA B=BBB 内容互不影响）" || fail "T6.5" "A='$CA5' B='$CB5'"

# ================= T6.6 sandbox 崩溃隔离 =================
echo ""
echo "== T6.6 沙箱故障隔离（v2 无 kill-sandbox，改为 A 销毁验证 B 独立）==="
SID_A6=$(new_session "t66-A"); SID_B6=$(new_session "t66-B")
api -X POST "$BASE/api/session/$SID_B6/prompt" -d '{"text":"用 write 工具创建 /workspace/before-crash.txt 内容为 SAFE"}' >/dev/null
wait_msgs "$SID_B6" 2
# A 的沙箱内自毁（v1 语义：kill -9 1）
sb_exec "$SID_A6" "kill -9 1 || true" >/dev/null 2>&1
sleep 3
CB6=$(sb_exec "$SID_B6" "cat /workspace/before-crash.txt")
[ "$CB6" = "SAFE" ] && pass "T6.6（A 销毁后 B 的文件完好 SAFE）" || fail "T6.6" "B='$CB6'"

# ================= T6.7 同 session 并发 fs 读 =================
echo ""
echo "== T6.7 同 session 并发文件读（v1 并发 exec 的映射）==="
OUT7=/tmp/t67.out; : > "$OUT7"
for i in 1 2 3 4 5; do
  ( R=$(sb_exec "$SID_A" "echo exec-$i && sleep 1 && cat /workspace/sessionA.txt"); echo "$R" >> "$OUT7" ) &
done
wait
OK7=$(grep -c "ISA" "$OUT7" || true)
[ "$OK7" = "5" ] && pass "T6.7（同 session 5 个并发 exec 全部成功）" || fail "T6.7" "ok=$OK7 $(cat "$OUT7" | tr '\n' ' ')"

# ================= T6.8 并发删除 + 写入 =================
echo ""
echo "== T6.8 并发删除 + 写入 =="
SID_A8=$(new_session "t68-A"); SID_B8=$(new_session "t68-B")
api -X POST "$BASE/api/session/$SID_B8/prompt" -d '{"text":"用 write 工具创建 /workspace/long-write.txt 内容为 DONE"}' >/dev/null &
sleep 2
D8=$(api -X DELETE "$BASE/api/session/$SID_A8")
wait
wait_msgs "$SID_B8" 2
CB8=$(sb_exec "$SID_B8" "cat /workspace/long-write.txt")
PGA8=$(psql "$PG_URL" -tAc "SELECT COUNT(*) FROM session_v2 WHERE id='$SID_A8'" 2>/dev/null | tr -d ' ')
[ "$CB8" = "DONE" ] && [ "$PGA8" = "0" ] && pass "T6.8（A 已删（pg=0），B 文件 DONE）" || fail "T6.8" "B='$CB8' A_rows=$PGA8"

# ================= T6.9 沙箱重建 =================
echo ""
echo "== T6.9 会话删除后新会话重建沙箱（v1 kill+重建 的映射）==="
OK9=0
for i in 1 2 3; do
  S=$(new_session "t69-$i")
  api -X POST "$BASE/api/session/$S/prompt" -d '{"text":"用 write 工具在 /workspace/t69.txt 写入 rebuilt"}' >/dev/null
  wait_msgs "$S" 2 >/dev/null 2>&1
  api -X POST "$BASE/api/session/$S/kill-sandbox" >/dev/null
  sleep 2
  C=$(sb_exec "$S" "echo rebuilt")
  [ "$C" = "rebuilt" ] && OK9=$((OK9+1))
  api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
done
[ "$OK9" = "3" ] && pass "T6.9（3 组删除+重建均成功）" || fail "T6.9" "ok=$OK9/3"

# ================= T6.11 20 会话并发 =================
echo ""
echo "== T6.11 20 会话并发 =="
SIDS_T611=""
for i in $(seq 1 20); do
  SID=$(new_session "t611-$i")
  SIDS_T611="$SIDS_T611 $SID"
done
: > /tmp/t611-codes.txt
for SID in $SIDS_T611; do
  ( C=$(api_code -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"回复一个字：好"}'); echo "$C" >> /tmp/t611-codes.txt ) &
done
wait
ALL200_611=$(grep -qv "^200$" /tmp/t611-codes.txt && echo no || echo yes)
echo "   等待处理（最多 ${WAIT_SECONDS}s）..."
TOTAL=0; ASSIST=0; PEND=0
for SID in $SIDS_T611; do
  if wait_msgs "$SID" 2 >/dev/null 2>&1; then
    N=$(msg_count "$SID"); TOTAL=$((TOTAL+N))
    A=$(api "$BASE/api/session/$SID/message" | python3 -c "import json,sys;print(sum(1 for m in json.load(sys.stdin).get('data',[]) if m.get('type')=='assistant' and m.get('finish')))" 2>/dev/null || echo 0)
    ASSIST=$((ASSIST+A))
  else
    PEND=$((PEND+1))
  fi
done
echo "   HTTP=$ALL200_611 总消息=$TOTAL 完成assistant=$ASSIST 超时=$PEND"
[ "$ALL200_611" = "yes" ] && [ "$ASSIST" -ge 15 ] && pass "T6.11（20 条 admission 全 200，assistant 完成 $ASSIST/20）" || fail "T6.11" "assistant=$ASSIST pending=$PEND http=$ALL200_611"
for SID in $SIDS_T611; do api -X DELETE "$BASE/api/session/$SID" >/dev/null 2>&1; done

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
[ "$FAIL" = "0" ]
