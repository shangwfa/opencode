#!/bin/bash
# 启动 V2 服务容器并跑 /api 冒烟。
#
# 前置：本地已构建镜像（docker build -t opencode-saas-v2:test -f Dockerfile .）
# 用法：
#   PG_URL="postgresql://local@host.docker.internal:15432/opencode_v2" bash v2-api-container.sh
#
# 说明：容器内通过 host.docker.internal 访问宿主机 PG（macOS/Windows Docker Desktop 可用；
# Linux 可换 --add-host=host.docker.internal:host-gateway 或使用远端 PG 地址）。
set -u

PORT="${PORT:-14097}"
IMAGE="${IMAGE:-opencode-saas-v2:test}"
PASSWORD="${PASSWORD:-v2-test-pass}"
PG_URL="${PG_URL:-postgresql://local@host.docker.internal:15432/opencode_v2}"
NAME="${NAME:-opencode-v2-test}"

echo "== 启动容器 $NAME (image=$IMAGE port=$PORT) =="
docker rm -f "$NAME" >/dev/null 2>&1
# 开发态挂载：容器直接用工作区源码，改动即生效（避免重建镜像）。
# 注意必须覆盖所有被改动的包；漏挂某个包会静默使用镜像内的旧代码。
REPO="${REPO:-/Users/ruomu/code/opencode}"
docker run -d --name "$NAME" -p "$PORT:4096" \
  -e OPENCODE_PASSWORD="$PASSWORD" \
  -e OPENCODE_DATABASE_URL="$PG_URL" \
  -v "$REPO/packages/schema/src:/app/packages/schema/src" \
  -v "$REPO/packages/core/src:/app/packages/core/src" \
  -v "$REPO/packages/core/migration-pg:/app/packages/core/migration-pg" \
  -v "$REPO/packages/server/src:/app/packages/server/src" \
  -v "$REPO/packages/protocol/src:/app/packages/protocol/src" \
  -v "$REPO/packages/sandbox/src:/app/packages/sandbox/src" \
  -v "$REPO/packages/cli/src:/app/packages/cli/src" \
  "$IMAGE" >/dev/null || { echo "容器启动失败"; exit 1; }

echo "== 等待就绪（/api/info）=="
ready=0
for _ in $(seq 1 45); do
  if curl -s -m 2 -u "opencode:$PASSWORD" "http://localhost:$PORT/api/info" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done

echo "== 容器日志（尾部）=="
docker logs --tail 30 "$NAME" 2>&1

if [ "$ready" != "1" ]; then
  echo "❌ 服务未在 90s 内就绪"
  exit 1
fi

echo ""
BASE="http://localhost:$PORT" PASSWORD="$PASSWORD" bash "$(dirname "$0")/v2-api-smoke.sh"
