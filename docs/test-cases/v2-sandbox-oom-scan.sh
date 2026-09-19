#!/bin/bash
# 沙箱 OOM 采样与内存水位预警（sandbox-oom-scan.md T61.x）——v2 适配版。
#
# v1 -> v2 映射：
#   sandbox-provider 周期采样 -> core sandbox-oom.ts（global node，60s 周期）
#   runEphemeralCommand（临时 session 不 touch）-> Workspace.sample（观测命令，
#     不刷新 lastActivity/active——不会阻止 idle suspend）
#   PG sandbox 表 running -> workspace 表 binding 非空（join session_v2 取 session_id）
#   OPENCODE_SANDBOX_OOM_SCAN_ENABLED / _INTERVAL_SEC 同名保留
#   幂等 id: oom-<workspace>-<sandbox>-<total>（跨世代）/ oom-pressure-<ws>-<sb>-<bucket>
#   审计 API: GET /execs 合并 exec_log 行（本轮实现）
# 注意：v2 无 per-session sandbox.memory 配置（workspace 级），内存炸弹用默认配额。
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
OOM_LOGS() { psql "$PG_URL" -tAc "select id, status, left(command,70), left(coalesce(error,''),90) from exec_log where session_id='$1' and source='sandbox-oom' order by time_created"; }

