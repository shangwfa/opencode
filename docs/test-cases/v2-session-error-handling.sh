#!/bin/bash
# V2 版 error-handling 用例（docs/test-cases/session/error-handling.md 的 T7.1–T7.8）。
# 断言映射：v2 用 HttpApi 错误体系（精确 4xx），v1 的 "500 UnknownError" 在 v2 应为更精确的错误码。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"

PASS=0; FAIL=0; NA=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
na() { echo "➖ $1 N/A: ${2:-}"; NA=$((NA+1)); }

api() { curl -s -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
code_of() { curl -s -o /tmp/t7-body.json -w "%{http_code}" -m 60 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"t7\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }

SID=$(new_session "t7-base")
echo "SID: $SID"

echo ""
echo "== T7.1 未配置的 provider =="
# v2 语义：create 懒验证（200 存下坏模型），执行时失败并持久化错误状态（不卡死）。
BAD=$(api -X POST "$BASE/api/session" -d '{"model":{"providerID":"not-exist","id":"fake"}}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
if [ -z "$BAD" ]; then
  fail "T7.1" "坏模型创建会话失败"
else
  api -X POST "$BASE/api/session/$BAD/prompt" -d '{"text":"hi"}' >/dev/null
  W=0; RESULT=""
  while [ "$W" -lt 45 ]; do
    RESULT=$(api "$BASE/api/session/$BAD/message" | python3 -c "
import json,sys
d=json.load(sys.stdin).get('data',[])
idle=next((m for m in d if m.get('type')=='idle'), None)
err=any(m.get('type')=='assistant' and m.get('error') for m in d)
print('failed' if (idle and idle.get('outcome')=='failed') or err else '')" 2>/dev/null)
    [ -n "$RESULT" ] && break
    sleep 3; W=$((W+3))
  done
  if [ "$RESULT" = "failed" ]; then
    pass "T7.1（坏 provider：执行失败状态落库，不卡死）"
  else
    fail "T7.1" "45s 内未见失败状态 result='$RESULT'"
  fi
fi

echo ""
echo "== T7.2 不存在的 session 发消息 =="
C=$(code_of -X POST "$BASE/api/session/ses_NOTEXIST123/prompt" -d '{"text":"hi"}')
[ "$C" = "404" ] && pass "T7.2（404）" || fail "T7.2" "status=$C body=$(head -c 100 /tmp/t7-body.json)"

echo ""
echo "== T7.3 无效 JSON =="
C=$(code_of -X POST "$BASE/api/session" -d 'not-json')
[ "$C" = "400" ] || [ "$C" = "422" ]; RC=$?
if [ "$RC" = "0" ]; then pass "T7.3（${C}）"; else fail "T7.3" "status=$C body=$(head -c 100 /tmp/t7-body.json)"; fi

echo ""
echo "== T7.4 缺失必填字段（prompt 无 text）=="
C=$(code_of -X POST "$BASE/api/session/$SID/prompt" -d '{}')
[ "$C" = "400" ] || [ "$C" = "422" ]; RC=$?
if [ "$RC" = "0" ]; then pass "T7.4（$C schema 校验）"; else fail "T7.4" "status=$C body=$(head -c 120 /tmp/t7-body.json)"; fi

echo ""
echo "== T7.5 超长消息 =="
BIG=$(python3 -c "print('x'*100000)")
C=$(code_of -X POST "$BASE/api/session/$SID/prompt" -d "{\"text\":\"$BIG\"}")
if [ "$C" != "000" ] && [ "$C" != "" ]; then
  pass "T7.5（10 万字符不 hang，返回 ${C}）"
else
  fail "T7.5" "status=${C}（疑似挂起）"
fi

echo ""
echo "== T7.6 unknown finish 不截断（等价验证）=="
# v1 验证特定模型的 finish_reason 处理；v2 用正常模型跑一轮确认 finish 语义正常（stop/tool-calls）
SID6=$(new_session "t76")
api -X POST "$BASE/api/session/$SID6/prompt" -d '{"text":"回复OK即可"}' >/dev/null
W=0; while [ "$W" -lt 60 ]; do N=$(api "$BASE/api/session/$SID6/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null||echo 0); [ "$N" -ge 2 ] && break; sleep 3; W=$((W+3)); done
FIN=$(api "$BASE/api/session/$SID6/message" | python3 -c "
import json,sys
for m in json.load(sys.stdin).get('data',[]):
    if m.get('type')=='assistant': print(m.get('finish') or 'none'); break" 2>/dev/null)
if [ "$FIN" = "stop" ] || [ "$FIN" = "tool-calls" ]; then
  pass "T7.6（assistant finish=${FIN}，正常终态）"
else
  fail "T7.6" "finish=$FIN"
fi

echo ""
echo "== T7.7/T7.8 network_error 重试链路 =="
na "T7.7" "v1 单测（ai-sdk network_error 映射）；v2 的等价物是 SessionRunnerRetry.isRetryable（未识别错误默认可重试，含网络类），无同名单测"
na "T7.8" "v1 RETRYABLE_MESSAGE_PATTERNS 单测；v2 retry 体系不同（AIError 分类），v1 单测保留在 packages/v1"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL N/A=$NA ====="
[ "$FAIL" = "0" ]
