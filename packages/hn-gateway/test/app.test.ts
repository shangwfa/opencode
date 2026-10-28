import { describe, expect, it, beforeAll } from "bun:test"
import "./setup.js"

describe("HTTP 应用（P1：/health 与 /metrics）", () => {
  let app: import("../src/app.js").GatewayAppType & { fetch: Request["clone"] extends never ? never : (req: Request) => Promise<Response> }

  beforeAll(async () => {
    const { initGatewayDb } = await import("../src/db/index.js")
    await initGatewayDb()
    const { createGatewayApp } = await import("../src/app.js")
    app = (await createGatewayApp()) as any
  })

  it("GET /health 返回 ok 且 db=up，带 X-Trace-ID 响应头", async () => {
    const res = await app.fetch(new Request("http://localhost/health"))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-trace-id")).toBeTruthy()
    const body = (await res.json()) as Record<string, unknown>
    expect(body.status).toBe("healthy")
    expect(body.configCount).toBeGreaterThanOrEqual(0)
  })

  it("请求被计入 Prometheus 指标，/metrics 可抓取", async () => {
    await app.fetch(new Request("http://localhost/health"))
    const res = await app.fetch(new Request("http://localhost/metrics"))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("gateway_http_request_duration_seconds")
    expect(text).toContain("gateway_process_start_time_seconds")
  })

  it("未知路径由 hosting 兜底接管（返回“访问的应用不存在”，而非 JSON 404）", async () => {
    const res = await app.fetch(new Request("http://localhost/no-such-path"))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("访问的应用不存在")
  })
})
