#!/bin/bash
# V2 版 ai-conversation 用例（对应 docs/test-cases/session/ai-conversation.md 的 T4.1–T4.7）。
#
# 与 v1 用例的接口差异：
#   - v1: POST /session/:id/message 同步等结果；prompt_async；POST /session/:id/abort
#   - v2: POST /api/session/:id/prompt 为异步 admission（不等结果），中断用 /interrupt，
#         因此每个用例改为「prompt -> 轮询消息列表等待 assistant finish 落定 -> 断言」。
#
# 用法：BASE=http://localhost:14097 PASSWORD=v2-test-pass bash v2-session-ai-conversation.sh
# 前置：容器已启动（PG 模式 + Yd-* provider 配置）；工具调用落在容器本地文件系统。
set -u

BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
USERNAME="${USERNAME:-opencode}"
DIRECTORY="${DIRECTORY:-/workspace}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"
CONTAINER="${CONTAINER:-opencode-v2-test}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"

PASS=0
FAIL=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS + 1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL + 1)); }

api() { curl -s -m 30 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" -H "content-type: application/json" "$@"; }
messages() { api "$BASE/api/session/$1/message"; }

# 等待出现「finish 落定」的最新 assistant 消息；$2 为 baseline 消息数（忽略此前历史）。
# 输出该消息 JSON 到 stdout；失败输出空串。
wait_assistant() {
  local sid="$1" baseline="$2" waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    local json
    json=$(messages "$sid")
    local done_msg
    done_msg=$(printf '%s' "$json" | python3 -c "
import json,sys
try: data = json.load(sys.stdin).get('data', [])
except Exception: data = []
data = data[:max(0, len(data) - $baseline)] if $baseline > 0 else data
assistant = [m for m in data if m.get('type') == 'assistant']
settled = next((m for m in assistant if m.get('finish')), None)
print(json.dumps(settled) if settled else '')
")
    if [ -n "$done_msg" ]; then printf '%s' "$done_msg"; return 0; fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

count_messages() {
  messages "$1" | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('data', [])))" 2>/dev/null || echo 0
}

new_session() {
  api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" |
    python3 -c "import json,sys; print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null
}

assistant_text() { python3 -c "
import json,sys
m = json.loads(sys.argv[1])
print(' '.join(p.get('text','') for p in (m.get('content') or []) if p.get('type')=='text'))
" "$1" 2>/dev/null; }

tool_list() { python3 -c "
import json,sys
m = json.loads(sys.argv[1])
out = []
for p in (m.get('content') or []):
    if p.get('type') == 'tool':
        # v2 的 tool part：工具名在 name 字段（tool 字段不存在）
        out.append(f\"{p.get('name') or p.get('tool')}({(p.get('state') or {}).get('status','?')})\")
print(' '.join(out))
" "$1" 2>/dev/null; }

SID=$(new_session "v2 ai-conversation")
if [ -z "$SID" ]; then echo "会话创建失败"; exit 1; fi
echo "== session: $SID =="

echo ""
echo "== T4.1 简单文本对话 =="
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"1+1等于几"}' >/dev/null
M=$(wait_assistant "$SID" 0) && TXT=$(assistant_text "$M")
if printf '%s' "$TXT" | grep -q "2"; then pass "T4.1" "回复: $(printf '%s' "$TXT" | head -c 60)"; else fail "T4.1" "text='$TXT'"; fi

echo ""
echo "== T4.2 多轮上下文记忆 =="
BASE_N=$(count_messages "$SID")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"记住我叫张三"}' >/dev/null
wait_assistant "$SID" "$BASE_N" >/dev/null
BASE_N=$(count_messages "$SID")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"我叫什么？"}' >/dev/null
M=$(wait_assistant "$SID" "$BASE_N") && TXT=$(assistant_text "$M")
if printf '%s' "$TXT" | grep -q "张三"; then pass "T4.2" "回复: $(printf '%s' "$TXT" | head -c 60)"; else fail "T4.2" "text='$TXT'"; fi

echo ""
echo "== T4.3 写文件工具 =="
BASE_N=$(count_messages "$SID")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"在 /workspace 创建 t4-3.txt 内容是 hello"}' >/dev/null
# v2 沙箱模式下文件落在沙箱内（容器本地为空是隔离正确的证明）；内容闭环由 T4.4 的 read 验证。
M=$(wait_assistant "$SID" "$BASE_N") || M=""
TOOLS=""
[ -n "$M" ] && TOOLS=$(tool_list "$M")
if [ -n "$M" ] && printf '%s' "$TOOLS" | grep -qE "write\(completed\)|bash\(completed\)"; then
  LOCAL_EMPTY=$(docker exec "$CONTAINER" ls /workspace/ 2>/dev/null | grep -c t4-3 || true)
  if [ "${LOCAL_EMPTY:-0}" = "0" ]; then pass "T4.3" "tools=[$TOOLS]（文件在沙箱内，容器本地为空）"; else fail "T4.3" "文件出现在容器本地（应隔离在沙箱）"; fi
