#!/bin/bash
# 沙箱生命周期管理（sandbox-lifecycle.md T12.x / T30.x）——v2 适配版。
#
# v1 -> v2 映射：
#   PG sandbox 表（state/keep_alive/time_updated）
#     -> workspace 表（binding.sandboxId = 沙箱引用；keepAlive 为服务内 Set）
#   onIdle 即时销毁 -> v2 idle = suspendForIdle（快照 Ready 后杀，连接缓存清理；
#     阈值默认 60min + 每分钟扫描）；keepAlive=true 跳过 suspend
#   kill-sandbox（pvc 直接销毁 / snapshot 先快照后杀）
#     -> v2 统一 suspend 语义：快照 Ready→杀沙箱→保留 binding（本批实现对齐 v1
#        snapshot 会话）；connect 对死沙箱三层恢复（binding 快照→最新 Ready 快照→冷启）
#   idle-reap / zombie 扫描 -> v2 无（suspend 模型取代；janitor 只回收过期快照）
#   bash -> shell；ls -> read/glob/bash 任一
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $1 ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 300 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_s() {
  local id=""
  for _ in 1 2 3; do
    id=$(api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
    [ -n "$id" ] && { echo "$id"; return 0; }
    sleep 2
  done
  echo ""
}
exec_cmd() { curl -s -m "${3:-120}" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$1/exec" -d "{\"command\":$2}"; }
wid() { psql "$PG_URL" -tAc "select coalesce(workspace_id::text,'') from session_v2 where id='$1'" | tr -d ' '; }
binding() { psql "$PG_URL" -tAc "select coalesce(binding::jsonb->>'sandboxId','') from workspace where id='$(wid "$1")'" | tr -d ' '; }

if run T12.1; then
echo "===== T12.1 懒创建：不用沙箱工具不 provision ====="
S=$(new_s t121)
B=$(binding "$S")
echo "  binding.sandboxId = '${B:-<null>}'"
[ -z "$B" ] && pass "T12.1（纯创建会话不 provision）" "" || fail "T12.1" "binding=$B"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.2; then
echo "===== T12.2 首次使用 provision ====="
S=$(new_s t122)
R=$(exec_cmd "$S" '"echo hello"')
B=$(binding "$S")
echo "  exitCode=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))" 2>/dev/null) sandboxId=${B:0:12}..."
[ -n "$B" ] && pass "T12.2（exec 触发 provision，binding 含 sandboxId）" "${B:0:16}" || fail "T12.2" "binding 空"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.3; then
echo "===== T12.3 复用同一沙箱 ====="
S=$(new_s t123)
exec_cmd "$S" '"echo first"' >/dev/null
B1=$(binding "$S")
T0=$(python3 -c "import time;print(time.time())")
R=$(exec_cmd "$S" '"echo again"')
T1=$(python3 -c "import time;print(time.time())")
B2=$(binding "$S")
DUR=$(python3 -c "print(f'{$T1-$T0:.1f}')")
echo "  SB1=${B1:0:12} SB2=${B2:0:12} 二次耗时=${DUR}s"
[ "$B1" = "$B2" ] && [ -n "$B1" ] && pass "T12.3（sandboxId 不变，复用 ${DUR}s）" "" || fail "T12.3" "SB1=$B1 SB2=$B2"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.4; then
echo "===== T12.4 keepAlive 存活 ====="
S=$(new_s t124)
curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec/async" -d '{"command":"sleep 3600","timeoutSeconds":3600}' >/dev/null
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true}' >/dev/null
sleep 40
R=$(exec_cmd "$S" '"echo alive"' 90)
KA=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/keep-alive" | python3 -c "import json,sys;print(json.load(sys.stdin).get('keepAlive'))" 2>/dev/null)
echo "  alive_exit=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))" 2>/dev/null) keepAlive=$KA"
[ "$KA" = "True" ] && echo "$R" | grep -q '"exitCode":0' && pass "T12.4（40s 后沙箱仍可用 + keepAlive=true）" "" || fail "T12.4" "ka=$KA r=$(echo "$R" | head -c 80)"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.7; then
echo "===== T12.7 dispose 不销毁 workspace ====="
S=$(new_s t127)
exec_cmd "$S" '"echo init"' >/dev/null
B1=$(binding "$S")
C=$(curl -s -o /dev/null -w "%{http_code}" -m 90 -u "opencode:$PASSWORD" -X POST "$BASE/api/global/dispose")
sleep 3
B2=$(binding "$S")
echo "  dispose=$C binding_before=${B1:0:12} binding_after=${B2:0:12}"
[ "$C" = "200" ] && [ "$B1" = "$B2" ] && [ -n "$B2" ] && pass "T12.7（dispose 只释放 location 服务，workspace/binding 保留）" "" || fail "T12.7" "http=$C b1=$B1 b2=$B2"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.8; then
echo "===== T12.8 dispose 后 exec 自动重建 ====="
S=$(new_s t128)
exec_cmd "$S" '"echo init"' >/dev/null
curl -s -m 90 -u "opencode:$PASSWORD" -X POST "$BASE/api/global/dispose" >/dev/null
R=$(exec_cmd "$S" '"echo after-dispose"' 150)
B=$(binding "$S")
echo "  stdout=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null) binding=${B:0:12}"
echo "$R" | grep -q "after-dispose" && [ -n "$B" ] && pass "T12.8（dispose 后 exec 恢复）" "" || fail "T12.8" "$(echo "$R" | head -c 80)"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.9; then
echo "===== T12.9 数据在 kill-sandbox 后持久（快照恢复）====="
S=$(new_s t129)
exec_cmd "$S" '"echo init"' >/dev/null
TS=$(date +%s)
exec_cmd "$S" "\"echo $TS > /workspace/restart-test.txt\"" >/dev/null
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S/kill-sandbox" | head -c 80; echo
# suspend 后台执行：等快照 Ready（轮询 workspace 行的 snapshotAt 出现）
for i in $(seq 1 60); do
  SNAP=$(psql "$PG_URL" -tAc "select coalesce(binding::jsonb->>'snapshotId','') from workspace where id='$(wid "$S")'" | tr -d ' ')
  [ -n "$SNAP" ] && break
  sleep 2
