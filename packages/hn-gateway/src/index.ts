/**
 * @opencode/hn-gateway 包出口：HTTP 应用与数据库装配。
 */
export { createGatewayApp, api, type GatewayAppType, type GatewayAppOptions } from "./app.js"
export {
  db,
  pool,
  schemaName,
  initGatewayDb,
  apps,
  microApps,
  grayFeatures,
  configs,
  publishes,
  reportEvents,
} from "./db/index.js"
export { ConfigChangeBus, CONFIG_CHANGE_CHANNEL, type ConfigChange } from "./hosting/notify.js"
export { traceMiddleware, getTraceContext, type TraceContext } from "./hosting/trace.js"
export { logger } from "./logger.js"