else
  fail "T4.3" "tools=[$TOOLS]"
fi

echo ""
echo "== T4.4 读文件工具 =="
BASE_N=$(count_messages "$SID")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"读 /workspace/t4-3.txt"}' >/dev/null
M=$(wait_assistant "$SID" "$BASE_N") || M=""
TOOLS=""
TXT=""
if [ -n "$M" ]; then TOOLS=$(tool_list "$M"); TXT=$(assistant_text "$M"); fi
READ_OUT=$(messages "$SID" | python3 -c "
import json,sys
try: data = json.load(sys.stdin).get('data', [])
except Exception: data = []
out = []
for m in data:
    for p in (m.get('content') or []):
        if p.get('type') == 'tool' and (p.get('name') or '') == 'read' and (p.get('state') or {}).get('status') == 'completed':
            for c in ((p.get('state') or {}).get('content') or []):
                if isinstance(c, dict): out.append(str(c.get('text', '')))
print(' '.join(out))
" 2>/dev/null)
if [ -n "$M" ] && printf '%s' "$TOOLS" | grep -q "read(completed)" && printf '%s' "$READ_OUT" | grep -q "hello"; then
  pass "T4.4" "read 输出含 hello（内容闭环）"
else
  fail "T4.4" "tools=[$TOOLS] read_out='$(printf '%s' "$READ_OUT" | head -c 60)'"
fi

echo ""
echo "== T4.5 bash 命令执行 =="
BASE_N=$(count_messages "$SID")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"执行 ls /workspace 命令"}' >/dev/null
M=$(wait_assistant "$SID" "$BASE_N") || M=""
TOOLS=""
TXT=""
if [ -n "$M" ]; then TOOLS=$(tool_list "$M"); TXT=$(assistant_text "$M"); fi
if [ -n "$M" ] && printf '%s' "$TXT" | grep -q "t4-3.txt"; then
  pass "T4.5" "tools=[$TOOLS]"
else
  fail "T4.5" "tools=[$TOOLS] text='$(printf '%s' "$TXT" | head -c 80)'"
fi

echo ""
echo "== T4.6 异步消息（v2 prompt 本身为异步 admission）=="
BASE_N=$(count_messages "$SID")
CODE=$(api -o /dev/null -w "%{http_code}" -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"写一首五言绝句"}')
if [ "$CODE" = "200" ]; then
  M=$(wait_assistant "$SID" "$BASE_N") || M=""
  TXT=""
  [ -n "$M" ] && TXT=$(assistant_text "$M")
  if [ -n "$TXT" ]; then pass "T4.6" "HTTP $CODE, 异步落库: $(printf '%s' "$TXT" | head -c 40)"; else fail "T4.6" "admission HTTP $CODE 但未落库"; fi
else
  fail "T4.6" "HTTP $CODE"
fi

echo ""
echo "== T4.7 中断会话 =="
BASE_N=$(count_messages "$SID")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"写一篇1万字的文章"}' >/dev/null
sleep 3
INTERRUPTED=$(api -X POST "$BASE/api/session/$SID/interrupt" | python3 -c "import json,sys; print(json.load(sys.stdin).get('interrupted'))" 2>/dev/null)
P1=$(messages "$SID" | python3 -c "import json,sys; print(len(json.dumps(json.load(sys.stdin))))" 2>/dev/null)
sleep 8
P2=$(messages "$SID" | python3 -c "import json,sys; print(len(json.dumps(json.load(sys.stdin))))" 2>/dev/null)
if [ "$INTERRUPTED" = "True" ] && [ "$P1" = "$P2" ]; then
  pass "T4.7" "interrupted=true, parts 零增长 ($P1 -> $P2)"
else
  fail "T4.7" "interrupted=$INTERRUPTED, size $P1 -> $P2"
fi

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