done
echo "  snapshotId=${SNAP:0:14} (${i}x2s)"
sleep 3
R=$(exec_cmd "$S" '"cat /workspace/restart-test.txt"' 180)
B2=$(binding "$S")
OUT=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
echo "  rebuild read-back: '$OUT' (want $TS) new sandbox=${B2:0:12}"
[ "$OUT" = "$TS" ] && pass "T12.9 (kill-sandbox snapshot preserved, data restored after rebuild)" "" || fail "T12.9" "out=$OUT snap=$SNAP"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.10; then
echo "===== T12.10 多会话文件隔离 ====="
A=$(new_s t1210a); B_=$(new_s t1210b)
exec_cmd "$A" '"echo A > /workspace/only-in-A.txt"' >/dev/null
R=$(exec_cmd "$B_" '"ls /workspace/only-in-A.txt 2>&1"')
echo "  B sees: $(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)"
echo "$R" | grep -q "No such file" && pass "T12.10（B 看不到 A 的文件）" "" || fail "T12.10" "$(echo "$R" | head -c 100)"
api -X DELETE "$BASE/api/session/$A" >/dev/null 2>&1; api -X DELETE "$BASE/api/session/$B_" >/dev/null 2>&1
fi

if run T12.11; then
echo "===== T12.11 沙箱进程隔离 ====="
A=$(new_s t1211a); B_=$(new_s t1211b)
exec_cmd "$A" '"echo warm"' >/dev/null
curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$A/exec/async" -d '{"command":"sleep 3600","timeoutSeconds":3600}' >/dev/null
sleep 3
RB=$(exec_cmd "$B_" '"ps aux 2>/dev/null | grep \"sleep 3600\" | grep -v grep | wc -l"')
RA=$(exec_cmd "$A" '"ps aux 2>/dev/null | grep \"sleep 3600\" | grep -v grep | wc -l"')
NB=$(echo "$RB" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
NA=$(echo "$RA" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
echo "  A sleep 进程=$NA, B sleep 进程=$NB"
[ "$NB" = "0" ] && [ "$NA" -ge 1 ] 2>/dev/null && pass "T12.11（A=1 B=0，容器级隔离）" "" || fail "T12.11" "A=$NA B=$NB"
api -X DELETE "$BASE/api/session/$A" >/dev/null 2>&1; api -X DELETE "$BASE/api/session/$B_" >/dev/null 2>&1
fi

if run T12.13; then
echo "===== T12.13 GET /sandbox 查询 ====="
S=$(new_s t1213)
W0=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/sandbox" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workspaceID','')[:6])" 2>/dev/null)
exec_cmd "$S" '"echo hi"' >/dev/null
W1=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/sandbox" | python3 -c "import json,sys;print(json.load(sys.stdin).get('workspaceID','')[:6])" 2>/dev/null)
DB=$(wid "$S" | head -c 6)
echo "  初始=$W0 exec后=$W1 DB=$DB"
[ "$W0" = "$DB" ] && [ "$W1" = "$DB" ] && pass "T12.13（sandbox 端点返回 workspaceID，与 DB 一致）" "" || fail "T12.13" "$W0/$W1/$DB"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.14; then
echo "===== T12.14 keepAlive 在 kill-sandbox 后保留 ====="
S=$(new_s t1214)
exec_cmd "$S" '"echo init"' >/dev/null
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true}' >/dev/null
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S/kill-sandbox" >/dev/null
sleep 2
KA=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/keep-alive" | python3 -c "import json,sys;print(json.load(sys.stdin).get('keepAlive'))" 2>/dev/null)
R=$(exec_cmd "$S" '"echo rebuilt"' 150)
echo "  destroy 后 keepAlive=$KA, 重建 exec=$([ "$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))" 2>/dev/null)" = "0" ] && echo ok || echo fail)"
[ "$KA" = "True" ] && echo "$R" | grep -q "rebuilt" && pass "T12.14（kill 不清 keepAlive，重建后可用）" "" || fail "T12.14" "ka=$KA"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T12.15; then
echo "===== T12.15 session 删除后 workspace 状态 ====="
S=$(new_s t1215)
exec_cmd "$S" '"echo init"' >/dev/null
W=$(wid "$S"); B1=$(binding "$S")
curl -s -m 30 -o /dev/null -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X DELETE "$BASE/api/session/$S"
sleep 3
GONE=$(psql "$PG_URL" -tAc "select count(*) from session_v2 where id='$S'" | tr -d ' ')
WROW=$(psql "$PG_URL" -tAc "select count(*) from workspace where id='$W'" | tr -d ' ')
# v2 级联：session 删除同步销毁沙箱容器（opensandbox 404 = 已杀）
SBGONE=$(curl -s -m 10 "http://localhost:8080/v1/sandboxes/$B1" | grep -c SANDBOX_NOT_FOUND)
echo "  session 删除=$GONE(期望0) workspace 行=$WROW(期望0,级联删) sandbox 容器已杀=$SBGONE"
[ "$GONE" = "0" ] && [ "$WROW" = "0" ] && [ "$SBGONE" = "1" ] && pass "T12.15（session 删除级联：行+容器同步销毁，无孤儿）" "" || fail "T12.15" "gone=$GONE row=$WROW sbGone=$SBGONE"
fi

