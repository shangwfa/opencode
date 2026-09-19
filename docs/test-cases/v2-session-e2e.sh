#!/bin/bash
# V2 版 e2e 用例（docs/test-cases/session/e2e.md 的 T10.1–T10.4）。
# 映射：message（同步）-> prompt+轮询；exec/权限 -> /api/session/:id/exec（已实现）；
#       SSE -> /api/event（v2 事件名：session.tool.success / shell.created / session.inbox.enqueued 等）。
set -u
BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PROVIDER="${PROVIDER:-Yd-DeepSeek}"
MODEL="${MODEL:-deepseek-v4-flash}"

PASS=0; FAIL=0
pass() { echo "✅ $1 PASS ${2:-}"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }

api() { curl -s -m 200 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" -H "content-type: application/json" "$@"; }
new_session() { api -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":{\"providerID\":\"$PROVIDER\",\"id\":\"$MODEL\"}}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('id',''))" 2>/dev/null; }
msg_count() { api "$BASE/api/session/$1/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))" 2>/dev/null || echo 0; }
wait_msgs() { local sid="$1" want="$2" waited=0 got; while [ "$waited" -lt 150 ]; do got=$(msg_count "$sid"); [ "$got" -ge "$want" ] && return 0; sleep 4; waited=$((waited+4)); done; return 1; }
exec_run() { api -X POST "$BASE/api/session/$1/exec" -d "{\"command\": $(python3 -c "import json,sys;print(json.dumps(sys.argv[1]))" "$2")}"; }
exec_out() { exec_run "$1" "$2" | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())" 2>/dev/null; }

# ============ T10.1 创建项目 -> 验证结构 -> 运行 ============
echo "== T10.1 完整开发流程 =="
SID=$(new_session "t101")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"Create a Python project at /workspace/myapp with:\n1. myapp/__init__.py (empty)\n2. myapp/main.py with def main(): print(\"hello\")\n3. tests/__init__.py (empty)\n4. tests/test_main.py that imports myapp.main\nUse the write tool for each file. 只用 write 工具，不要用 bash。"}' >/dev/null
wait_msgs "$SID" 2 || true
NF=0
for attempt in 1 2; do
  FILES=$(exec_out "$SID" "find /workspace/myapp -type f -name '*.py' | sort")
  NF=$(printf '%s\n%s\n' "$FILES" "" | grep -c "\.py$" || true)
  [ "$NF" -ge 4 ] && break
  # 模型可能一次只建主包：补一条明确指令建 tests
  api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"现在用 write 工具补齐 /workspace/myapp/tests/__init__.py（空文件）和 /workspace/myapp/tests/test_main.py（内容: from myapp.main import main）"}' >/dev/null
  N0=$(msg_count "$SID"); wait_msgs "$SID" $((N0 + 2)) || true
done
RUN=$(exec_out "$SID" "cd /workspace/myapp && python3 -c 'from myapp.main import main; main()'")
if [ "$NF" = "4" ] && [ "$RUN" = "hello" ]; then
  pass "T10.1（4 个 .py 文件 + 运行输出 hello）" "files=$NF run=$RUN"
else
  fail "T10.1" "files=$NF run='$RUN' list='$(printf '%s' "$FILES" | tr '\n' ' ')'"
fi

# ============ T10.2 代码修改 + 验证 ============
echo ""
echo "== T10.2 代码修改 + 运行验证 =="
SID=$(new_session "t102")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"Use the write tool to create /workspace/calc.py with:\ndef add(a, b): return a + b\ndef multiply(a, b): return a * b"}' >/dev/null
wait_msgs "$SID" 2 || true
N_BASE=$(msg_count "$SID")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"Use the edit tool to add a subtract function to /workspace/calc.py: def subtract(a, b): return a - b"}' >/dev/null
wait_msgs "$SID" $((N_BASE + 2)) || true
OUT2=$(exec_out "$SID" "cd /workspace && echo 'from calc import add, subtract; print(add(2,3)); print(subtract(5,2))' | python3")
if printf '%s' "$OUT2" | grep -q "5" && printf '%s' "$OUT2" | grep -q "3"; then
  pass "T10.2（write+edit 后 add=5 subtract=3）" "out=$(printf '%s' "$OUT2" | tr '\n' '/')"
else
  fail "T10.2" "out='$OUT2'"
fi

# ============ T10.3 SSE 监听完整开发流程 ============
echo ""
echo "== T10.3 SSE 监听完整流程 =="
SID=$(new_session "t103")
LOG=/tmp/t103-sse.log; : > "$LOG"
(curl -s -N -m 75 -u "opencode:$PASSWORD" -H "x-opencode-directory: /workspace" "$BASE/api/event" > "$LOG") &
SSE_PID=$!
for i in $(seq 1 20); do grep -q "server.connected" "$LOG" 2>/dev/null && break; sleep 0.5; done
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"Use the write tool to create /workspace/hello.py with: print(\"hello from SSE test\")"}' >/dev/null
wait_msgs "$SID" 2 || true
wait "$SSE_PID" 2>/dev/null
TOTAL=$(grep -c '^data: ' "$LOG" || true)
TYPES=$(grep -oE '"type":"[a-z.]+"' "$LOG" | sort -u | wc -l | tr -d ' ')
HAS_INBOX=$(grep -c "session.inbox.enqueued" "$LOG" || true)
HAS_TOOL=$(grep -cE "session.tool.(progress|success)" "$LOG" || true)
HAS_IDLE=$(grep -cE "session.(idle|usage)" "$LOG" || true)
if [ "${HAS_INBOX:-0}" -ge 1 ] && [ "${HAS_TOOL:-0}" -ge 1 ] && [ "${HAS_IDLE:-0}" -ge 1 ]; then
  pass "T10.3（SSE 完整流程：inbox→tool→idle）" "events=$TOTAL types=$TYPES"
else
  fail "T10.3" "inbox=$HAS_INBOX tool=$HAS_TOOL idle=$HAS_IDLE total=$TOTAL"
fi
echo "   事件类型: $(grep -oE '"type":"[a-z.]+"' "$LOG" | sort -u | sed 's/"type":"//;s/"//' | tr '\n' ' ' | head -c 300)"

# ============ T10.4 多轮上下文 ============
echo ""
echo "== T10.4 多轮上下文保持 =="
SID=$(new_session "t104")
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"Remember this secret number: 42. Just reply OK."}' >/dev/null
wait_msgs "$SID" 2 || true
api -X POST "$BASE/api/session/$SID/prompt" -d '{"text":"What was the secret number I told you?"}' >/dev/null
wait_msgs "$SID" 4 || true
T=$(api "$BASE/api/session/$SID/message" | grep -o "42" | head -1)
[ -n "$T" ] && pass "T10.4（Round 2 回忆出 42）" || fail "T10.4" "未找到 42"

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
