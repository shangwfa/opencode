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

# —— V2 HTTP 认证入口 ——
# V2 全部端点在 /api 前缀下，且需要 Basic Auth。
# 用法: api_curl -X POST "$BASE/api/session" -H 'Content-Type: application/json' --data-binary @-
api_curl() {
  test -n "${OPENCODE_PASSWORD:-}" || { echo "OPENCODE_PASSWORD is required" >&2; return 2; }
  curl --fail-with-body -sS --noproxy '*' --user "opencode:$OPENCODE_PASSWORD" "$@"
}

# —— session 管理 (V2) ——
# 用法: new_session [JSON 覆盖字段]   例: new_session '{"title":"java-e2e","sandbox":{"cpu":"2","memory":"4Gi"}}'
# 注意: V2 的 Session.SandboxResource 只有 cpu/memory，没有 image；
#       镜像由实例级 OPENCODE_SANDBOX_IMAGE 决定，传 image 会被**静默丢弃**。
new_session() {
  local body="${1:-{\}}"
  printf '%s' "$body" | api_curl -X POST "$BASE/api/session" \
    -H 'Content-Type: application/json' --data-binary @- | jexec "d['data']['id']"
}

# 确保 Session 使用 $MODEL 指定的模型。
#
# 为什么需要它: prompt 接口不接受 model 参数，不指定就落到服务默认 provider。
# 实测默认 provider 会返回
#   403 "OpenCode's free tier can only be used from within OpenCode"
# 且该错误只出现在 session.step.failed——只等 session.execution.failed 的
# 消费者看不到原因，表面现象是"任务秒退且无任何输出"。
#
# 已有 POST /api/session/:id/model（session.switchModel）可事后切换，实测返回 204
# 且立即生效，所以不需要为了换模型而重建会话。
# 用法: ensure_model SID
ensure_model() {
  local sid="$1"
  local current
  current=$(api_curl "$BASE/api/session/$sid" | jexec "d['data'].get('model',{}).get('providerID','')")
  local want
  want=$(printf '%s' "$MODEL" | jexec "d['providerID']")
  if [ "$current" = "$want" ]; then
    return 0
  fi
  jq -nc --argjson m "$V2_MODEL" '{model:$m}' \
    | api_curl -X POST "$BASE/api/session/$sid/model" \
        -H 'Content-Type: application/json' --data-binary @- >/dev/null
  echo "model switched: $current -> $want" >&2
}

# 创建会话并确保模型正确，一步到位。
# 用法: new_session_with_model [JSON 覆盖字段]
new_session_with_model() {
  local sid
  sid=$(new_session "${1:-{\}}")
  ensure_model "$sid"
  echo "$sid"
}

# V1 兼容入口，已被 V2 取代。保留仅为让旧文档的调用点显式失败，而不是静默走错协议。
new_sid() {
  echo "new_sid is V1; use new_session (POST $BASE/api/session)" >&2
  return 1
}

# —— 消息水位（V2 存储模型）——
# 本地 PG 中 session_message.data 是 text，查询前必须 ::jsonb。
message_watermark() {
  pgval "SELECT coalesce(max(seq), 0) FROM session_message WHERE session_id='$1'"
}

