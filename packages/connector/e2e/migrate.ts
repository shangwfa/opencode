// 引擎 PG 迁移：调本包 migrate.ts 的 runPostgresMigrations（自动 CREATE SCHEMA IF NOT EXISTS）
// 用法（bun>=1.4.2）:
//   bun packages/connector/e2e/migrate.ts \
//     'postgresql://postgres:postgres@127.0.0.1:5432/opencode-v2-up?options=-c%20search_path%3Dconnector'
import { runPostgresMigrations } from "@opencode/connector/adapter/migrate"
import { getConnectorAssetDirectory } from "@opencode/connector/engine/server/connector-assets"

const url = process.argv[2]
if (!url) {
  console.error("usage: bun migrate.ts <connectionString>")
  process.exit(1)
}
const migrationDirectory = getConnectorAssetDirectory() + "/migrations"
console.log("asset dir:", migrationDirectory)
await runPostgresMigrations({ connectionString: url, migrationDirectory, log: (m) => console.log(m) })
console.log("migrations done")
