#!/bin/bash
# V2 REST API 冒烟测试（/api/* 前缀，v2 server）
#
# 用法:
#   BASE=http://localhost:14097 PASSWORD=<open-code-password> bash v2-api-smoke.sh
#
# 覆盖只读接口；创建会话/prompt 等写操作在 T07+ 展开（需要 PG 与 provider 配置就绪）。
set -u

BASE="${BASE:-http://localhost:14097}"
PASSWORD="${PASSWORD:-}"
USERNAME="${USERNAME:-opencode}"
# v2 的 Location 约定：请求需带工作目录标识（容器内为 /workspace）
DIRECTORY="${DIRECTORY:-/workspace}"

PASS=0
FAIL=0
pass() { echo "✅ $1 PASS"; PASS=$((PASS + 1)); }
fail() { echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL + 1)); }

# check <name> <path> <期望出现的字符串>
check() {
  local name="$1" path="$2" expect="$3"
  local body
  body="$(curl -s -m 15 -u "$USERNAME:$PASSWORD" -H "x-opencode-directory: $DIRECTORY" "$BASE$path")"
  if [ -z "$body" ]; then
    fail "$name" "空响应 ($path)"
    return
  fi
  if [ -n "$expect" ] && ! printf '%s' "$body" | grep -q "$expect"; then
    fail "$name" "响应缺少 '$expect' ($path): $(printf '%s' "$body" | head -c 200)"
    return
  fi
  pass "$name"
}

echo "== V2 API 冒烟: $BASE =="

# T01 服务信息（readiness/identity）
check "T01 /api/info" "/api/info" "\"version\""

# T02 未认证被拒（设置了密码时）
if [ -n "$PASSWORD" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$BASE/api/info")"
  [ "$code" = "401" ] && pass "T02 无凭证 401" || fail "T02 无凭证 401" "got HTTP $code"
fi

# T03-T08 只读资源
check "T03 /api/config" "/api/config" ""
check "T04 /api/agent" "/api/agent" ""
check "T05 /api/command" "/api/command" ""
check "T06 /api/session" "/api/session" ""
check "T07 /api/integration" "/api/integration" ""
check "T08 /api/form" "/api/form" ""

echo ""
echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
[ "$FAIL" = "0" ]