if run T12.17; then
echo "===== T12.17 keep-alive boot 参数 ====="
A=$(new_s t1217a)
R=$(curl -s -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$A/keep-alive" -d '{"enabled":true,"boot":true}')
BA=$(binding "$A")
B_=$(new_s t1217b)
R2=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$B_/keep-alive" -d '{"enabled":true,"boot":false}')
BB=$(binding "$B_")
echo "  boot=true → sandboxId=${BA:0:12}；boot=false → '${BB:-<null>}'"
[ -n "$BA" ] && [ -z "$BB" ] && pass "T12.17（boot=true 立即 provision；boot=false 仅设标记不 provision）" "" || fail "T12.17" "a=$BA b=$BB"
R3=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$B_/keep-alive" -d '{"enabled":false}')
KA=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$B_/keep-alive" | python3 -c "import json,sys;print(json.load(sys.stdin).get('keepAlive'))" 2>/dev/null)
echo "  release 后 keepAlive=$KA（期望 False）"
api -X DELETE "$BASE/api/session/$A" >/dev/null 2>&1; api -X DELETE "$BASE/api/session/$B_" >/dev/null 2>&1
fi

if run T30.12; then
echo "===== T30.12（适配）外部删除沙箱后自愈重建 ====="
S=$(new_s t3012)
exec_cmd "$S" '"echo warmup"' >/dev/null
SB=$(binding "$S")
# 绕过 opencode 直接调 opensandbox 删沙箱（模拟 TTL/外部回收）
curl -s -m 30 -X DELETE "http://localhost:8080/v1/sandboxes/$SB" -o /dev/null -w "  external delete: %{http_code}\n"
sleep 2
R=$(exec_cmd "$S" '"echo self-heal-ok"' 180)
B2=$(binding "$S")
OUT=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
echo "  self-heal: '$OUT' new sandbox=${B2:0:12}（旧 ${SB:0:12}）"
[ "$OUT" = "self-heal-ok" ] && [ -n "$B2" ] && [ "$B2" != "$SB" ] && pass "T30.12（沙箱被外部删除后 exec 自愈重建）" "" || fail "T30.12" "out=$OUT"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ─── 架构性 SKIP（汇总）───
[ -n "$ONLY" ] || skip "T12.5/6" "v2 idle = suspendForIdle 快照挂起（非销毁），阈值 60min；onIdle 即时销毁语义不存在，keepAlive 跳过 suspend 由 T12.4 语义覆盖"
[ -n "$ONLY" ] || skip "T12.12/16" "v2 无 OPENCODE_SANDBOX_IDLE_KILL_SEC/zombie 扫描（suspend 模型）；keepAlive 为服务内 Set，无 upsert 覆盖面"
[ -n "$ONLY" ] || skip "T12.18-20" "v2 无 POST /sandbox/:id/kill 端点；kill-sandbox 已统一走快照先行（suspend），destroy-by-id/snapshot 分支语义合并"
[ -n "$ONLY" ] || skip "T30.1-11" "v2 无 idle-reap/zombie 扫描器（suspend 模型取代）：time_updated/heartbeat/CAS/zombie 断言面不存在；detached 命令经 exec-async（无心跳语义面）"
[ -n "$ONLY" ] || skip "T30.13" "v2 shell 工具无 background:true 参数（后台化走 exec/async），无自动保活路径"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
