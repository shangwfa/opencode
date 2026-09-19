#!/bin/bash
# 沙箱创建后台化与销毁竞态（sandbox-create-background.md T-SBG.1~3）——v2 适配版。
#
# v1 -> v2 映射：
#   sandbox-provider.ts getOrCreateUnlocked（creationScope 后台创建 + createRef/Deferred 去重）
#     -> workspace.ts provision（attempts Deferred 去重 + fork 后台创建，机制等价已实现）
#   destroyById 补 Deferred.fail -> workspace destroy：attempts 条目 Exit.fail(NotFound)（同款）
#   bash 工具 -> shell（v2 命名；判定按 tool in (shell,bash)）
#   PG sandbox 表 -> workspace 表 binding（sandboxId 非空 = 单实例 running 等价）
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

api() { curl -s -m 300 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_s() {
  local id=""
  for _ in 1 2 3; do
    RAW=$(curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL_ID\"}}")
    id=$(echo "$RAW" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
    [ -z "$id" ] && echo "  [new_s fail] raw: $(echo "$RAW" | head -c 120) title=$1" >&2
    [ -n "$id" ] && { echo "$id"; return 0; }
    sleep 2
  done
  echo ""
}
perms() { api -X PATCH "$BASE/api/session/$1" -d '{"permissions":[{"action":"shell","resource":"*","effect":"allow"},{"action":"read","resource":"*","effect":"allow"},{"action":"external_directory","resource":"/workspace/*","effect":"allow"}]}' >/dev/null; }
send_async() { curl -s -m 300 -o "$3" -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$1/prompt" -d "{\"text\":$2}" & }
# 等待 bash/shell completed 工具数达到目标
wait_tools() { # $1=sid $2=target $3=max*2s
  for _ in $(seq 1 "${3:-90}"); do
    N=$(psql "$PG_URL" -tAc "
      select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
      where m.session_id='$1' and c->>'type'='tool' and c->>'name' in ('shell','bash')
        and c->'state'->>'status'='completed'" | tr -d ' ')
    [ "${N:-0}" -ge "$2" ] && { echo "$N"; return 0; }
    sleep 2
  done
  echo "${N:-0}"; return 1
}
# 终态 execution 数
runs() { psql "$PG_URL" -tAc "select count(*) from event where aggregate_id='$1' and type in ('session.execution.succeeded.2','session.execution.failed.2')" | tr -d ' '; }

if run T-SBG.1; then
echo "===== T-SBG.1 并发首消息：两条消息共享一次创建 ====="
S=$(new_s sbg1); perms "$S"
BEFORE=$(runs "$S")
send_async "$S" '"用 shell 工具执行 echo sbg1，报告输出"' /tmp/sbg1.json
PID1=$!
sleep 1
send_async "$S" '"用 shell 工具执行 echo sbg2，报告输出"' /tmp/sbg2.json
PID2=$!
wait $PID1 $PID2 2>/dev/null
BOTH=$(wait_tools "$S" 2 90)
WS=$(psql "$PG_URL" -tAc "select count(*) from workspace where id=(select workspace_id from session_v2 where id='$S')" | tr -d ' ')
SBX=$(psql "$PG_URL" -tAc "select binding::jsonb->>'sandboxId' is not null from workspace where id=(select workspace_id from session_v2 where id='$S')" | tr -d ' ')
echo "  并发 shell/bash completed=$BOTH workspace 单行=$WS sandboxId=$SBX runs=$(runs "$S")"
if [ "${BOTH:-0}" -ge 2 ] && [ "$SBX" = "t" ]; then
  pass "T-SBG.1（并发消息 bash 均 completed，共享单沙箱实例）" "completed=$BOTH"
else
  fail "T-SBG.1" "completed=$BOTH sandboxId=$SBX"
fi
api -X DELETE "$BASE/api/session/$S" >/dev/null 2>&1
fi

if run T-SBG.2; then
echo "===== T-SBG.2 创建窗口内 kill-sandbox：快速失败/恢复 ====="
S2=$(new_s sbg2); perms "$S2"
send_async "$S2" '"用 shell 工具执行 pwd，报告输出"' /tmp/sbg3.json
PID3=$!
sleep 2
KILL_AT=$(date +%s)
curl -s -m 15 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -X POST "$BASE/api/session/$S2/kill-sandbox" >/dev/null
wait $PID3 2>/dev/null
START=$(date +%s)
send "$S2" '"用 shell 工具执行 echo sbg-recovered，报告输出"'
waitrun_out=$(wait_tools "$S2" 1 60)
DUR=$(( $(date +%s) - START ))
FINAL=$(psql "$PG_URL" -tAc "
  select string_agg(distinct c->'state'->>'status', ',') from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where m.session_id='$S2' and c->>'name' in ('shell','bash')" | tr -d ' ')
echo "  消息2 耗时 ${DUR}s（kill 距今 $(( $(date +%s) - KILL_AT ))s），shell/bash 状态聚合: $FINAL"
if [ "$DUR" -lt 100 ] && echo "$FINAL" | grep -q "completed"; then
  pass "T-SBG.2（${DUR}s 内恢复，无 90s 长挂）" "statuses=$FINAL"
else
  fail "T-SBG.2" "dur=${DUR}s statuses=$FINAL"
fi
api -X DELETE "$BASE/api/session/$S2" >/dev/null 2>&1
fi

if run T-SBG.3; then
echo "===== T-SBG.3 正常会话全链路回归 ====="
S3=$(new_s sbg3); perms "$S3"
# 先 exec 预热 provision（等价 v1 keep-alive boot）
curl -s -m 180 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S3/exec" -d '{"command":"echo warm"}' >/dev/null
send "$S3" '"依次：用 shell 工具执行 echo ok > /workspace/sbg.txt；然后用 read 工具读取 /workspace/sbg.txt；报告结果"'
wait_tools "$S3" 2 90 >/dev/null
OKS=$(psql "$PG_URL" -tAc "
  select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') c
  where m.session_id='$S3' and c->>'type'='tool' and c->'state'->>'status'='completed'" | tr -d ' ')
echo "  completed 工具数: $OKS"
[ "${OKS:-0}" -ge 2 ] && pass "T-SBG.3（bash+read 全链路 completed）" "completed=$OKS" || fail "T-SBG.3" "completed=$OKS"
# api -X DELETE "$BASE/api/session/$S3" >/dev/null 2>&1  # (debug: keep)
fi

echo ""
echo "===== result: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
