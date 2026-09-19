#!/bin/bash
# Watchdog monitoring coverage (watchdog-coverage.md T-WDT.1~3) — v2 adapted version.
#
# v1 -> v2 mapping:
#   part table (row-level part) -> session_message.data.content array (jsonb expansion)
#   markTimedOut direct part write -> publish session.tool.failed event (projection settles it)
#   MONITORED_TOOLS +lsp/todowrite -> v2 tool surface: read/write/edit/patch/glob/grep
#     (v2 has no lsp/todowrite tools; shell not monitored — same rationale as v1 bash)
#   OPENCODE_WATCHDOG_TIMEOUT_SEC / _SCAN_INTERVAL_SEC env vars kept (defaults 120s/15s)
#   container opencode-saas-test -> opencode-v2-test
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"
ONLY="${ONLY:-}"
run() { [ -z "$ONLY" ] && return 0; printf " %s " "$ONLY" | grep -q " $1 " ; }

PASS=0; FAIL=0; SKIP=0
pass() { echo "PASS $1 ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "FAIL $1: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "SKIP $1 ${2:-}"; SKIP=$((SKIP+1)); }

pgval() { psql "$PG_URL" -tAc "$1" | tr -d ' '; }

if [ -z "${INSTANCE_START_MS:-}" ]; then
  STARTED_AT=$(docker inspect opencode-v2-test --format '{{.State.StartedAt}}' 2>/dev/null | cut -c1-19)
  [ -n "$STARTED_AT" ] && INSTANCE_START_MS=$(python3 -c "
from datetime import datetime, timezone
print(int(datetime.fromisoformat('$STARTED_AT').replace(tzinfo=timezone.utc).timestamp()*1000))" 2>/dev/null)
fi

if run T-WDT.1; then
echo "===== T-WDT.1 no new stale running parts within instance lifetime ====="
if [ -n "${INSTANCE_START_MS:-}" ]; then
  NEW_STALE=$(pgval "
    select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
    where c->>'type'='tool' and c->'state'->>'status' in ('running','streaming')
      and m.time_created > $INSTANCE_START_MS
      and m.time_created < (extract(epoch FROM now())-1800)*1000")
  LEGACY=$(pgval "
    select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
    where c->>'type'='tool' and c->'state'->>'status' in ('running','streaming')
      and m.time_created <= $INSTANCE_START_MS")
  echo "  new stale (>30min running) since boot: $NEW_STALE (legacy $LEGACY, display only)"
  [ "$NEW_STALE" = "0" ] && pass "T-WDT.1" "" || fail "T-WDT.1" "new stale = $NEW_STALE"
else
  fail "T-WDT.1" "INSTANCE_START_MS missing (non-docker)"
fi
fi

if run T-WDT.2; then
echo "===== T-WDT.2 watchdog marker gap convergence (120s timeout + 15s scan) ====="
LIVEGAP=$(pgval "
  select coalesce(max((c->'time'->>'completed')::bigint-(c->'time'->>'created')::bigint),0)
  from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where c->'state'->'error'->>'message' like '%(watchdog)%'
    and m.time_created > ${INSTANCE_START_MS:-0}
    and m.time_created > (extract(epoch FROM now())-86400)*1000")
LEGACY=$(pgval "
  select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where c->'state'->'error'->>'message' like '%(watchdog)%'
    and m.time_created <= ${INSTANCE_START_MS:-0}
    and m.time_created > (extract(epoch FROM now())-86400)*1000")
echo "  live maxGap=${LIVEGAP}ms; cross-instance legacy=$LEGACY (display only)"
[ "${LIVEGAP:-0}" -le 150000 ] 2>/dev/null && pass "T-WDT.2" "maxGap=${LIVEGAP}ms" || fail "T-WDT.2" "live gap=${LIVEGAP}ms > 150s"
fi

if run T-WDT.3; then
echo "===== T-WDT.3 monitored coverage + no false kills ====="
SHELL_WDT=$(pgval "
  select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where c->>'name'='shell' and c->'state'->'error'->>'message' like '%(watchdog)%'
    and m.time_created > (extract(epoch FROM now())-7*86400)*1000")
SHELL_ALL=$(pgval "
  select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where c->>'name'='shell'
    and m.time_created > (extract(epoch FROM now())-7*86400)*1000")
MARKED=$(pgval "
  select count(distinct c->>'name') from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where c->'state'->'error'->>'message' like '%(watchdog)%'")
echo "  shell watchdog=${SHELL_WDT}/${SHELL_ALL}; distinct tools covered=$MARKED"
OK3=1
[ "$SHELL_ALL" = "0" ] || [ "$(echo "$SHELL_WDT $SHELL_ALL" | awk '{print ($1/$2<0.005)?1:0}')" = "1" ] || OK3=0
[ "${MARKED:-0}" -ge 1 ] || OK3=0
[ "$OK3" = "1" ] && pass "T-WDT.3" "shell=${SHELL_WDT}/${SHELL_ALL} covered=$MARKED" || fail "T-WDT.3" "shell=${SHELL_WDT}/${SHELL_ALL} marked=$MARKED"
fi

[ -n "$ONLY" ] || skip "T-WDT.3-lsp" "v2 has no lsp/todowrite tools (architectural); monitored set is the v2 tool surface read/write/edit/patch/glob/grep"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
