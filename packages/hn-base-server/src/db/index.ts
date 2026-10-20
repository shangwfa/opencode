/**
 * PG 连接与 drizzle 实例。
 * 独立 schema `hn_base`，与 SaaS 的 public 隔离。
 */
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import { env } from "../config/env.js"
import { schema } from "./schema.js"

export const pool = new Pool({ connectionString: env.databaseUrl })

// node-postgres 硬性要求：必须挂 error 监听，否则 idle 连接断开会让进程崩
pool.on("error", (error) => {
  console.warn("[hn-base-server] PG 连接池异常", String(error))
})

export const db = drizzle(pool, {
  schema,
  logger: false,
})

export { schema }
export type DB = typeof db
