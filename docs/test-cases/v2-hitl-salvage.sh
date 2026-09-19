#!/bin/bash
# HITL 恢复语义验证：T2.4 悬空 tool part 收场 / T2.5 已答未消费答案回填 / T6.4 abort 租约清扫。
#
# 语义（对齐 v1 hitl/salvage.ts 三分支）：
#   pending  未答   → tool part 写 failed（实例重启文案），行 closed|instance-restart
#   replied  未消费 → tool part 写 completed（答案回填），行 closed|answered-delivered
#   rejected 未消费 → tool part 写 failed（拒绝文案），行保持 rejected
# 触发条件：行租约过期 + grace（活实例每 30s 续租，死实例的行才会到期）。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"
CONTAINER="${CONTAINER:-opencode-v2-test}"
SWEEP_WAIT="${SWEEP_WAIT:-200}" # lease(60s) + grace(90s) + 扫描周期余量

PASS=0; FAIL=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"salvage\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
set_rule() { api -X PATCH "$BASE/api/session/$1" -d "{\"permissions\":[{\"action\":\"shell\",\"resource\":\"$2*\",\"effect\":\"ask\"}]}" > /dev/null; }
wait_perm() { local sid="$1" waited=0 pid; while [ "$waited" -lt 240 ]; do pid=$(api "$BASE/api/permission/request" | SID="$sid" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$pid" ] && printf '%s' "$pid" && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
wait_form() { local sid="$1" waited=0 fid; while [ "$waited" -lt 240 ]; do fid=$(api "$BASE/api/form" | SID="$sid" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);d=[x for x in d if x['sessionID']==os.environ['SID']];print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$fid" ] && printf '%s' "$fid" && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
tool_state() { # sid toolname -> "status|output"
  api "$BASE/api/session/$1/message" | NAME="$2" python3 -c "
import json,sys,os
name=os.environ['NAME']
for m in json.load(sys.stdin).get('data',[]):
    for p in (m.get('content') or []):
        if p.get('type')=='tool' and p.get('name')==name:
            st=p.get('state') or {}
            out=st.get('content') or st.get('error') or ''
            print(st.get('status',''), '|', str(out)[:200])" 2>/dev/null | tail -1
}

echo "===== T6.4 abort（interrupt）租约清扫 ====="
C4="t64$(date +%s)"
S4=$(new_session); set_rule "$S4" "$C4"
api -X POST "$BASE/api/session/$S4/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $C4 并原样返回输出，禁止直接回答\"}" > /dev/null
P4=$(wait_perm "$S4")
if [ -z "$P4" ]; then
  fail "T6.4 abort 清扫" "未见挂起"
else
  api -X POST "$BASE/api/session/$S4/interrupt" > /dev/null
  sleep 4
  N4=$(api "$BASE/api/permission/request" | SID="$S4" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);print(len([x for x in d if x['sessionID']==os.environ['SID']]))" 2>/dev/null)
  PG4=$(psql "$PG_URL" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P4'" | tr -d ' ')
  [ "${N4:-1}" = "0" ] && [ "$PG4" = "closed|instance-restart" ] && pass "T6.4（interrupt → 待办清零 + closed|instance-restart）" "pending=$N4 pg=$PG4" || fail "T6.4" "pending=$N4 pg=$PG4"
fi

echo ""
echo "===== T2.4 挂起 run 悬死 → 租约清扫收场 ====="
C24="t24$(date +%s)"
S24=$(new_session); set_rule "$S24" "$C24"
api -X POST "$BASE/api/session/$S24/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $C24 并原样返回输出，禁止直接回答\"}" > /dev/null
P24=$(wait_perm "$S24")
if [ -z "$P24" ]; then
  fail "T2.4" "未见挂起"
else
  echo "   挂起 $P24 → 重启容器（模拟持有实例死亡），等租约清扫窗口 ${SWEEP_WAIT}s"
  docker restart "$CONTAINER" > /dev/null
  sleep "$SWEEP_WAIT"
  api "$BASE/api/permission/request" > /dev/null 2>&1
  sleep 40
  N24=$(api "$BASE/api/permission/request" | SID="$S24" python3 -c "import json,sys,os;d=json.load(sys.stdin).get('data',[]);print(len([x for x in d if x['sessionID']==os.environ['SID']]))" 2>/dev/null)
  PG24=$(psql "$PG_URL" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P24'" | tr -d ' ')
  TS24=$(tool_state "$S24" shell)
  if [ "$PG24" = "closed|instance-restart" ] && printf '%s' "$TS24" | grep -qE "error|failed"; then
    pass "T2.4（悬空 tool part 收场 failed + closed|instance-restart）" "pending=${N24} state=${TS24:0:40}"
  else
    fail "T2.4" "pending=${N24} pg=$PG24 state=${TS24:0:60}"
  fi
fi

echo ""
echo "===== T2.5 answered-lost 答案回填 ====="
C25="t25$(date +%s)"
S25=$(new_session); set_rule "$S25" "$C25"
api -X POST "$BASE/api/session/$S25/prompt" -d "{\"text\":\"必须使用 bash 工具执行命令 $C25 并原样返回输出，禁止直接回答\"}" > /dev/null
P25=$(wait_perm "$S25")
if [ -z "$P25" ]; then
  fail "T2.5" "未见挂起"
else
  # 先重启让持有实例死亡（行恢复为 pending 且不再续租），再提交答案——
  # 这样答案一定“已答未消费”。
  docker restart "$CONTAINER" > /dev/null
  sleep 25
  CODE25=$(curl -s -o /tmp/sv-b.json -w "%{http_code}" -m 30 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" -X POST "$BASE/api/session/$S25/permission/$P25/reply" -d '{"decision":"once","message":"马上继续，注意日志"}')
  PG25A=$(psql "$PG_URL" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P25'" | tr -d ' ')
  echo "   reply http=${CODE25} -> ${PG25A} ; 等清扫窗口 ${SWEEP_WAIT}s"
  sleep "$SWEEP_WAIT"
  api "$BASE/api/permission/request" > /dev/null 2>&1
  sleep 40
  PG25B=$(psql "$PG_URL" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P25'" | tr -d ' ')
  TS25=$(tool_state "$S25" shell)
  BACKFILLED="no"; printf '%s' "$TS25" | grep -q "completed" && BACKFILLED="yes"
  if [ "$BACKFILLED" = "yes" ]; then
    pass "T2.5（答案回填 completed）" "pg=$PG25B state=${TS25:0:60}"
  else
    fail "T2.5" "pg=$PG25B state=${TS25:0:60}"
  fi
  # 新 prompt 让模型引用回填结果
  api -X POST "$BASE/api/session/$S25/prompt" -d '{"text":"刚才那次审批的状态是什么？请照抄工具结果里的文字"}' > /dev/null
  sleep 25
  RECITE=$(api "$BASE/api/session/$S25/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='assistant':
        t=' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text').strip()
        if t: print(t[:160])" 2>/dev/null | tail -1)
  printf '%s' "$RECITE" | grep -qE "审批|once|批准|approved" && pass "T2.5b（新 run 引用回填答案）" "text=${RECITE:0:50}" || fail "T2.5b" "text=${RECITE:0:60}"
fi

echo ""
echo "===== T2.4q question 悬空收场（重启后未答） ====="
S24Q=$(new_session)
api -X POST "$BASE/api/session/$S24Q/prompt" -d '{"text":"必须使用 question 工具向我提问（禁止直接文字回答）：重启测试？选项 [A, B]"}' > /dev/null
F24Q=$(wait_form "$S24Q")
if [ -z "$F24Q" ]; then
  fail "T2.4q" "未见 form"
else
  docker restart "$CONTAINER" > /dev/null
  sleep "$SWEEP_WAIT"
  # 唤醒 location 实例：恢复/清扫跑在 location layer 的启动块与周期循环里，
  # 必须先有一次 API 请求触发构建，再等一个清扫周期。
  api "$BASE/api/permission/request" > /dev/null 2>&1
  sleep 40
  PGF=$(psql "$PG_URL" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$F24Q'" | tr -d ' ')
  TSF=$(tool_state "$S24Q" question)
  [ "$PGF" = "closed|instance-restart" ] && printf '%s' "$TSF" | grep -qE "error|failed" && pass "T2.4q（question 悬空 failed + closed|instance-restart）" "state=${TSF:0:40}" || fail "T2.4q" "pg=$PGF state=${TSF:0:60}"
fi

echo ""
echo "===== 清理 ====="
for s in "$S4" "$S24" "$S25" "$S24Q"; do api -X DELETE "$BASE/api/session/$s" > /dev/null 2>&1; done
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
