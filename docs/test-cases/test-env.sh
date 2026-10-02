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
export MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
export V2_MODEL="$(printf '%s' "$MODEL" | jq -c '{providerID, id:(.id // .model // .modelID), variant} | with_entries(select(.value != null))')"
export KIMI_MODEL='{"providerID":"moonshotai-cn","modelID":"kimi-k3"}'
export NO_PROXY=localhost,127.0.0.1

# 本地 SaaS 容器启用了 HTTP Basic Auth。优先使用调用方显式提供的密码；
# 未提供时从本地测试容器配置读取，避免把密码写进仓库或测试输出。
if [ -z "${OPENCODE_PASSWORD:-}" ] && command -v docker >/dev/null 2>&1; then
  export OPENCODE_PASSWORD="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' opencode-saas-test 2>/dev/null \
    | sed -n 's/^OPENCODE_PASSWORD=//p' | head -n 1)"
fi
if [ -z "${OPENCODE_PASSWORD:-}" ]; then
  echo "⚠️  OPENCODE_PASSWORD 未设置；HTTP API 测试需显式提供服务密码" >&2
fi

# PG 连接串按组合不同（PG 用户差异：远端 app / 本地 local）
case "$COMBO" in
  1|2)
    export PG_URL="postgresql://app:8zuhlMLd4gaeUG5k@127.0.0.1:15432/opencode"
    ;;
  3)
    # 本地 Homebrew PG 直连（容器侧经 host.docker.internal:15432 转发，库名一致：
    # opencode-v2-up，与 AGENTS.md / shell-perf.md 的启动命令保持同步）
    export PG_URL="postgresql://local@127.0.0.1:5432/opencode-v2-up"
    ;;
  *)
    echo "test-env.sh: 未知组合 '$COMBO'，用法: source test-env.sh [1|2|3]" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

echo "✅ 测试环境已加载（组合 $COMBO）"
echo "   BASE=$BASE"
echo "   PG_URL=$PG_URL"

# 开测前检测镜像新鲜度。固定 tag 会静默复用旧镜像，导致「测的是旧代码」而结论看起来正常。
# 这里只提示不阻塞；要硬失败用 check-image-freshness.sh --strict。
_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
if [ "${SKIP_IMAGE_CHECK:-0}" != "1" ] && [ -f "$_ENV_DIR/check-image-freshness.sh" ]; then
  bash "$_ENV_DIR/check-image-freshness.sh" >/dev/null 2>&1 \
    || echo "⚠️  镜像可能已过期，先跑 check-image-freshness.sh 确认再开测" >&2
fi
unset _ENV_DIR
