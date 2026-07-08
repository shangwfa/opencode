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
