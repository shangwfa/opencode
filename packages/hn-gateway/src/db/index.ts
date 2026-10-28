import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { createSchema } from "./schema.js"
import { getDatabaseSchema, getDatabaseUrl } from "../config/env.js"
import { ensureGatewayTables } from "./ensure-schema.js"
import { logger } from "../logger.js"

/**
 * hn-gateway 数据库（模式同 packages/knowledge）：
 * 连接串/ schema 由 GATEWAY_DATABASE_URL / GATEWAY_DATABASE_SCHEMA 决定，
 * 默认落到本地开发库，测试用 hn_gateway_dev 隔离。
 */
export const connectionString = getDatabaseUrl()
export const schemaName = getDatabaseSchema()

export const pool = new Pool({ connectionString })

// node-postgres 硬性要求：Pool 必须挂 error 监听，否则 idle 连接断开
// （PG 重启/主备切换/admin command 终止）会抛 uncaught exception 使进程崩溃退出
pool.on("error", (error) => {
  logger.warn({ span: "db:pool:error", msg: "PG 连接池连接异常（进程不退出，请求走 stale 降级或报错）", error: String(error) })
})

const schema = createSchema(schemaName)

export const db = drizzle(pool, {
  schema,
  logger: false,
})

export const { apps, microApps, grayFeatures, configs, publishes, reportEvents } = schema

export { ensureGatewayTables }

/** 启动期初始化：建 schema + 建表（幂等），server.ts 与测试入口调用 */
export async function initGatewayDb(): Promise<void> {
  await ensureGatewayTables(pool, schemaName)
}
