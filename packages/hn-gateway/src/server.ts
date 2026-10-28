/**
 * hn-gateway 独立服务入口。
 *
 *   GATEWAY_DATABASE_URL=postgresql://... bun run src/server.ts
 *   可选：GATEWAY_PORT（默认 3101）、GATEWAY_HOST（默认 0.0.0.0）
 */
import { serve } from "@hono/node-server"
import { createGatewayApp } from "./app.js"
import { initGatewayDb, connectionString } from "./db/index.js"
import { ConfigChangeBus } from "./hosting/notify.js"
import { getPort, getHost, getChatbotTarget, isWsProxyEnabled } from "./config/env.js"
import { logger } from "./logger.js"
import { appService } from "./domains/apps/service.js"
import { microappsInvalidation } from "./domains/microapps/index.js"
import { grayInvalidation } from "./domains/ap/index.js"
import { attachWsProxy } from "./ws-proxy.js"

const port = getPort()
const host = getHost()

// 启动期幂等建表
await initGatewayDb()

// 配置变更总线：LISTEN/NOTIFY 替代 Nacos 推送（独立连接，断连自动重建）
const bus = new ConfigChangeBus({ connectionString })
bus.onChange((change) => {
  appService.invalidate(change)
  microappsInvalidation.invalidate(change)
  grayInvalidation.invalidate(change)
})
bus.onInvalidateAll(() => {
  appService.invalidateAll()
  microappsInvalidation.invalidateAll()
  grayInvalidation.invalidateAll()
})
await bus.start()

const app = await createGatewayApp()

// /socket.io ws 透传（原 DISABLE_PROXY 语义 → GATEWAY_WS_PROXY=off）
const nodeServer = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  logger.info({ span: "server:start", msg: `hn-gateway listening on http://${host}:${info.port}` })
})
attachWsProxy(nodeServer as unknown as import("node:http").Server, () => (isWsProxyEnabled() ? getChatbotTarget() : null))
