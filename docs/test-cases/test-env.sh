#!/bin/bash
# SaaS 测试环境变量配置 —— 按组合切换 PG 连接
# 用法: source test-env.sh [1|2|3]   （默认 3 = 本地 PG + 本地 OpenSandbox）
#
# 组合说明（见 ../local-test-env.md）:
#   1 = 远端 PG + 远端 Sandbox（K8s）
#   2 = 远端 PG + 本地 OpenSandbox
#   3 = 本地 PG + 本地 OpenSandbox

COMBO="${1:-3}"

# 三种组合共享
export BASE="http://localhost:14096"
export MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
export NO_PROXY=localhost,127.0.0.1

# PG 连接串按组合不同（PG 用户差异：远端 app / 本地 local）
case "$COMBO" in
  1|2)
    export PG_URL="postgresql://app:8zuhlMLd4gaeUG5k@127.0.0.1:15432/opencode"
    ;;
  3)
    export PG_URL="postgresql://local@127.0.0.1:15432/opencode"
    ;;
  *)
    echo "test-env.sh: 未知组合 '$COMBO'，用法: source test-env.sh [1|2|3]" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

echo "✅ 测试环境已加载（组合 $COMBO）"
echo "   BASE=$BASE"
echo "   PG_URL=$PG_URL"
