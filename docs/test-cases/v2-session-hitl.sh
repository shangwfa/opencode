#!/bin/bash
# V2 版 hitl-question 基础链路（对应 docs/test-cases/session/hitl-question.md 的 T1/T5/T3 核心子集）。
# v2 的 HITL 走 Form 体系：question/permission 工具 -> Form.ask -> /api/form 端点。
# v1 的 PG 持久化/多实例路由/x-user-id 隔离/租约清扫 = SaaS 定制，v2 待迁移（标 N/A）。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"

PASS=0; FAIL=0; NA=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
na() { echo "➖ $1 N/A: ${2:-}"; NA=$((NA+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"hitl\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
msg_count() { api "$BASE/api/session/$1/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0; }
# 等待出现 idle（run 结束）
wait_idle() { local sid="$1" waited=0; while [ "$waited" -lt 100 ]; do A=$(api "$BASE/api/session/$sid/message" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(any(m.get('type')=='idle' for m in d))" 2>/dev/null); [ "$A" = "True" ] && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
# 等待出现 pending form
wait_form() { local sid="$1" waited=0 fid; while [ "$waited" -lt 100 ]; do fid=$(api "$BASE/api/form?sessionID=$sid" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(d[0]['id'] if d else '')" 2>/dev/null); [ -n "$fid" ] && printf '%s' "$fid" && return 0; sleep 4; waited=$((waited+4)); done; return 1; }

# ============ T1.1 异步触发 question 挂起 ============
echo "== T1.1 触发 question 挂起 =="
SID=$(new_session)
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"用 question 工具问我：选择哪种语言？选项 [python, javascript]。问完停下等回答，不要自己假设。"}' >/dev/null
FID=$(wait_form "$SID")
if [ -n "$FID" ]; then
  FJSON=$(api "$BASE/api/form?sessionID=$SID")
  OK=$(printf '%s' "$FJSON" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
f=d[0] if d else {}
print('yes' if f.get('sessionID')=='$SID' and 'ython' in json.dumps(f).lower() else 'no')" 2>/dev/null)
  [ "$OK" = "yes" ] && pass "T1.1（question 挂起：form 含 sessionID 与选项）" "form=${FID:0:20}..." || fail "T1.1" "form 内容异常: $(printf '%s' "$FJSON" | head -c 150)"
else
  fail "T1.1" "100s 内未见挂起 form"
fi

# ============ T1.3 reply 后 run 继续 ============
echo ""
echo "== T1.3 回复并继续 =="
if [ -n "$FID" ]; then
  # 回复端点：POST /api/session/:sid/form/:fid/reply，payload {"answer": {"<fieldKey>": "<value>"}}
  Q0VAL=$(api "$BASE/api/form?sessionID=$SID" | python3 -c "
import json,sys
f=json.load(sys.stdin).get('data',[{}])[0]
opt=(f.get('fields') or [{}])[0].get('options',[{}])
print((opt[0].get('value') if opt else '') or '')" 2>/dev/null)
  Q0KEY=$(api "$BASE/api/form?sessionID=$SID" | python3 -c "
import json,sys
f=json.load(sys.stdin).get('data',[{}])[0]
print((f.get('fields') or [{}])[0].get('key','q0'))" 2>/dev/null)
  C=$(api -o /tmp/hitl-r.json -w "%{http_code}" -X POST "$BASE/api/session/$SID/form/$FID/reply" -d "{\"answer\":{\"$Q0KEY\":\"$Q0VAL\"}}")
  BODY=$(head -c 150 /tmp/hitl-r.json)
  echo "   reply HTTP=$C key=$Q0KEY val=$Q0VAL body=$(printf '%s' "$BODY" | head -c 80)"
  wait_idle "$SID"
  TEXT=$(api "$BASE/api/session/$SID/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='assistant' and m.get('finish'):
        t=' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text')
        if t: print(t); break" 2>/dev/null)
  HAS=$(printf '%s' "$TEXT" | grep -qi python && echo yes || echo no)
  [ "$HAS" = "yes" ] && pass "T1.3（回复后 run 继续且 AI 收到答案）" "text=${T:0:40}" || fail "T1.3" "text='$(printf '%s' "$TEXT" | head -c 80)' http=$C"
fi

# ============ T5.1 答案驱动行为分支 ============
echo ""
echo "== T5.1 澄清分叉（选 python → 建 .py）=="
SID5=$(new_session)
api -X POST "$BASE/api/session/$SID5/prompt" -d '{"text":"在 /workspace/app5 创建一个入口文件。语言不明确时必须先用 question 工具问我选哪种语言，选项：[python, javascript]，问完停下等回答，不要自己假设。"}' >/dev/null
FID5=$(wait_form "$SID5")
if [ -n "$FID5" ]; then
  Q5V=$(api "$BASE/api/form?sessionID=$SID5" | python3 -c "
import json,sys
f=json.load(sys.stdin).get('data',[{}])[0]
opt=(f.get('fields') or [{}])[0].get('options',[{}])
v=(opt[0].get('value') if opt else '')
print(v if 'ython' in v.lower() else 'python')" 2>/dev/null)
  api -X POST "$BASE/api/session/$SID5/form/$FID5/reply" -d "{\"answer\":{\"q0\":\"$Q5V\"}}" >/dev/null 2>&1
  echo "   T5.1 reply: q0=$Q5V"
  wait_idle "$SID5"
  OUT=$(api -X POST "$BASE/api/session/$SID5/exec" -d '{"command":"ls /workspace/app5/ 2>&1"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null)
  if printf '%s' "$OUT" | grep -q "\.py" && ! printf '%s' "$OUT" | grep -q "\.js"; then
    pass "T5.1（选 python → .py 入口，无 .js）" "ls=$OUT"
  else
    fail "T5.1" "ls='$OUT'"
  fi
else
  fail "T5.1" "未见挂起 form"
fi

# ============ T3.1 permission ask（探测）============
echo ""
echo "== T3.1 permission 挂起（会话规则 ask）=="
SID3=$(new_session)
# v2 会话权限更新端点
C3=$(api -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/session/$SID3" -d '{"permissions":{"bash":{"rm*":{"action":"ask"}}}}')
echo "   PATCH permissions: HTTP=${C3}（v2 的权限 schema 形状若不符则本项 N/A）"
if [ "$C3" = "200" ] || [ "$C3" = "204" ]; then
  api -X POST "$BASE/api/session/$SID3/prompt" -d '{"text":"用 bash 执行 rm -rf /tmp/perm-ask-test，直接执行不要询问我"}' >/dev/null
  FID3=$(wait_form "$SID3")
  if [ -n "$FID3" ]; then
    pass "T3.1（permission 挂起触发）" "form=${FID3:0:20}"
  else
    # permission 挂起可能不走 form（走 Permission.ask 的别的通道）——查消息里的 pending 工具
    PEND=$(api "$BASE/api/session/$SID3/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    for p in (m.get('content') or []):
        if p.get('type')=='tool' and (p.get('state') or {}).get('status')=='pending':
            print('pending-tool'); break" 2>/dev/null)
    [ "$PEND" = "pending-tool" ] && pass "T3.1（permission 挂起：tool pending）" || fail "T3.1" "无挂起痕迹"
  fi
else
  na "T3.1" "v2 权限更新端点形状不同（HTTP ${C3}），permission-ask 链路待适配"
fi

# ============ v1 定制体系（N/A 清单）============
echo ""
echo "== v1 定制体系（待迁移）=="
na "T2.x" "HITL PG 持久化（hitl_request 表/重启恢复/租约清扫）——v2 form 为内存态"
na "T4.x" "多实例路由（PG NOTIFY/轮询）——v2 无集群"
na "T7.1/T8.9" "x-user-id 用户隔离——v2 无多租户层"
na "T7.5/T7.7" "拒绝意见/exec_log 审计——exec_log 未迁移"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL N/A=$NA ====="
[ "$FAIL" = "0" ]
