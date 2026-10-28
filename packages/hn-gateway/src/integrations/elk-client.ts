/**
 * ELK 检索透传（原 report.controller 的 /log、/search、/customSearch 语义）。
 * GATEWAY_ELK_URL / GATEWAY_ELK_NAME / GATEWAY_ELK_PASSWORD 由环境配置。
 */
import { logger } from "../logger.js"

export function elkConfig(): { url: string; auth: string } | null {
  const url = process.env["GATEWAY_ELK_URL"]
  const name = process.env["GATEWAY_ELK_NAME"]
  const password = process.env["GATEWAY_ELK_PASSWORD"]
  if (!url || !name || !password) return null
  return { url: url.replace(/\/$/, ""), auth: `Basic ${Buffer.from(`${name}:${password}`).toString("base64")}` }
}

/** GET /log/:traceId：按 traceId 查最近 10 条（原查询体原样） */
export async function searchLogsByTraceId(traceId: string): Promise<unknown> {
  const config = elkConfig()
  if (!config) return { error: "ELK 未配置（GATEWAY_ELK_URL/ELK_NAME/ELK_PASSWORD）" }
  const index = `log_xybot-front-gateway_${process.env["GATEWAY_ENV"] || "online"}*`
  return elkSearch(config, index, {
    size: 10,
    query: { term: { traceId } },
    sort: [{ "@timestamp": { order: "desc" } }],
  })
}

/** POST /search：查询体透传 */
export async function searchLogs(body: unknown): Promise<unknown> {
  const config = elkConfig()
  if (!config) return { error: "ELK 未配置（GATEWAY_ELK_URL/ELK_NAME/ELK_PASSWORD）" }
  const env = process.env["GATEWAY_ENV"] === "staging" ? "staging" : "online"
  return elkSearch(config, `log_xybot-front-gateway_${env}*`, body)
}

/** POST /customSearch：要求 serverName，查 log_{serverName}_{env}* */
export async function searchCustomLogs(body: { serverName?: string } & Record<string, unknown>): Promise<unknown> {
  if (!body.serverName) return "serverName is required"
  const config = elkConfig()
  if (!config) return { error: "ELK 未配置（GATEWAY_ELK_URL/ELK_NAME/ELK_PASSWORD）" }
  const env = process.env["GATEWAY_ENV"] === "staging" ? "staging" : "online"
  return elkSearch(config, `log_${body.serverName}_${env}*`, body)
}

async function elkSearch(config: { url: string; auth: string }, index: string, body: unknown): Promise<unknown> {
  try {
    const res = await fetch(`${config.url}/${index}/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: config.auth },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    return await res.json()
  } catch (error) {
    logger.error({ span: "elk:search:error", msg: "ELK 查询失败", error: String(error) })
    return { error: String(error) }
  }
}
