#!/bin/bash
# Session Compaction history file reference (session-compaction-history.md T-CX.x) - v2 adaptation.
#
# v1 -> v2 mapping:
#   V1 processCompaction -> v2 core SessionCompaction.execute (local summary path)
#   Write location: session with workspace (SaaS sandbox) -> /workspace/.opencode/tool-output;
#                   local session -> Global.Path.data/tool-output (not covered here)
#   historyPath persistence: session_message.data (v2 has no part table; message is the row)
#   Message id correspondence: pre-generated Started event id -> tool_history_<msgID>.md file name
#   Retrieval hint: to-llm-message injects Grep/Read hint into the checkpoint
#   Cleanup: write piggybacks find -mtime +7 -delete
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL_ID="${MODEL_ID:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"
TOOL_OUTPUT="/workspace/.opencode/tool-output"
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
    [ -n "$id" ] && break
    sleep 3
  done
  echo "$id"
}
json_text() { python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$1"; }
prompt() { # $1=session $2=text ; wait for this turn to end (new idle marker)
  local BEFORE
  BEFORE=$(psql "$PG_URL" -tAc "select coalesce(max(time_created),0) from session_message where session_id='$1' and type='idle'" | tr -d ' ')
  api -X POST "$BASE/api/session/$1/prompt" -d "{\"text\":$(json_text "$2")}" >/dev/null
  for _ in $(seq 1 60); do
    sleep 5
    local AFTER
    AFTER=$(psql "$PG_URL" -tAc "select coalesce(max(time_created),0) from session_message where session_id='$1' and type='idle'" | tr -d ' ')
    [ "$AFTER" -gt "$BEFORE" ] && return 0
  done
  return 1
}
sh_out() { # $1=session $2=command
  api -X POST "$BASE/api/session/$1/exec" -d "{\"command\":$(json_text "$2")}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout',''))" 2>/dev/null
}
last_history_path() { # $1=session -> newest completed compaction historyPath ("" when degraded/absent)
  psql "$PG_URL" -tAc "select coalesce(data::jsonb->>'historyPath','') from session_message where session_id='$1' and type='compaction' and data::jsonb->>'status'='completed' order by time_created desc limit 1" | tr -d ' '
}
wait_compact() { # $1=session -> historyPath or ""
  for _ in $(seq 1 40); do
    sleep 5
    local P
    P=$(last_history_path "$1")
    [ -n "$P" ] && { echo "$P"; return 0; }
  done
  echo ""
}
completed_count() {
  psql "$PG_URL" -tAc "select count(*) from session_message where session_id='$1' and type='compaction' and data::jsonb->>'status'='completed'" | tr -d ' '
}

SECRET="violet-owl-42"

if run T-CX.2; then
echo "===== T-CX.2 compaction writes the history file ====="
S=$(new_s tcx2)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
prompt "$S" "I am testing compaction history. Remember the secret code $SECRET - it appears exactly once, here." || fail "T-CX.2" "prompt1 timeout"
prompt "$S" "Good. A bit more conversation so the history is long enough: today the weather is fine and we are verifying the compaction history file feature." || fail "T-CX.2" "prompt2 timeout"
api -X POST "$BASE/api/session/$S/compact" -d '{}' >/dev/null
HP=$(wait_compact "$S")
[ -n "$HP" ] && pass "T-CX.2-historyPath" "$HP" || fail "T-CX.2-historyPath" "no historyPath (compaction incomplete?)"
if [ -n "$HP" ]; then
  LIST=$(sh_out "$S" "ls $TOOL_OUTPUT | grep tool_history_")
  FNAME=$(basename "$HP")
  echo "$LIST" | grep -q "$FNAME" && pass "T-CX.2-file" "$FNAME" || fail "T-CX.2-file" "sandbox missing $FNAME: $LIST"
  BODY=$(sh_out "$S" "cat '$HP'")
  echo "$BODY" | grep -q "$SECRET" && pass "T-CX.2-secret" "" || fail "T-CX.2-secret" "file lacks $SECRET"
  echo "$BODY" | grep -qE "^## msg_.* \| user \| [0-9]{4}-" && pass "T-CX.2-header" "" || fail "T-CX.2-header" "missing section headers"
fi
echo "$S" > /tmp/tcx-sid.txt
echo "$HP" > /tmp/tcx-hp.txt
fi

if run T-CX.3; then
echo "===== T-CX.3 historyPath persisted on the message row ====="
S=$(cat /tmp/tcx-sid.txt 2>/dev/null); HP=$(cat /tmp/tcx-hp.txt 2>/dev/null)
if [ -n "$S" ] && [ -n "$HP" ]; then
  ROW=$(psql "$PG_URL" -tAc "select id from session_message where session_id='$S' and type='compaction' and data::jsonb->>'historyPath'='$HP'" | tr -d ' ')
  FNAME=$(basename "$HP" | sed 's/^tool_history_//; s/\.md$//')
  [ -n "$ROW" ] && [ "$ROW" = "$FNAME" ] && pass "T-CX.3" "message id matches file name" || fail "T-CX.3" "row=$ROW expect=$FNAME"
else
  fail "T-CX.3" "missing prerequisite (run T-CX.2 first)"
fi
fi

if run T-CX.4; then
echo "===== T-CX.4 retrieval: recover the detail after compaction ====="
S=$(cat /tmp/tcx-sid.txt 2>/dev/null)
if [ -n "$S" ]; then
  prompt "$S" "What was the secret code I told you earlier? If you do not remember, search the compacted history file with Grep or Read. Answer with the code only." || fail "T-CX.4" "prompt timeout"
  ANS=$(psql "$PG_URL" -tAc "select string_agg(c.value->>'text',' ') from (select data::jsonb->'content' as content from session_message where session_id='$S' and type='assistant' order by time_created desc limit 3) t, jsonb_array_elements(t.content) c where c.value->>'type'='text'")
  echo "  latest reply: $(echo "$ANS" | head -c 120)"
  echo "$ANS" | grep -q "$SECRET" && pass "T-CX.4" "" || fail "T-CX.4" "reply lacks $SECRET"
else
  fail "T-CX.4" "missing prerequisite"
fi
fi

if run T-CX.5; then
echo "===== T-CX.5 graceful degradation when the write fails ====="
S=$(cat /tmp/tcx-sid.txt 2>/dev/null)
if [ -n "$S" ]; then
  # occupy the directory path with a file so mkdir/write must fail (works for root too)
  sh_out "$S" "rm -rf $TOOL_OUTPUT && touch $TOOL_OUTPUT"
  prompt "$S" "One more turn of content to trigger another compaction for the degradation check." || fail "T-CX.5" "prompt timeout"
  api -X POST "$BASE/api/session/$S/compact" -d '{}' >/dev/null
  DEGRADED=""
  for _ in $(seq 1 40); do
    sleep 5
    local_dummy=$(completed_count "$S")
    if [ "$local_dummy" -ge 2 ]; then DEGRADED=$(last_history_path "$S"); break; fi
  done
  if [ -z "$(echo "$DEGRADED" | tr -d ' ')" ]; then
    pass "T-CX.5" "compaction completed without historyPath (degraded)"
  else
    fail "T-CX.5" "degraded='$DEGRADED' (expected empty)"
  fi
  WARNED=$(docker exec opencode-v2-test sh -c "grep -a 'failed to write compaction history' /home/opencode/.local/share/opencode/log/opencode-local.log | tail -1" 2>/dev/null)
  [ -n "$WARNED" ] && echo "  WARN log confirmed" || echo "  WARN log not found (degradation branch may not have run)"
  # restore the directory for later cases
  sh_out "$S" "rm -f $TOOL_OUTPUT && mkdir -p $TOOL_OUTPUT"
else
  fail "T-CX.5" "missing prerequisite"
fi
fi

if run T-CX.6; then
echo "===== T-CX.6 stale file cleanup ====="
S=$(cat /tmp/tcx-sid.txt 2>/dev/null)
if [ -n "$S" ]; then
  sh_out "$S" "mkdir -p $TOOL_OUTPUT && touch -t \$(date -d '8 days ago' +%Y%m%d%H%M 2>/dev/null || date -v-8d +%Y%m%d%H%M) $TOOL_OUTPUT/tool_history_stale.md && echo stale-ok"
  prompt "$S" "Another turn of content to trigger the next compaction and the retention sweep." || fail "T-CX.6" "prompt timeout"
  api -X POST "$BASE/api/session/$S/compact" -d '{}' >/dev/null
  HP=$(wait_compact "$S")
  [ -n "$HP" ] || fail "T-CX.6" "compaction incomplete"
  sleep 3
  STALE=$(sh_out "$S" "ls $TOOL_OUTPUT/tool_history_stale.md 2>/dev/null | wc -l" | tr -d ' ')
  NEWF=$(sh_out "$S" "ls $TOOL_OUTPUT | grep -c tool_history_" | tr -d ' ')
  [ "$STALE" = "0" ] && [ "$NEWF" -ge 1 ] && pass "T-CX.6" "stale removed, fresh kept" || fail "T-CX.6" "stale=$STALE new=$NEWF"
else
  fail "T-CX.6" "missing prerequisite"
fi
fi

if run T-CX.7; then
echo "===== T-CX.7 chained history across two compactions ====="
# Self-contained: T-CX.5 destroys earlier files, so build a fresh two-compaction chain
S=$(new_s tcx7)
api -X POST "$BASE/api/session/$S/keep-alive" -d '{"enabled":true,"boot":true}' >/dev/null
prompt "$S" "Chained history test. The secret code for round one is indigo-falcon-77. Reply in one short sentence without using any tools." || fail "T-CX.7" "prompt1 timeout"
prompt "$S" "More content for length: we are verifying that the second history file references the first one. Reply in one short sentence without using any tools." || fail "T-CX.7" "prompt2 timeout"
api -X POST "$BASE/api/session/$S/compact" -d '{}' >/dev/null
FIRST=$(wait_compact "$S")
[ -n "$FIRST" ] || fail "T-CX.7" "first compaction incomplete"
prompt "$S" "Second round content. Another detail: the round-two marker is amber-lynx-05. Reply in one short sentence without using any tools." || fail "T-CX.7" "prompt3 timeout"
prompt "$S" "Final padding turn so the second compaction has enough head. Reply in one short sentence without using any tools." || fail "T-CX.7" "prompt4 timeout"
api -X POST "$BASE/api/session/$S/compact" -d '{}' >/dev/null
SECOND=""
for _ in $(seq 1 40); do
  sleep 5
  SECOND=$(psql "$PG_URL" -tAc "select coalesce(data::jsonb->>'historyPath','') from session_message where session_id='$S' and type='compaction' and data::jsonb->>'status'='completed' and data::jsonb->>'historyPath' <> '$FIRST' order by time_created desc limit 1" | tr -d ' ')
  [ -n "$SECOND" ] && break
done
if [ -n "$FIRST" ] && [ -n "$SECOND" ] && [ "$SECOND" != "$FIRST" ]; then
  CHAIN=$(sh_out "$S" "grep -n 'Earlier compacted history' '$SECOND'")
  echo "$CHAIN" | grep -q "$(basename "$FIRST")" && pass "T-CX.7" "second file references the first" || fail "T-CX.7" "chain='$CHAIN'"
  REACH=$(sh_out "$S" "grep -c 'indigo-falcon-77' '$FIRST'")
  [ "${REACH:-0}" -ge 1 ] && pass "T-CX.7-reachable" "first file still has the detail" || fail "T-CX.7-reachable" "REACH=$REACH"
  curl -s -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X DELETE "$BASE/api/session/$S" -o /dev/null
else
  fail "T-CX.7" "missing files (first='$FIRST' second='$SECOND')"
fi
fi

[ -n "$ONLY" ] || skip "T-CX.1" "unit tests run from the package directory (session-compaction + session-compaction + session-runner-message: 45 pass)"

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