if run T61.1; then
echo "===== T61.1 正常运行不误报 ====="
S=$(new_s t611)
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo ok"}' >/dev/null
sleep 150
N=$(OOM_LOGS "$S" | grep -c . || true)
R=$(api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo alive"}')
echo "  records=$N alive_exit=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))" 2>/dev/null)"
[ "${N:-0}" = "0" ] && echo "$R" | grep -q '"exitCode":0' && pass "T61.1（健康沙箱零误报）" "" || fail "T61.1" "records=$N"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T61.2; then
echo "===== T61.2 后台进程 OOM 归因（invisible OOM kill）====="
S=$(new_s t612)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo ready"}' >/dev/null
# 等一轮扫描建立 baseline（OOM=0），再放炸弹才能测出 delta
echo "  等待扫描建立 baseline（~70s）..."
sleep 70
R=$(api -X POST "$BASE/api/session/$S/exec" -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo launched"}')
echo "  bomb launched: $(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))" 2>/dev/null)（接口层无感知）"
sleep 150
LOGS=$(OOM_LOGS "$S")
echo "$LOGS" | head -4
OK=$(echo "$LOGS" | python3 -c "
import sys
rows=[l for l in sys.stdin if 'sandbox-oom-scan' in l]
ok = any('|failed|' in r for r in rows) and any('SandboxOOM' in r for r in rows)
print('ok' if ok else 'missing')" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T61.2（delta 归因落 exec_log，SandboxOOM 结构化 error）" "" || fail "T61.2" "$OK"
echo "$S" > /tmp/t61-sid.txt
fi

if run T61.3; then
echo "===== T61.3 幂等去重 + 再次 OOM 新记录 ====="
S=$(cat /tmp/t61-sid.txt 2>/dev/null || new_s t613)
B1=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom'" | tr -d ' ')
sleep 70   # 一个周期无新 OOM
B2=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom'" | tr -d ' ')
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo relaunched"}' >/dev/null
sleep 150
B3=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom'" | tr -d ' ')
DUP=$(psql "$PG_URL" -tAc "select count(*) from (select id from exec_log where session_id='$S' and source='sandbox-oom' group by id having count(*)>1) d" | tr -d ' ')
echo "  静置前=$B1 静置后=$B2 再炸后=$B3 重复id=$DUP"
[ "$B1" = "$B2" ] && [ "$B3" -gt "$B2" ] 2>/dev/null && [ "${DUP:-0}" = "0" ] && pass "T61.3（无新 OOM 不追加；再次 OOM 新记录；id 无重复）" "" || fail "T61.3" "b1=$B1 b2=$B2 b3=$B3 dup=$DUP"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T61.4; then
echo "===== T61.4 内存水位预警 ====="
S=$(new_s t614)
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo ready"}' >/dev/null
LIMIT=$(api -X POST "$BASE/api/session/$S/exec" -d '{"command":"cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || cat /sys/fs/cgroup/memory.max 2>/dev/null"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
echo "  limit=${LIMIT}（v2 workspace 级配额）"
python3 - "$LIMIT" <<'PYEOF' > /tmp/t61-alloc.py
import sys
limit=int(sys.argv[1]) if sys.argv[1].isdigit() else 0
alloc = int(limit*0.87) if limit and limit < 10**15 else 240*1024*1024
# single line, no quotes/backslashes (keeps the JSON body valid);
# strided slice assignment touches every page so the cgroup charges the allocation
print(f"import time; b=bytearray({alloc}); b[::4096]=bytes([1])*(({alloc}+4095)//4096); time.sleep(600)")
PYEOF
ALLOC=$(cat /tmp/t61-alloc.py)
api -X POST "$BASE/api/session/$S/exec" -d "{\"command\":\"setsid nohup python3 -c \\\"$ALLOC\\\" >/dev/null 2>&1 & echo ok\"}" >/dev/null
sleep 150
LOGS=$(OOM_LOGS "$S")
echo "$LOGS" | head -3
OK=$(echo "$LOGS" | python3 -c "
import sys
ok=any('memory-pressure' in l and 'completed' in l for l in sys.stdin)
print('ok' if ok else 'missing')" 2>/dev/null)
[ "$OK" = "ok" ] && pass "T61.4 (memory pressure >=85% -> MemoryPressure completed)" "" || fail "T61.4" "$OK limit=$LIMIT"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T61.5; then
echo "===== T61.5 采样不续命（不阻止 idle suspend）====="
# v2 idle = suspendForIdle（60min 阈值 + 每分钟扫描）——采样不得刷新 lastActivity。
# 短窗验证：采样两轮后 connection 的 lastActivity 不变（经 workspace.last_used_at 间接观测）。
S=$(new_s t615)
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo ready"}' >/dev/null
U1=$(psql "$PG_URL" -tAc "select last_used_at from workspace where id=(select workspace_id from session_v2 where id='$S')" | tr -d ' ')
sleep 130   # ≥2 个采样周期
U2=$(psql "$PG_URL" -tAc "select last_used_at from workspace where id=(select workspace_id from session_v2 where id='$S')" | tr -d ' ')
echo "  last_used_at 采样前=$U1 采样后=$U2"
[ "$U1" = "$U2" ] && pass "T61.5（采样两轮 last_used_at 不变——观测命令不续命）" "" || fail "T61.5" "u1=$U1 u2=$U2"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T61.7; then
echo "===== T61.7 重启后首轮立基准 ====="
S=$(cat /tmp/t61-sid.txt 2>/dev/null)
[ -z "$S" ] && S=$(new_s t617)
B=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom'" | tr -d ' ')
docker restart opencode-v2-test >/dev/null 2>&1; sleep 20
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo rewarm"}' >/dev/null 2>&1
sleep 140
A=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom'" | tr -d ' ')
echo "  before=$B after=$A"
[ "$A" = "$B" ] && pass "T61.7（重启后首轮只立基准，零误报）" "" || fail "T61.7" "b=$B a=$A"
fi

if run T61.8; then
echo "===== T61.8 沙箱重建后计数器静默重置 ====="
S=$(new_s t618)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo ready"}' >/dev/null
sleep 70   # 等一轮扫描建立 baseline（OOM=0）
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo pre"}' >/dev/null
sleep 130   # 产生首次 OOM 归因记录
B=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom' and command like '%sandbox-oom-scan%'" | tr -d ' ')
# kill-sandbox 异步返回（destroyed:true 立即响应，后台 suspend 继续）；
# 轮询 binding 出现新 snapshotId 确认 suspend 完成、原沙箱已杀，再触发恢复
WID=$(psql "$PG_URL" -tAc "select workspace_id from session_v2 where id='$S'" | tr -d ' ')
SNAP_BEFORE=$(psql "$PG_URL" -tAc "select coalesce(binding::jsonb->>'snapshotId','') from workspace where id='$WID'" | tr -d ' ')
curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S/kill-sandbox" >/dev/null
for _i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18; do
  sleep 10
  SNAP_NOW=$(psql "$PG_URL" -tAc "select coalesce(binding::jsonb->>'snapshotId','') from workspace where id='$WID'" | tr -d ' ')
  [ -n "$SNAP_NOW" ] && [ "$SNAP_NOW" != "$SNAP_BEFORE" ] && break
done
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo rebuilt"}' >/dev/null 2>&1
sleep 70   # 恢复沙箱（新 sandboxId=新基准键，计数器归零）首轮立基准
M=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom' and command like '%sandbox-oom-scan%'" | tr -d ' ')
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo go"}' >/dev/null
# 扫描周期偶发拖长（降级沙箱采样慢），轮询等待新记录而非固定睡眠
A=0
for _try in 1 2 3 4 5; do
  sleep 65
  A=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S' and source='sandbox-oom' and command like '%sandbox-oom-scan%'" | tr -d ' ')
  [ "${A:-0}" -gt "$B" ] && break
done
echo "  rebuild_before=$B idle_after=$M (expect=$B, negative delta silent) rebomb_after=$A (expect>$B)"
[ "$M" = "$B" ] && [ "$A" -gt "$B" ] 2>/dev/null && pass "T61.8 (rebuild silent + new baseline attribution resumes)" "" || fail "T61.8" "b=$B m=$M a=$A"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T61.10; then
echo "===== T61.10 多沙箱同轮归因 + 审计 API ====="
S1=$(new_s t61a); S2=$(new_s t61b)
for S in $S1 $S2; do
  api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true}' >/dev/null
  api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo ready"}' >/dev/null
done
# 等一轮扫描建立 baseline（OOM=0），否则炸弹先爆只会立基线、测不出 delta
sleep 70
for S in $S1 $S2; do
  api -X POST "$BASE/api/session/$S/exec" -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo go"}' >/dev/null
done
sleep 150
N1=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S1' and source='sandbox-oom' and command like '%sandbox-oom-scan%'" | tr -d ' ')
N2=$(psql "$PG_URL" -tAc "select count(*) from exec_log where session_id='$S2' and source='sandbox-oom' and command like '%sandbox-oom-scan%'" | tr -d ' ')
API_N=$(api "$BASE/api/session/$S1/execs" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(sum(1 for e in d.get('execs',[]) if 'oom' in (e.get('id') or '')[:24] or 'oom' in (e.get('command') or '')[:24]))" 2>/dev/null)
echo "  S1=$N1 S2=$N2 API=$API_N"
[ "${N1:-0}" -ge 1 ] && [ "${N2:-0}" -ge 1 ] && [ "${API_N:-0}" -ge 1 ] && pass "T61.10（双沙箱独立归因 + /execs 审计可见）" "" || fail "T61.10" "s1=$N1 s2=$N2 api=$API_N"
api -X DELETE "$BASE/api/session/$S1" >/dev/null 2>&1; api -X DELETE "$BASE/api/session/$S2" >/dev/null 2>&1
fi

[ -n "$ONLY" ] || skip "T61.6" "开关禁用（OPENCODE_SANDBOX_OOM_SCAN_ENABLED=0）需重启容器验证任务不启动；逻辑由代码 if(ENABLED) 守卫，容器重建env 变更属部署面"
[ -n "$ONLY" ] || skip "T61.9" "v2 采样只对有缓存连接的 workspace 执行（无连接即跳过）；v1 假行漂移场景由 exec 自愈（T30.12）覆盖"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