# —— Session shell (V2) ——
# V1 的 POST /session/:id/exec 同步返回 stdout 已不存在。
# V2 语义: POST /api/session/:id/shell 返回 204，命令作为 type='shell' 的
# Session Message 异步落库，终态从 PG 读回。
#
# 实测的 shell 消息结构（勿凭直觉猜字段路径）:
#   data.exit                 -> number   退出码，顶层
#   data.status               -> "exited" 才代表终态，running 不可当作结果
#   data.output.output        -> string   合并后的 stdout/stderr
#   data.output.size/cursor   -> number   分页游标，cursor < size 表示还有剩余
#   data.metadata.background  -> bool
#   data.shellID              -> string
#
# 用法: run_shell SID "命令" [超时秒，默认300]   输出 stdout/stderr 与 "--- exit=N"
run_shell() {
  local sid="$1" cmd="$2" timeout="${3:-300}"
  local before
  before=$(message_watermark "$sid")
  jq -nc --arg command "$cmd" '{command:$command}' \
    | api_curl -X POST "$BASE/api/session/$sid/shell" \
        -H 'Content-Type: application/json' --data-binary @- >/dev/null
  for _ in $(seq 1 $((timeout / 2))); do
    # 只有 status=exited 才是终态；running 不可当作结果。
    if [ "$(pgval "SELECT count(*) FROM session_message
      WHERE session_id='$sid' AND type='shell' AND seq > $before
        AND data::jsonb->>'status' = 'exited'")" -gt 0 ]; then
      # 一次取出整段输出。注意：PG 里的 shell 消息是**最终快照**，output.output
      # 已是完整内容、output.cursor == output.size。真正的大输出分页要用
      # GET /api/shell/:id/output?cursor=N，不能对同一行反复查 PG——
      # 那只会重复读到同一个快照，永远推进不了游标。
      local out
      out=$(pgval "SELECT data::jsonb->'output'->>'output' FROM session_message
        WHERE session_id='$sid' AND type='shell' AND seq > $before
          AND data::jsonb->>'status' = 'exited' ORDER BY seq DESC LIMIT 1")
      printf '%s\n' "$out"
      echo "--- exit=$(pgval "SELECT coalesce((data::jsonb->>'exit')::text,'?') FROM session_message
        WHERE session_id='$sid' AND type='shell' AND seq > $before
          AND data::jsonb->>'status' = 'exited' ORDER BY seq DESC LIMIT 1")"
      return 0
    fi
    sleep 2
  done
  echo "shell did not reach exited state before deadline" >&2
  return 1
}

# 用法: run_shell_status SID "命令" [超时秒]   只回显退出码
run_shell_status() {
  local sid="$1" cmd="$2" timeout="${3:-300}"
  local before
  before=$(message_watermark "$sid")
  jq -nc --arg command "$cmd" '{command:$command}' \
    | api_curl -X POST "$BASE/api/session/$sid/shell" \
        -H 'Content-Type: application/json' --data-binary @- >/dev/null
  for _ in $(seq 1 $((timeout / 2))); do
    if [ "$(pgval "SELECT count(*) FROM session_message
      WHERE session_id='$sid' AND type='shell' AND seq > $before
        AND data::jsonb->>'status' = 'exited'")" -gt 0 ]; then
      pgval "SELECT coalesce((data::jsonb->>'exit')::text,'?') FROM session_message
        WHERE session_id='$sid' AND type='shell' AND seq > $before
          AND data::jsonb->>'status' = 'exited' ORDER BY seq DESC LIMIT 1"
      return 0
    fi
    sleep 2
  done
  echo "shell did not reach exited state before deadline" >&2
  return 1
}

# —— PG 查询（取单个值，无表头）——
# 用法: pgval "SELECT column FROM table WHERE ..."
pgval() { psql "$PG_URL" -t -A -c "$1" 2>/dev/null; }

# —— 流式发消息 (V2 prompt_stream) ——
# 用法: stream_prompt SID "消息文本" [超时秒，默认600]
#
# ⚠️ V2 事件契约与 V1 完全不同，这里按 packages/schema/src/session-event.ts 重写。
#    踩过的坑（勿改回旧写法）:
#   - 帧结构是 {"id":...,"type":...,"data":{...}}，不是 V1 的 {type, properties}。
#   - AI 正文走 **session.text.delta**（data.delta / data.ordinal），**不是**
#     session.message.content.updated。V2 没有 message.part.delta。
#     content.updated 是 durable 的整段快照，实时渲染必须用 delta 事件，
#     否则要么没输出、要么整段重复刷屏。
#   - 工具事件是 session.tool.called / .success / .failed，**不含工具名字段**，
#     名字在 Session Message 的 content part 上。要按名字断言请查 PG。
#   - 终态是 session.execution.succeeded / .failed / .interrupted；
#     模型侧失败是 session.step.failed（含 provider 错误详情）。
stream_prompt() {
  local sid="$1" msg="$2" timeout="${3:-600}"
  local payload
  payload=$(python3 -c 'import json,sys; print(json.dumps({"text":sys.argv[1]}))' "$msg")
  curl -s -N --noproxy '*' --max-time "$timeout" -X POST "$BASE/api/session/$sid/prompt_stream" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64)" \
    -d "$payload" | python3 -c '
import sys, json
tools = {}   # tool id -> terminal state we already reported
def out(s):
    sys.stdout.write(s)
    sys.stdout.flush()

for raw in sys.stdin:
    raw = raw.strip()
    if not raw.startswith("data:"):
        continue
    body = raw[5:].strip()
    if body == "[DONE]":
        break
    try:
        ev = json.loads(body)
    except Exception:
        continue
    t = ev.get("type", "")
    d = ev.get("data") or {}

    # AI 正文增量
    if t == "session.text.delta":
        out(d.get("delta", ""))
        continue

    # 工具生命周期。事件里没有工具名，只打印 id 片段与可读输入。
    if t == "session.tool.called":
        tid = d.get("id", "?")
        inp = d.get("input") or {}
        hint = inp.get("command") or inp.get("filePath") or inp.get("pattern") or inp.get("path") or ""
        out("\n[tool] call %s%s\n" % (tid, ("  " + str(hint).split(chr(10))[0][:120]) if hint else ""))
        continue
    if t in ("session.tool.success", "session.tool.failed"):
        tid = d.get("id", "?")
        if tools.get(tid) == t:
            continue
        tools[tid] = t
        state = "completed" if t.endswith("success") else "error"
        out("[tool] %s -> %s\n" % (tid, state))
        if state == "error":
            err = d.get("error") or {}
            out("   %s: %s\n" % (err.get("type", "?"), str(err.get("message", ""))[:250]))
        continue

    # 模型侧失败：provider 错误详情在这里，只看 execution.failed 会看不到原因
    if t == "session.step.failed":
        err = d.get("error") or {}
        out("\n[step failed] %s: %s\n" % (err.get("type", "?"), str(err.get("message", ""))[:300]))
        continue

    if t in ("session.execution.succeeded", "session.execution.failed",
             "session.execution.interrupted", "session.compaction.failed"):
        out("\n[%s]\n" % t.replace("session.", ""))
        continue
print()
'
}
