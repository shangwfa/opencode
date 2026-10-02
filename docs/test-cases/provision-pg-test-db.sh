#!/bin/bash
# 为核心 PostgreSQL 测试准备「专用测试库」。
#
# 为什么必须用专用库：
#   恢复 / claim 类测试（session-execution.test.ts）会驱动**全局**重启扫描
#   （SessionStore.listSuspended、SessionRestart.resumeSuspendedSessions），
#   它作用于整个数据库，不是某个 Session。若把 OPENCODE_DATABASE_URL 指向共享
#   开发库 opencode-v2-up：
#     - 扫描会捞到真实会话，"只列出 claimed 顶层 Session" 之类的断言必然失败；
#     - 更糟的是会对真实挂起会话发起恢复（产生 synthetic 消息写入）。
#   实测：共享库上该文件 31 pass / 4 fail；专用空库上连续两次 35 pass / 0 fail。
#
# schema 不需要手动导入：Database layer 构建时会自动跑 COMPAT_DDL + 迁移。
#
# 用法:
#   bash provision-pg-test-db.sh [库名]        # 默认 opencode-v2-test
# 之后:
#   cd packages/core
#   OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:5432/opencode-v2-test' \
#     bun test --timeout 60000 test/session-execution.test.ts
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-local}"
DB="${1:-opencode-v2-test}"

psql_admin() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d postgres "$@"; }

if [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'")" = "1" ]; then
  echo "✅ 专用测试库已存在: $DB"
else
  psql_admin -c "CREATE DATABASE \"$DB\"" >/dev/null
  echo "✅ 已创建专用测试库: $DB"
fi

echo
echo "OPENCODE_DATABASE_URL='postgresql://$PGUSER@$PGHOST:$PGPORT/$DB'"
echo
echo "提示: 共享开发库 opencode-v2-up 不要用于恢复类测试。"
