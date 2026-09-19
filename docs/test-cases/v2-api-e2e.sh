#!/bin/bash
# V2 端到端：创建会话 -> prompt -> LLM 回复（Yd-DeepSeek）-> idle 成功
#
# 用法：
#   BASE=http://localhost:14097 PASSWORD=<pw> bash v2-api-e2e.sh
# 前置：容器已按 v2-api-container.sh 启动（PG 模式，opencode.jsonc 提供 Yd-* provider）。
set -u

BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
USERNAME="${USERNAME:-opencode}"
DIRECTORY="${DIRECTORY:-/workspace}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
WAIT_SECONDS="${WAIT_SECONDS:-25}"

PASS=0
FAIL=0
pass() { echo "✅ $1 PASS"; PASS=$((PASS + 1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL + 1)); }

curl_json() { curl -s -m 25 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" -H "content-type: application/json" "$@"; }

echo "== T20 创建会话（模型 ${PROVIDER}/${MODEL}）=="
PAYLOAD=$(python3 -c "import json,sys; print(json.dumps({'title':'v2 e2e','model':{'providerID':sys.argv[1],'id':sys.argv[2]}}))" "$PROVIDER" "$MODEL")
CREATED=$(curl_json -X POST "$BASE/api/session" -d "$PAYLOAD")
SID=$(printf '%s' "$CREATED" | python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null)
if [ -n "$SID" ]; then pass "T20 create session ($SID)"; else fail "T20 create session" "$(printf '%s' "$CREATED" | head -c 200)"; exit 1; fi

echo "== T21 prompt（durable admission）=="
PROMPTED=$(curl_json -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"reply with exactly: ok"}')
if printf '%s' "$PROMPTED" | grep -q '"type":"user"'; then pass "T21 prompt admitted"; else fail "T21 prompt admitted" "$(printf '%s' "$PROMPTED" | head -c 200)"; fi

echo "== T22 等待模型回复（${WAIT_SECONDS}s）=="
sleep "$WAIT_SECONDS"

curl_json "$BASE/api/session/$SID/message" > /tmp/v2-e2e-messages.json
python3 - <<'PY'
import json
data = json.load(open("/tmp/v2-e2e-messages.json")).get("data", [])
assistant = next((m for m in data if m.get("type") == "assistant"), None)
idle = next((m for m in data if m.get("type") == "idle"), None)
if assistant is None:
    print("❌ T22 assistant reply FAIL: no assistant message")
    raise SystemExit(1)
texts = " ".join(
    p.get("text", "") for p in (assistant.get("content") or []) if isinstance(p, dict) and p.get("type") == "text"
)
if assistant.get("finish") != "stop" or assistant.get("error"):
    print(f"❌ T22 assistant reply FAIL: finish={assistant.get('finish')} error={assistant.get('error')}")
    raise SystemExit(1)
print(f"✅ T22 assistant reply PASS: model={assistant.get('model')} text={texts[:80]!r}")
if idle is not None and idle.get("outcome") == "succeeded":
    print("✅ T23 idle succeeded PASS")
else:
    print(f"❌ T23 idle succeeded FAIL: {idle}")
    raise SystemExit(1)
PY
if [ "$?" = "0" ]; then PASS=$((PASS + 2)); else FAIL=$((FAIL + 2)); fi

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
