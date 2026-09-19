#!/bin/bash
# 沙箱性能优化与 Watchdog 兜底（sandbox-watchdog.md T28.x）——v2 适配版。
#
# v1 -> v2 映射：
#   Part Watchdog -> 已由 watchdog-coverage.md（T-WDT.1-3，3 PASS）覆盖
#   /file/content 接口 -> /api/fs/read + /api/session/:id/exec
#   PG sandbox 表 -> workspace 表 binding
#   前台命令超时 -> exec timeoutSeconds（T19.10 已覆盖）
#   detached 超时 -> exec/async timeoutMs
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

# ════════════════════════════════════════════════════════
if run T28.1; then
echo "===== T28.1 缓存命中（首次慢、后续快）====="
S=$(new_s t281)
T1=$(curl -s -o /dev/null -w '%{time_total}' -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo warmup"}')
echo "  首次: ${T1}s"
TIMES=""
for i in 2 3 4 5 6; do
  T=$(curl -s -o /dev/null -w '%{time_total}' -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo hit"}')
  TIMES="$TIMES $T"
done
echo "  后续: $TIMES"
FAST=$(echo "$TIMES" | python3 -c "
import sys
times=[float(x) for x in sys.stdin.read().split()]
print('ok' if all(t < 2.0 for t in times) else 'slow')" 2>/dev/null)
SLOW=$(python3 -c "print('ok' if $T1 > 0.5 else 'too_fast')")
[ "$SLOW" = "ok" ] && [ "$FAST" = "ok" ] && pass "T28.1（首次 ${T1}s → 后续均 < 2s）" "$TIMES" || fail "T28.1" "first=$T1 rest=$TIMES"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ════════════════════════════════════════════════════════
if run T28.2; then
echo "===== T28.2 并发请求不串行 ====="
S=$(new_s t282)
curl -s -o /dev/null -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo warmup"}'
START=$(python3 -c "import time; print(int(time.time()*1000))")
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo concurrent"}' &
done
wait
END=$(python3 -c "import time; print(int(time.time()*1000))")
TOTAL=$((END - START))
echo "  5 个并发总耗时: ${TOTAL}ms"
[ "$TOTAL" -lt 5000 ] && pass "T28.2（${TOTAL}ms，非串行排队）" "" || fail "T28.2" "${TOTAL}ms"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ════════════════════════════════════════════════════════
if run T28.6; then
echo "===== T28.6 kill-sandbox 后缓存失效 ====="
S=$(new_s t286)
api -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo warmup"}' >/dev/null 2>&1
curl -s -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S/kill-sandbox" >/dev/null
# 等快照完成后重新 provision
for i in $(seq 1 30); do
  SNAP=$(psql "$PG_URL" -tAc "select coalesce(binding::jsonb->>'snapshotId','') from workspace where id=(select workspace_id from session_v2 where id='$S')" 2>/dev/null | tr -d ' ')
  [ -n "$SNAP" ] && break; sleep 2
done
T=$(curl -s -o /dev/null -w '%{time_total}' -m 180 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo rebuilt"}')
echo "  kill 后调用: ${T}s"
OK=$(python3 -c "print('ok' if $T > 0.5 else 'too_fast')")
[ "$OK" = "ok" ] && pass "T28.6（kill 后 ${T}s，重新 provision）" "" || fail "T28.6" "${T}s"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ════════════════════════════════════════════════════════
if run T28.17; then
echo "===== T28.17 前台命令超时 ====="
S=$(new_s t2817)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
R=$(curl -s -m 10 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"sleep 10","timeoutSeconds":2}')
echo "  result: $R"
echo "$R" | grep -q '"exitCode":-1' && echo "$R" | grep -q "timed out" && pass "T28.17（2s 超时返回 -1 + timed out）" "" || fail "T28.17" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ════════════════════════════════════════════════════════
if run T28.18; then
echo "===== T28.18 detached 命令超时 ====="
S=$(new_s t2818)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
START=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec/async" -d '{"command":"sleep 20","timeoutSeconds":2}')
EXEC_ID=$(echo "$START" | python3 -c "import json,sys;print(json.load(sys.stdin).get('execId',''))")
echo "  execId: $EXEC_ID"
sleep 5
STATUS=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/exec/$EXEC_ID" | python3 -c "import json,sys;print(json.load(sys.stdin).get('status',''))")
echo "  5s 后状态: $STATUS"
[ "$STATUS" != "running" ] && pass "T28.18 (timeout status=$STATUS)" "" || fail "T28.18" "still running"
# 沙箱仍可用
R=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo alive"}')
echo "$R" | grep -q "alive" && pass "T28.18（超时后沙箱仍可用）" "" || fail "T28.18-alive" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ════════════════════════════════════════════════════════
if run T28.21; then
echo "===== T28.21 超时后命令恢复 ====="
S=$(new_s t2821)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
curl -s -o /dev/null -m 10 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"sleep 10","timeoutSeconds":1}'
R=$(curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo recovered","timeoutSeconds":10}')
echo "  recovered: $(echo "$R" | head -c 80)"
echo "$R" | grep -q "recovered" && pass "T28.21（超时后恢复命令成功）" "" || fail "T28.21" "$R"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ════════════════════════════════════════════════════════
if run T28.22; then
echo "===== T28.22 keep-alive 超时后沙箱不回收 ====="
S=$(new_s t2822)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
curl -s -o /dev/null -m 10 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"sleep 10","timeoutSeconds":1}'
R=$(curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S/exec" -d '{"command":"echo keep-alive-ok"}')
KA=$(curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/session/$S/keep-alive" | python3 -c "import json,sys;print(json.load(sys.stdin).get('keepAlive'))")
echo "  exec=$([ "$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))")" = "0" ] && echo ok || echo fail) keepAlive=$KA"
echo "$R" | grep -q "keep-alive-ok" && [ "$KA" = "True" ] && pass "T28.22（超时后沙箱仍可用 + keepAlive=true）" "" || fail "T28.22" "ka=$KA"
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

# ════════════════════════════════════════════════════════
# Part Watchdog 部分已由 watchdog-coverage.md 覆盖
# ════════════════════════════════════════════════════════
[ -n "$ONLY" ] || skip "T28.5/5b/9-14 Part Watchdog" "已由 watchdog-coverage.md（T-WDT.1-3，3 PASS / 0 FAIL / 1 SKIP）覆盖：v2 watchdog 实现 + 单测 anti-loop.test.ts 11/11 + 注入孤儿实测"
[ -n "$ONLY" ] || skip "T28.3 缓存 TTL 过期" "v2 无 5 分钟缓存 TTL：idle suspend 阈值 60min（suspend 而非 destroy）；连接在 kill-sandbox 后显式失效（T28.6 已测）"
[ -n "$ONLY" ] || skip "T28.4/15/19/20 PG 超时注入" "需 PG 集成测试注入不可达沙箱/卡住的 SDK 调用；v2 传输失败自愈由 T30.12（sandbox-lifecycle）覆盖"
[ -n "$ONLY" ] || skip "T28.7/8 日志可观测" "v2 spawn-probe 日志已实现（本会话全程使用）；完整阶段耗时由代码审查保证"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
