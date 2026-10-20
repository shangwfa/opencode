/**
 * 启动入口：幂等建表 → 监听。
 */
import { serve } from "@hono/node-server"
import { createApp } from "./app.js"
import { env } from "./config/env.js"
import { ensureSchema } from "./db/ensure-schema.js"
import { pool } from "./db/index.js"

await ensureSchema(pool)

const app = createApp()

serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`[hn-base-server] listening on http://${env.host}:${info.port} (schema=${env.databaseSchema})`)
})
