/**
 * hn-gateway 环境配置。
 *
 * 数据库：
 *   GATEWAY_DATABASE_URL     PostgreSQL 连接串（回退 DATABASE_URL、OPENCODE_DATABASE_URL；
 *                            最终回退本地开发库 127.0.0.1:5432/opencode-v2-up）
 *   GATEWAY_DATABASE_SCHEMA  业务 schema 名，默认 "hn_gateway"（测试用 hn_gateway_dev）
 *
 * 服务：
 *   GATEWAY_PORT  监听端口，默认 3101
 *   GATEWAY_HOST  监听地址，默认 0.0.0.0
 *
 * 可观测：
 *   GATEWAY_METRICS     设为 "off" 关闭 /metrics Prometheus 指标（默认开）
 *   GATEWAY_LOG_LEVEL   debug|info|warn|error，默认 info
 */

const LOCAL_DEV_DATABASE_URL = "postgresql://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"

export function getDatabaseUrl(): string {
  return (
    process.env["GATEWAY_DATABASE_URL"] ||
    process.env["DATABASE_URL"] ||
    process.env["OPENCODE_DATABASE_URL"] ||
    LOCAL_DEV_DATABASE_URL
  )
}

export function getDatabaseSchema(): string {
  const name = process.env["GATEWAY_DATABASE_SCHEMA"] || "hn_gateway"
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`非法的 GATEWAY_DATABASE_SCHEMA: ${name}`)
  }
  return name
}

export function getPort(): number {
  return Number(process.env["GATEWAY_PORT"] || 3101)
}

export function getHost(): string {
  return process.env["GATEWAY_HOST"] || "0.0.0.0"
}

export function isMetricsEnabled(): boolean {
  return process.env["GATEWAY_METRICS"] !== "off"
}

export function getLogLevel(): "debug" | "info" | "warn" | "error" {
  const level = (process.env["GATEWAY_LOG_LEVEL"] || "info").toLowerCase()
  return level === "debug" || level === "warn" || level === "error" ? level : "info"
}

/** 环境标识（online/test/...），决定 api 网关默认 upstream：https://{env-}api.yingdao.com */
export function getGatewayEnv(): string {
  return process.env["GATEWAY_ENV"] || "online"
}

/** api-proxy upstream（GATEWAY_API_TARGET 可覆盖，测试/本地指向假上游） */
export function getApiGatewayTarget(): string {
  return (
    process.env["GATEWAY_API_TARGET"] ||
    `https://${getGatewayEnv() === "online" ? "" : getGatewayEnv() + "-"}api.yingdao.com`
  )
}

/** internal-proxy 的 regex 前缀 → upstream（对齐原 proxyMap，env 可覆盖） */
export function getInternalTargets(): Record<string, string> {
  return {
    "ai-chatbot": process.env["GATEWAY_CHATBOT_TARGET"] || "http://xybot-backend-chatbot:3000",
    "ai-infra-api": process.env["GATEWAY_AITOOLS_TARGET"] || "http://xybot-front-node-ai-tools:3000",
  }
}

/** 静态资源回源域名改写（原 CND_DOMAIN，指向 COS 桶域名） */
export function getCndDomain(): string {
  return process.env["GATEWAY_CND_DOMAIN"] || "winrobot-pub-a-1302949341.cos.ap-shanghai.myqcloud.com"
}

/** 无 Host 头时的兜底域名（原网关写死的 test-connector.yingdao.com 语义） */
export function getDefaultDomain(): string {
  return process.env["GATEWAY_DEFAULT_DOMAIN"] || "test-connector.yingdao.com"
}

/** /socket.io ws 透传 upstream（原 xybot-backend-chatbot:3000） */
export function getChatbotTarget(): string {
  return process.env["GATEWAY_CHATBOT_TARGET"] || "http://xybot-backend-chatbot:3000"
}

/** 设为 "off" 关闭 ws 透传（等价原 DISABLE_PROXY） */
export function isWsProxyEnabled(): boolean {
  return process.env["GATEWAY_WS_PROXY"] !== "off"
}
