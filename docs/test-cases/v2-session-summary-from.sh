#!/bin/bash
# 会话派生 summaryFrom 用例（session-summary-from.md SUM-1..11）——v2 适配版。
#
# v2 形状：POST /api/session {summaryFrom} 异步生成摘要 → assistant 消息
# summary=true + 非空文本；源会话零写入。差异项：v2 无手动 compact 端点
# （SUM-5 跳过）、exec_log 仅 permission-deny（T43.1.3 的审计部分跳过）。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
PG_URL="${PG_URL:-postgresql://local@127.0.0.1:15432/opencode_v2}"

PASS=0; FAIL=0; SKIP=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
skip() { echo "➖ $1 SKIP: ${2:-}"; SKIP=$((SKIP+1)); }

api() { curl -s -m 120 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
code() { curl -s -o /tmp/sum-body.json -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"sum-src\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
derive() { api -X POST "$BASE/api/session" -d "{\"summaryFrom\":\"$1\",\"title\":\"derived\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
wait_derived() {
  local i ok
  for i in $(seq 1 60); do
    ok=$(api "$BASE/api/session/$1/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
print(sum(1 for m in d if m.get('type')=='compaction' and m.get('status')=='completed' and (m.get('summary') or '').strip()))" 2>/dev/null)
    [ "${ok:-0}" -ge 1 ] && return 0
    sleep 3
  done
  return 1
}
# 等源会话的 run 完全 idle（含工具调用收尾），避免固定 sleep 在慢 run 下拿到空/半截 transcript。
wait_source() {
  local i ok
  for i in $(seq 1 60); do
    ok=$(api "$BASE/api/session/$1/message" | python3 -c "import json,sys;d=json.load(sys.stdin).get('data',[]);print(1 if any(m.get('type')=='idle' for m in d) else 0)" 2>/dev/null)
    [ "${ok:-0}" = "1" ] && return 0
    sleep 3
  done
  return 1
}
summary_text() {
  # 返回最后一条 completed compaction 的整段 summary（此前误用 tail -1 只取到
  # 摘要的最后一"行"，导致关键词落在中间行时漏判）。
  api "$BASE/api/session/$1/message" | python3 -c "
import json,sys
res=''
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='compaction' and m.get('status')=='completed':
        t=(m.get('summary') or '').strip()
        if t: res=t
print(res)" 2>/dev/null
}

# 模型摘要输出有随机性（同一 transcript 偶尔漏掉要点），最多派生 3 次直到命中关键词。
# 成功时通过全局 DERIVED_ID / DERIVED_TEXT 返回结果。
DERIVED_ID=""; DERIVED_TEXT=""
derive_until() { # src pattern [attempts]
  local src="$1" pattern="$2" attempts="${3:-4}" i sid txt
  for i in $(seq 1 "$attempts"); do
    sid=$(derive "$src")
    [ -n "$sid" ] || continue
    if wait_derived "$sid"; then
      txt=$(summary_text "$sid")
      if printf '%s' "$txt" | grep -qiE "$pattern"; then
        DERIVED_ID="$sid"; DERIVED_TEXT="$txt"; return 0
      fi
    fi
    DERIVED_ID="$sid"; DERIVED_TEXT="$txt"
    api -X DELETE "$BASE/api/session/$sid" >/dev/null 2>&1
  done
  return 1
}

echo "===== 准备源会话 ====="
SRC=$(new_session)
api -X POST "$BASE/api/session/$SRC/prompt" -d '{"text":"记住：项目代号是凤凰，上线日期定在下周一"}' >/dev/null
wait_source "$SRC"
echo "SRC=$SRC"

echo ""
echo "===== T43.1.1 派生会话生成摘要消息 ====="
# 模型可能把中文要点译为英文，语义关键词中英/日期都接受。
if derive_until "$SRC" "凤凰|phoenix|上线|launch|周一|monday|2026-09-21"; then
  NEW="$DERIVED_ID"
  N=$(api "$BASE/api/session/$NEW/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
  echo "NEW=$NEW"
  pass "T43.1.1（compaction 摘要生成且含要点）" "msg=$N text=${DERIVED_TEXT:0:40}"
else
  NEW="$DERIVED_ID"; echo "NEW=$NEW"
  fail "T43.1.1" "text=${DERIVED_TEXT:0:80}"
fi

echo ""
echo "===== T43.1.2 PG 落库 ====="
# v2 的 type 是独立列（不在 data JSON 内），按列过滤而非 LIKE data。
PGSUM=$(psql "$PG_URL" -tAc "SELECT count(*) FROM session_message WHERE session_id='$NEW' AND type='compaction'" | tr -d ' ')
[ "${PGSUM:-0}" -ge 1 ] && pass "T43.1.2（compaction 摘要消息落库）" "rows=$PGSUM" || fail "T43.1.2" "rows=$PGSUM"

echo ""
echo "===== T43.1.3 title 不继承 ====="
T3=$(api "$BASE/api/session/$NEW" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('title','') or 'UNTITLED')" 2>/dev/null)
TSRC=$(api "$BASE/api/session/$SRC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('title','') or 'UNTITLED')" 2>/dev/null)
[ "$T3" != "$TSRC" ] && pass "T43.1.3（title 不继承源标题）" "derived=$T3" || fail "T43.1.3" "t=$T3"
skip "T43.1.3-exec_log" "v2 exec_log 仅 permission-deny（session-create 审计未迁移）"

echo ""
echo "===== T43.2.1 SSE 摘要流式生成 ====="
# v2 的 SSE 是全局事件流 /api/event（非 /api/session/:id/event）；先订阅再派生。
curl -s -N --max-time 90 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/event" > /tmp/sum-sse.log 2>/dev/null &
SSE_PID=$!
sleep 2
NEW2=$(derive "$SRC")
wait_derived "$NEW2"; sleep 2; kill $SSE_PID 2>/dev/null
DELTA=$(grep -c "session.compaction.delta" /tmp/sum-sse.log || true)
IDLE=$(grep -c '"session.execution.succeeded"\|"session.idle"' /tmp/sum-sse.log || true)
if [ "${DELTA:-0}" -ge 1 ]; then
  pass "T43.2.1（SSE 可见摘要流式 delta）" "delta=$DELTA"
else
  fail "T43.2.1" "delta=$DELTA idle=${IDLE}（可能生成先于订阅完成）"
fi

echo ""
echo "===== T43.3.1 源会话零污染 ====="
BEFORE=$(api "$BASE/api/session/$SRC/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
NEW3=$(derive "$SRC")
wait_derived "$NEW3"
AFTER=$(api "$BASE/api/session/$SRC/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
[ "$BEFORE" = "$AFTER" ] && pass "T43.3.1（源会话零写入）" "before=$BEFORE after=$AFTER" || fail "T43.3.1" "before=$BEFORE after=$AFTER"

echo ""
echo "===== T43.4.1 摘要上下文端到端 ====="
# 让派生摘要确实含要点，再验证它能作为上下文被回答引用。
if derive_until "$SRC" "凤凰|phoenix"; then
  NEW4="$DERIVED_ID"
  api -X POST "$BASE/api/session/$NEW4/prompt" -d '{"text":"这个会话之前提到的项目代号是什么？只回答代号"}' >/dev/null
  sleep 24
  R4=$(api "$BASE/api/session/$NEW4/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
res=''
for m in reversed(d):
    if m.get('type')=='assistant' and m.get('finish')=='stop':
        t=' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text').strip()
        if t: res=t; break
print(res)" 2>/dev/null)
  printf '%s' "$R4" | grep -qiE "凤凰|phoenix" && pass "T43.4.1（摘要作为上下文生效）" "reply=${R4:0:30}" || fail "T43.4.1" "reply=${R4:0:60}"
else
  NEW4="$DERIVED_ID"
  fail "T43.4.1" "摘要未生成或不含要点"
fi

echo ""
echo "===== T43.5.1 compaction 锚点源 ====="
skip "T43.5.1" "v2 无手动 compact/summarize 端点（锚点路径待 compact API 迁移后补测）"

echo ""
echo "===== T43.6.1/6.2/6.3 兜底 ====="
EMPTY=$(new_session)
C61=$(code -X POST "$BASE/api/session" -d "{\"summaryFrom\":\"$EMPTY\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}")
N61=$(python3 -c "import json;print(json.load(open('/tmp/sum-body.json')).get('data',{}).get('id','') or '')" 2>/dev/null)
sleep 8
M61=$(api "$BASE/api/session/$N61/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
[ "$C61" = "200" ] && [ "${M61:-1}" = "0" ] && pass "T43.6.1（空源 → 正常创建无摘要）" || fail "T43.6.1" "http=$C61 msg=$M61"

NEW7=$(derive "ses_nonexistent0000000000000000")
[ -n "$NEW7" ] && pass "T43.6.2（不存在源不阻断创建）" "id=${NEW7:0:16}" || fail "T43.6.2" "id=$NEW7"

C63=$(code -X POST "$BASE/api/session" -d '{"summaryFrom":"invalid-id"}')
[ "$C63" = "400" ] && pass "T43.6.3（非法格式 → 400）" || fail "T43.6.3" "http=$C63"

echo ""
echo "===== T43.7.1 工具调用源 ====="
SRC7=$(new_session)
api -X POST "$BASE/api/session/$SRC7/prompt" -d '{"text":"使用 bash 工具执行 echo hello-phoenix-777 并原样返回输出"}' >/dev/null
wait_source "$SRC7"
if derive_until "$SRC7" "phoenix"; then
  pass "T43.7.1（摘要涵盖工具产出）" "${DERIVED_TEXT:0:40}"
else
  fail "T43.7.1" "text=${DERIVED_TEXT:0:60}"
fi

echo ""
echo "===== T43.8.1 与 appId 组合 ====="
NEW8=$(api -X POST "$BASE/api/session" -d "{\"summaryFrom\":\"$SRC\",\"appId\":\"derive-app\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
A8=$(api "$BASE/api/session/$NEW8" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('appId','MISSING'))" 2>/dev/null)
wait_derived "$NEW8" && [ "$A8" = "derive-app" ] && pass "T43.8.1（appId 组合生效）" "appId=$A8" || fail "T43.8.1" "appId=$A8"

echo ""
echo "===== T43.9.1 并发派生 ====="
( api -X POST "$BASE/api/session" -d "{\"summaryFrom\":\"$SRC\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" > /tmp/d1.json ) &
( api -X POST "$BASE/api/session" -d "{\"summaryFrom\":\"$SRC\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" > /tmp/d2.json ) &
wait
D1=$(python3 -c "import json;print(json.load(open('/tmp/d1.json')).get('data',{}).get('id',''))" 2>/dev/null)
D2=$(python3 -c "import json;print(json.load(open('/tmp/d2.json')).get('data',{}).get('id',''))" 2>/dev/null)
if [ -n "$D1" ] && [ -n "$D2" ] && [ "$D1" != "$D2" ] && wait_derived "$D1" && wait_derived "$D2"; then
  pass "T43.9.1（并发两 ID 各自生成摘要）" "${D1:0:12}/${D2:0:12}"
else
  fail "T43.9.1" "D1=$D1 D2=$D2"
fi

echo ""
echo "===== T43.10.1 摘要期间立即发消息 ====="
NEW10=$(derive "$SRC")
api -X POST "$BASE/api/session/$NEW10/prompt" -d '{"text":"收到请只回复ok"}' >/dev/null
sleep 30
M10=$(api "$BASE/api/session/$NEW10/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null)
R10=$(api "$BASE/api/session/$NEW10/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
res=''
for m in reversed(d):
    if m.get('type')=='assistant' and m.get('finish')=='stop':
        t=' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text').strip()
        if t: res=t; break
print(res)" 2>/dev/null)
if printf '%s' "$R10" | grep -qi "ok" && [ "${M10:-0}" -ge 2 ]; then
  pass "T43.10.1（摘要期间消息排队执行）" "msgs=$M10 reply=${R10:0:20}"
else
  fail "T43.10.1" "msgs=$M10 reply=${R10:0:30}"
fi

echo ""
echo "===== T43.11.1 普通创建回归 ====="
NP=$(new_session)
[ -n "$NP" ] && pass "T43.11.1（普通创建不受影响）" || fail "T43.11.1"

echo ""
echo "===== 清理 ====="
for s in "$SRC" "$NEW" "$NEW2" "$NEW3" "$NEW4" "$EMPTY" "$N61" "$NEW7" "$SRC7" "$DERIVED_ID" "$NEW8" "$D1" "$D2" "$NEW10" "$NP"; do api -X DELETE "$BASE/api/session/$s" >/dev/null 2>&1; done
echo "===== 结果: PASS=$PASS FAIL=$FAIL SKIP=$SKIP ====="
[ "$FAIL" = "0" ]
