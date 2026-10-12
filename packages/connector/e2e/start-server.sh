#!/bin/bash
# 会话级 Connector e2e：启动本地 SaaS（要求 bun>=1.4.2，本机 1.3.14 缺 node:sqlite）
# 用法: ./start-server.sh [port]   （默认 14963；4096 常被占用）
# 前置: psql 可达 postgres:postgres@127.0.0.1:5432/opencode-v2-up；connector schema 已迁移
set -euo pipefail
cd "$(dirname "$0")/../../.."   # 仓库根（packages/connector/e2e → 上三级）

PORT="${1:-14963}"
export TMPDIR=/tmp
# bun run dev 会嵌套调用 bun：PATH 必须前置到正确版本
# BUN_E2E 示例: /path/to/bun142/node_modules/.bin
[ -n "${BUN_E2E:-}" ] && export PATH="$BUN_E2E:$PATH"

export OPENCODE_PASSWORD=ab123456
export OPENCODE_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/opencode-v2-up'
export OPENCODE_CONNECTOR_ENABLED=true
export OPENCODE_CONNECTOR_DATA_DIR=/tmp/opencode-connector-e2e-data
export OPENCODE_CONNECTOR_PUBLIC_ORIGIN="http://127.0.0.1:${PORT}/connector"
export OPENCODE_CONNECTOR_ENCRYPTION_KEY=e2e-test-encryption-key-20261010
export OPENCODE_CONNECTOR_ADMIN_TOKEN=e2e-admin-token-20261010
export OPENCODE_CONNECTOR_PG_URL='postgresql://postgres:postgres@127.0.0.1:5432/opencode-v2-up?options=-c%20search_path%3Dconnector'
export OPENCODE_CONNECTOR_MCP_URL="http://127.0.0.1:${PORT}/api/connector/mcp"
export NO_PROXY=localhost,127.0.0.1
mkdir -p /tmp/opencode-connector-e2e-data
exec bun run dev -- serve --hostname 127.0.0.1 --port "$PORT"
