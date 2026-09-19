#!/bin/bash
# V2 版 hitl-question 全量用例（docs/test-cases/session/hitl-question.md T1–T8 全部）。
# v2 的 HITL = Form 体系（内存态）；v1 的 PG hitl_request/租约/多实例/x-user-id 为定制。
# 执行原则：每个用例真实执行，如实记录 PASS / FAIL(差距) / N/A(待迁移)。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
CONTAINER="${CONTAINER:-opencode-v2-test}"

PASS=0; FAIL=0; NA=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
na() { echo "➖ $1 N/A: ${2:-}"; NA=$((NA+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
api_code() { curl -s -o /tmp/h-body.json -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"hitl-full\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
wait_form_of() { local sid="$1" waited=0 fid; while [ "$waited" -lt 100 ]; do fid=$(api "$BASE/api/form?sessionID=$sid" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$fid" ] && printf '%s' "$fid" && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
form_field() { api "$BASE/api/form?sessionID=$1" | python3 -c "
import json,sys
f=(json.load(sys.stdin).get('data') or [{}])[0]
fl=(f.get('fields') or [{}])[0]
opt=fl.get('options') or [{}]
print(f\"{fl.get('key','q0')}|{opt[0].get('value','') if opt else ''}\")" 2>/dev/null; }
reply_form() { local sid="$1" fid="$2" kv="$3"; api_code -X POST "$BASE/api/session/$sid/form/$fid/reply" -d "{\"answer\":{\"${kv%%|*}\":\"${kv#*|}\"}}"; }
wait_idle() { local sid="$1" waited=0; while [ "$waited" -lt 120 ]; do A=$(api "$BASE/api/session/$sid/message" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(any(m.get('type')=='idle' for m in d))" 2>/dev/null); [ "$A" = "True" ] && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
last_text() { api "$BASE/api/session/$1/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='assistant' and m.get('finish'):
        t=' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text').strip()
        if t: print(t); break" 2>/dev/null; }
trigger_question() { local sid="$1" q="$2" opts="$3"; api -X POST "$BASE/api/session/$sid/prompt" -d "{\"text\":\"请立即使用 question 工具向我提问：'$q'，选项：${opts}。发完问题就停下来等我的回答，不要自己猜测答案。\"}" >/dev/null; }

echo "################ 一、T1 触发基线 ################"
SID=$(new_session)
trigger_question "$SID" "测试流程是否继续" "[继续, 停止]"
FID=$(wait_form_of "$SID")
if [ -n "$FID" ]; then pass "T1.1（异步触发 question 挂起）" "form=${FID:0:18}"; else fail "T1.1" "100s 无挂起"; fi

if [ -n "$FID" ]; then
  OK=$(api "$BASE/api/form?sessionID=$SID" | python3 -c "
import json,sys
f=(json.load(sys.stdin).get('data') or [{}])[0]
fls=f.get('fields') or []
print('yes' if f.get('id') and f.get('sessionID')=='$SID' and len(fls)>=1 else 'no')" 2>/dev/null)
  [ "$OK" = "yes" ] && pass "T1.2（pending 内容完整：id/sessionID/fields）" || fail "T1.2" "内容异常"
fi

if [ -n "$FID" ]; then
  KV=$(form_field "$SID")
  C=$(reply_form "$SID" "$FID" "$KV")
  wait_idle "$SID"
  TXT=$(last_text "$SID")
  ZERO=$(api "$BASE/api/form?sessionID=$SID" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  [ "${ZERO:-1}" = "0" ] && [ -n "$TXT" ] && pass "T1.3（reply 后 run 完成 + form 清空）" "text=$(printf '%s' "$TXT" | head -c 30)" || fail "T1.3" "form_left=$ZERO text='$TXT'"
fi

echo ""
echo "################ 二、T2 重启持久化（v2 form 内存态，如实记录差距）################"
SID2=$(new_session)
trigger_question "$SID2" "重启场景继续" "[继续]"
FID2=$(wait_form_of "$SID2")
if [ -n "$FID2" ]; then
  docker restart "$CONTAINER" >/dev/null
  for i in $(seq 1 30); do curl -s -o /dev/null -m 2 -u "opencode:v2-test-pass" "$BASE/api/info" && break; sleep 2; done
  AFTER=$(api "$BASE/api/form?sessionID=$SID2" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  if [ "${AFTER:-0}" = "0" ]; then
    fail "T2.1（重启后 pending 丢失——v2 form 为内存态，HITL PG 持久化待迁移）" "after=$AFTER"
  else
    pass "T2.1（重启后 pending 保留）" "after=$AFTER"
  fi
  C2=$(api_code -X POST "$BASE/api/session/$SID2/form/$FID2/reply" -d '{"answer":{"q0":"继续"}}')
  if [ "$C2" = "404" ]; then
    fail "T2.2（重启后 reply 404——同 T2.1 根因）"
  else
    pass "T2.2（重启后 reply ${C2}）"
  fi
else
  fail "T2.x 前置" "挂起未建立"
fi
na "T2.3" "PG 载体检查（hitl_request 表）——v2 无此表，HITL 持久化待迁移"
na "T2.4" "挂起 run 悬死/租约清扫——v2 无租约体系（v1 定制）"
na "T2.5" "answered-lost 回填——依赖 T2.3 载体"

echo ""
echo "################ 三、T3 permission ################"
SID3=$(new_session)
C3=$(api_code -X PATCH "$BASE/api/session/$SID3" -d '{"permissions":[{"action":"shell","resource":"rm*","effect":"ask"}]}')
api -X POST "$BASE/api/session/$SID3/prompt" -d '{"text":"用 bash 执行 rm -rf /tmp/perm-ask-test，直接执行不要问我"}' >/dev/null
P3=""
for i in $(seq 1 25); do P3=$(api "$BASE/api/permission/request?sessionID=$SID3" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$P3" ] && break; sleep 4; done
if [ -n "$P3" ]; then
  PG3=$(psql "postgresql://local@127.0.0.1:15432/opencode_v2" -tAc "SELECT status FROM hitl_request WHERE id='$P3'" | tr -d ' ')
  [ "$PG3" = "pending" ] && pass "T3.1（permission ask 挂起 + PG pending）" "form=${P3:0:16}" || fail "T3.1" "pg=$PG3"
  C3R=$(api_code -X POST "$BASE/api/session/$SID3/permission/$P3/reply" -d '{"decision":"once"}')
  PG3R=$(psql "postgresql://local@127.0.0.1:15432/opencode_v2" -tAc "SELECT status||'|'||coalesce(close_reason,'-') FROM hitl_request WHERE id='$P3'" | tr -d ' ')
  [ "$C3R" = "204" ] && pass "T3.2（reply 204）" "终态=${PG3R}" || fail "T3.2" "http=$C3R"
else
  fail "T3.1" "未见挂起"
fi

echo ""
echo "################ 五、T5 真实场景 E2E ################"
SID5=$(new_session)
api -X POST "$BASE/api/session/$SID5/prompt" -d '{"text":"在 /workspace/appF 创建一个入口文件。语言不明确时必须先用 question 工具问我选哪种语言，选项：[python, javascript]，问完停下等回答，不要自己假设。"}' >/dev/null
FID5=$(wait_form_of "$SID5")
if [ -n "$FID5" ]; then
  KV5=$(form_field "$SID5")
  reply_form "$SID5" "$FID5" "$KV5" >/dev/null
  wait_idle "$SID5"
  LS=$(api -X POST "$BASE/api/session/$SID5/exec" -d '{"command":"ls /workspace/appF/ 2>&1"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
  printf '%s' "$LS" | grep -q "\.py" && ! printf '%s' "$LS" | grep -q "\.js" && pass "T5.1（答案驱动行为：选 python → .py）" "ls=$LS" || fail "T5.1" "ls='$LS'"
else
  fail "T5.1" "无挂起"
fi

SID52=$(new_session)
api -X POST "$BASE/api/session/$SID52/prompt" -d '{"text":"准备执行 rm -f /workspace/t5-marker.txt（先用 write 工具创建它）。执行前必须用 question 工具问我：确认删除？，选项：[确认, 取消]，问完停下等回答。"}' >/dev/null
FID52=$(wait_form_of "$SID52")
if [ -n "$FID52" ]; then
  KV52=$(api "$BASE/api/form?sessionID=$SID52" | python3 -c "
import json,sys
f=(json.load(sys.stdin).get('data') or [{}])[0]
fls=f.get('fields') or [{}]
opts=fls[0].get('options') or []
val=next((o.get('value') for o in opts if '取消' in str(o.get('value',''))+str(o.get('label',''))), (opts[0].get('value') if opts else ''))
print(f\"{fls[0].get('key','q0')}|{val}\")" 2>/dev/null)
  reply_form "$SID52" "$FID52" "$KV52" >/dev/null
  wait_idle "$SID52"
  SURV=$(api -X POST "$BASE/api/session/$SID52/exec" -d '{"command":"[ -f /workspace/t5-marker.txt ] && echo FILE-SURVIVES || echo FILE-DELETED"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
  [ "$SURV" = "FILE-SURVIVES" ] && pass "T5.2（拒绝路径：取消后文件保留）" || fail "T5.2" "result=$SURV"
else
  fail "T5.2" "无挂起"
fi

SID53=$(new_session)
trigger_question "$SID53" "长挂起继续" "[继续]"
FID53=$(wait_form_of "$SID53")
if [ -n "$FID53" ]; then
  echo "   静置 125s（> v1 清扫窗口 120s 的等价场景；v2 无租约清扫）..."
  sleep 125
  P53=$(api "$BASE/api/form?sessionID=$SID53" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  KV53=$(form_field "$SID53")
  C53=$(reply_form "$SID53" "$FID53" "$KV53")
  wait_idle "$SID53" >/dev/null 2>&1
  T53=$(last_text "$SID53")
  if [ "${P53:-0}" = "1" ] && [ "$C53" = "204" ] && [ -n "$T53" ]; then
    pass "T5.3（长挂起 125s 后仍可回复并完成）" "pending_kept=$P53"
  else
    fail "T5.3" "kept=$P53 reply=$C53"
  fi
else
  fail "T5.3" "无挂起"
fi

SID54=$(new_session)
LOG=/tmp/hitl-sse.log; : > "$LOG"
(curl -s -N -m 90 -u "opencode:v2-test-pass" -H "x-opencode-directory: /workspace" "$BASE/api/event" > "$LOG") &
SSE=$!
sleep 3
trigger_question "$SID54" "SSE 场景继续" "[继续]"
FID54=$(wait_form_of "$SID54")
if [ -n "$FID54" ]; then
  HAS_F=$(grep -c "form.created" "$LOG" || true)
  KV54=$(form_field "$SID54")
  reply_form "$SID54" "$FID54" "$KV54" >/dev/null
  wait "$SSE" 2>/dev/null
  HAS_R=$(grep -c "form.replied" "$LOG" || true)
  HAS_IDLE=$(grep -cE "session.execution.(succeeded)|session.usage" "$LOG" || true)
  if [ "${HAS_F:-0}" -ge 1 ] && [ "${HAS_R:-0}" -ge 1 ]; then
    pass "T5.4（SSE：form.created + form.replied 实时推送）" "created=$HAS_F replied=$HAS_R idle-ish=$HAS_IDLE"
  else
    fail "T5.4" "created=$HAS_F replied=$HAS_R"
  fi
else
  fail "T5.4" "无挂起"; wait "$SSE" 2>/dev/null
fi
na "T5.5" "permission always 流——依赖 T3 权限端点适配"

echo ""
echo "################ 六、T6 飞书审批 ################"
na "T6.1–T6.5" "审批中心（GET /permission + response once/always/reject + 三终态留痕）——依赖 v1 permission PG 体系，v2 待迁移"

echo ""
echo "################ 七/八、T7/T8 隔离与边界 ################"
na "T7.1/T8.9" "x-user-id 用户隔离——v2 无多租户层"
na "T7.2/T8.5/T8.6" "always 级联/落库/粒度——依赖 permission 体系"
na "T7.5/T7.7" "拒绝意见/exec_log 审计——exec_log 未迁移"
na "T7.10" "会话级 ask 规则优先级——依赖权限端点"
na "T8.1" "question 多问+部分回答——v2 form fields 支持多问，但部分回答 schema 待验证（随 T3 适配）"
na "T8.3" "并发回复 CAS——v2 form reply 有 AlreadySettled 语义，需集成验证（随 T3）"
na "T8.10" "挂起豁免 stall——v2 stall 参数未迁移"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL N/A=$NA ====="
