#!/bin/bash
# SaaS 测试通用函数库
# 用法: source test-env.sh [1|2|3] && source test-lib.sh
# 依赖: test-env.sh 提供的 $BASE $PG_URL $MODEL $NO_PROXY

# —— 结果统计 ——
PASS=0; FAIL=0
pass(){ echo "✅ $1 PASS"; PASS=$((PASS+1)); }
fail(){ echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }
# 用例全部跑完后调用，返回码 0=全过 1=有失败（可用于脚本退出码）
summary(){ echo ""; echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="; [ "$FAIL" = "0" ]; }

# —— JSON 解析（strict=False）——
# 所有 AI/exec 响应统一入口：/provider、/session/:id/message、/exec 的 stdout
# 可能含未转义控制字符，python 默认 strict 会报 Invalid control character。
# 用法: cmd | jexec "表达式(d)"   （d 是解析后的对象）
jexec() { python3 -c "import json,sys; d=json.load(sys.stdin, strict=False); print($1)" 2>/dev/null; }

# —— session 管理 ——
# 用法: new_sid        创建 session
#      new_sid -k      创建 + keepAlive（防沙箱 idle 回收）
#      new_sid -kb     创建 + keepAlive + 立即启动沙箱
new_sid() {
  local sid
  sid=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
  case "${1:-}" in
    -k)  curl -s -X POST "$BASE/session/$sid/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null ;;
    -kb) curl -s -X POST "$BASE/session/$sid/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' >/dev/null ;;
  esac
  echo "$sid"
}

# —— PG 查询（取单个值，无表头）——
# 用法: pgval "SELECT column FROM table WHERE ..."
pgval() { psql "$PG_URL" -t -A -c "$1" 2>/dev/null; }

# —— 流式发消息（prompt_stream SSE 实时渲染为可读流水）——
# 用法: stream_prompt SID "消息文本" [超时秒，默认600]
# 实时输出：AI 文本增量、[tool] 工具→状态流转（pending/running/completed/error）、
#           bash 命令首行与执行输出、[error] 事件；流在会话 idle 时关闭
# 需要 AI 执行结果做断言时，仍应在结束后用 /session/:id/message 拉取终态
stream_prompt() {
  local sid="$1" msg="$2" timeout="${3:-600}"
  local payload
  payload=$(MSG="$msg" MODEL="$MODEL" python3 -c 'import json,os; print(json.dumps({"parts":[{"type":"text","text":os.environ["MSG"]}], "model": json.loads(os.environ["MODEL"])}))')
  curl -s -N --noproxy '*' --max-time "$timeout" -X POST "$BASE/session/$sid/prompt_stream" \
    -H 'Content-Type: application/json' -d "$payload" | python3 -c '
import sys, json
buf = []
def flush():
    if buf:
        t = "".join(buf)
        buf.clear()
        print(("..." + t[-600:]) if len(t) > 600 else t, end="", flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("data:"): continue
    p = line[5:].strip()
    if p == "[DONE]": break
    try: ev = json.loads(p)
    except: continue
    t = ev.get("type", "")
    props = ev.get("properties") or {}
    if t == "message.part.delta":
        # field=text 是 AI 正文增量；field=raw 是 tool 参数碎片（后续 updated 事件有完整 input，丢弃）
        if props.get("field") == "text" and props.get("delta"):
            buf.append(props["delta"])
            if sum(len(x) for x in buf) > 200: flush()
        continue
    flush()
    if t == "message.part.updated":
        part = props.get("part") or {}
        if part.get("type") != "tool": continue
        state = part.get("state") or {}
        st = state.get("status")
        if not st: continue
        print("\n[tool] %s -> %s" % (part.get("tool"), st), flush=True)
        inp = state.get("input") or {}
        first = inp.get("command") or inp.get("filePath") or inp.get("pattern")
        if first: print("   %s" % str(first).split(chr(10))[0][:120], flush=True)
        if st == "completed" and part.get("tool") == "bash" and state.get("output"):
            print("   out: %s" % str(state["output"])[:250].replace(chr(10), " | "), flush=True)
        continue
    if "error" in t.lower():
        print("\n[error] %s" % str(ev)[:300], flush=True)
flush(); print()
'
}
