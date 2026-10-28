import { describe, expect, it, beforeAll, afterAll } from "bun:test"
import "./setup.js"

/**
 * P3 hosting 责任链 e2e：假上游/假 COS 起本地端口，断言 HTTP 结果、
 * 上游收到的请求（执行过程）与注入后的 HTML 内容。
 */
const UPSTREAM_PORT = 18901
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`
const upstreamHits: { path: string; method: string; host: string }[] = []
const alertHits: unknown[] = []
let cosHitCount = 0

const ENTRY_HTML = `<!DOCTYPE html><html><head>
<link rel="shortcut icon" href="/favicon.ico">
<script>window.YD = {};</script></head><body><div id="app"></div></body></html>`

Bun.serve({
  port: UPSTREAM_PORT,
  async fetch(req) {
    const url = new URL(req.url)
    upstreamHits.push({ path: url.pathname, method: req.method, host: req.headers.get("host") || "" })
    if (url.pathname === "/feishu") {
      alertHits.push(await req.json())
      return Response.json({ ok: true })
    }
    if (url.pathname === "/api/ping") return Response.json({ code: 200, data: { ok: 1 } })
    if (url.pathname === "/api/biz-err") return Response.json({ code: 500, msg: "biz fail" })
    if (url.pathname === "/proxied/px") return Response.json({ proxied: true, path: url.pathname })
    if (url.pathname.endsWith("/main.js")) return new Response("console.log(1)", { headers: { "content-type": "text/javascript" } })
    if (url.pathname.endsWith("/index.html")) {
      cosHitCount += 1
      return new Response(ENTRY_HTML, { headers: { "content-type": "text/html" } })
    }
    if (url.pathname.endsWith("/favicon.ico")) return new Response("ico")
    return new Response("not found", { status: 404 })
  },
})

describe("P3 hosting 责任链", () => {
  let app: any
  const appIds = ["p3-host", "p3-static", "p3-proxy"]

  beforeAll(async () => {
    process.env["GATEWAY_API_TARGET"] = UPSTREAM
    // CND_DOMAIN 替换 hostname：本测试直接用 IP，替换后 URL 不变
    process.env["GATEWAY_CND_DOMAIN"] = "127.0.0.1"
    const { initGatewayDb, pool, schemaName } = await import("../src/db/index.js")
    await initGatewayDb()
    for (const appId of appIds) {
      await pool.query(`DELETE FROM ${schemaName}.apps WHERE app_id = $1`, [appId])
    }
    const { appService } = await import("../src/domains/apps/service.js")
    await appService.upsertApp({
      appId: "p3-host",
      domain: "p3.test",
      baseRoute: "",
      config: {
        appId: "p3-host",
        name: "宿主应用",
        url: `${UPSTREAM}/static/app`,
        version: "1.0.0",
        env: { ERROR_WEB_HOOK: `${UPSTREAM}/feishu` },
        microApps: [
          { appId: "sub1", baseroute: "/sub", url: `${UPSTREAM}/static/sub`, version: "2.0.0", iframe: false, destroy: false, config: { theme: "dark" } },
        ],
      },
    })
    await appService.upsertApp({
      appId: "p3-static",
      domain: "p3.test",
      baseRoute: "webapp",
      config: { appId: "p3-static", url: `${UPSTREAM}/static/webapp`, version: "1.0.0" },
    })
    await appService.upsertApp({
      appId: "p3-api",
      domain: "p3.test",
      baseRoute: "api",
      config: { appId: "p3-api", env: { ERROR_WEB_HOOK: `${UPSTREAM}/feishu` } },
    })
    await appService.upsertApp({
      appId: "p3-proxy",
      domain: "p3.test",
      baseRoute: "proxied",
      config: { appId: "p3-proxy", proxy: { target: UPSTREAM } },
    })
    const { createGatewayApp } = await import("../src/app.js")
    app = await createGatewayApp()
  })

  it("api-proxy：/api/* 转发假上游并透传响应", async () => {
    const res = await app.fetch(new Request("http://localhost/api/ping"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: 200, data: { ok: 1 } })
    expect(upstreamHits.some((h) => h.path === "/api/ping" && h.host !== "localhost")).toBe(true)
  })

  it("api-proxy：业务码非 200 触发飞书告警（读 baseRoute 应用的 ERROR_WEB_HOOK）", async () => {
    const before = alertHits.length
    const res = await app.fetch(new Request("http://localhost/api/biz-err", { headers: { domain: "p3.test" } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ code: 500, msg: "biz fail" })
    for (let i = 0; i < 30 && alertHits.length <= before; i++) await new Promise((r) => setTimeout(r, 100))
    expect(alertHits.length).toBeGreaterThan(before)
    const alertPayload = alertHits.at(-1) as any
    expect(alertPayload.msg_type).toBe("post")
    expect(JSON.stringify(alertPayload.content)).toContain("/api/biz-err")
  })

  it("redirect：/share/share 302 → /embed/application/detail?...&container=browser", async () => {
    const res = await app.fetch(new Request("http://localhost/share/share?id=5&x=1"))
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("/embed/application/detail?id=5&x=1&container=browser")
  })

  it("redirect：/client/appstore/detail container=modal", async () => {
    const res = await app.fetch(new Request("http://localhost/client/appstore/detail?id=8"))
    expect(res.headers.get("location")).toBe("/embed/application/detail?id=8&container=modal")
  })

  it("sso：/exchange/sso/token 返回内联中转页", async () => {
    const res = await app.fetch(new Request("http://localhost/exchange/sso/token"))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("SSOLogin")
    expect(html).toContain("GET_ACCESS_TOKEN")
  })

  it("app-hosting：入口 HTML 注入 window.YD（env/version/MICRO_APPS，无 locale）+ favicon 修正", async () => {
    const res = await app.fetch(new Request("http://localhost/", { headers: { host: "p3.test" } }))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('"version":"1.0.0"')
    expect(html).toContain("MICRO_APPS")
    expect(html).toContain('"baseroute":"/sub"')
    expect(html).toContain("static/sub/2.0.0/index.html")
    expect(html).toContain('"theme":"dark"')
    expect(html).toContain(`${UPSTREAM}/static/app/1.0.0/favicon.ico`)
    expect(html).not.toContain("locale")
    const cosAfter = cosHitCount
    expect(cosAfter).toBeGreaterThan(0)
  })

  it("HTML 缓存：命中不再回源；app 配置变更（指纹变化）后重新回源", async () => {
    const before = cosHitCount
    await app.fetch(new Request("http://localhost/", { headers: { host: "p3.test" } }))
    expect(cosHitCount).toBe(before) // 缓存生效，未回源

    const { appService } = await import("../src/domains/apps/service.js")
    await appService.updateAppConfig("p3-host", "incremental", { version: "3.0.0" })
    const res = await app.fetch(new Request("http://localhost/", { headers: { host: "p3.test" } }))
    const html = await res.text()
    expect(cosHitCount).toBe(before + 1) // 指纹变化重新回源
    expect(html).toContain('"version":"3.0.0"')
  })

  it("请求头 version 覆盖版本（灰度最高优先级）", async () => {
    const res = await app.fetch(new Request("http://localhost/", { headers: { host: "p3.test", version: "9.9.9" } }))
    const html = await res.text()
    expect(html).toContain('"version":"9.9.9"')
  })

  it("static-file：非 HTML 扩展名回源 COS，Content-Type 正确", async () => {
    const res = await app.fetch(new Request("http://localhost/webapp/1.0.0/main.js", { headers: { host: "p3.test" } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/javascript")
    expect(await res.text()).toBe("console.log(1)")
    const hit = upstreamHits.find((h) => h.path === "/static/webapp/1.0.0/webapp/1.0.0/main.js")
    expect(hit).toBeTruthy() // fileUrl = {app.url}/{version}{baseUrl}（原语义，baseUrl 含前缀）
  })

  it("app.proxy：整机透传保留路径", async () => {
    const res = await app.fetch(new Request("http://localhost/proxied/px", { headers: { host: "p3.test" } }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ proxied: true, path: "/proxied/px" })
  })

  it("app-api-info：/app-api/info 返回宿主应用信息", async () => {
    const res = await app.fetch(new Request("http://localhost/app-api/info", { headers: { host: "p3.test", baseurl: "/whatever" } }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ name: "宿主应用", id: "p3-host" })
    expect(String(body.version)).not.toBe("")
  })

  it("未知域名兜底：访问的应用不存在", async () => {
    const res = await app.fetch(new Request("http://localhost/", { headers: { host: "no-such.test" } }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("访问的应用不存在")
  })
})
