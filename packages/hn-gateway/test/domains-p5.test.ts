import { describe, expect, it, beforeAll } from "bun:test"
import "./setup.js"

/**
 * P5 业务域 e2e：report / apps 发布 / ap 回滚与 backend-gray 双模式 / webhook 审批 / upload / gitlab / pipelines。
 * 假外部服务（飞书/ELK/媒体/GitLab）起本地端口。
 */
const UP = "http://127.0.0.1:18902"
const alertHits: unknown[] = []
const elkHits: { index: string; body: unknown }[] = []
const mediaHits: { path: string; method: string }[] = []
const gitlabHits: string[] = []

Bun.serve({
  port: 18902,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/feishu") {
      alertHits.push(await req.json())
      return Response.json({ ok: true })
    }
    if (url.pathname.endsWith("/_search")) {
      elkHits.push({ index: url.pathname.split("/")[1]!, body: await req.json() })
      return Response.json({ hits: { total: { value: 1 } } })
    }
    if (url.pathname === "/boss/api/v1/media/getPubUploadUrl") {
      mediaHits.push({ path: url.pathname, method: "POST" })
      return Response.json({ data: { uploadUrl: `${UP}/put-bucket`, readUrl: `${UP}/read/file-x`, headers: {}, exists: false } })
    }
    if (url.pathname === "/put-bucket") {
      mediaHits.push({ path: url.pathname, method: req.method })
      return new Response(null, { status: 200 })
    }
    if (url.pathname === "/api/v4/namespaces") {
      gitlabHits.push("namespaces")
      return Response.json([{ id: 1, path: "frontend" }])
    }
    if (url.pathname.startsWith("/api/v4/projects/proj%2Frepo/repository/branches")) {
      gitlabHits.push("branches")
      return Response.json([{ name: "main" }])
    }
    if (url.pathname.startsWith("/api/v4/groups/proj%2Frepo/members")) {
      gitlabHits.push("members")
      return Response.json([{ id: 9, username: "dev" }])
    }
    return new Response("not found", { status: 404 })
  },
})

describe("P5 业务域", () => {
  let app: any

  beforeAll(async () => {
    process.env["GATEWAY_ENV"] = "online"
    process.env["GATEWAY_GITLAB_API_URL"] = `${UP}/api/v4`
    process.env["GATEWAY_GITLAB_TOKEN"] = "test-token"
    process.env["GATEWAY_MEDIA_UPLOAD_URL"] = UP
    process.env["GATEWAY_MEDIA_UPLOAD_TOKEN"] = "test-media-token"
    process.env["GATEWAY_ELK_URL"] = UP
    process.env["GATEWAY_ELK_NAME"] = "elastic"
    process.env["GATEWAY_ELK_PASSWORD"] = "pass"

    const { initGatewayDb, pool, schemaName } = await import("../src/db/index.js")
    await initGatewayDb()
    for (const appId of ["p5-report-app", "xybot-aipower-web", "p5-webhook-app"]) {
      await pool.query(`DELETE FROM ${schemaName}.apps WHERE app_id = $1`, [appId])
      await pool.query(`DELETE FROM ${schemaName}.publishes WHERE app_id = $1`, [appId])
    }
    const { appService } = await import("../src/domains/apps/service.js")
    await appService.upsertApp({
      appId: "p5-report-app",
      domain: "p5.test",
      config: {
        appId: "p5-report-app",
        url: `${UP}/static/app`,
        version: "1.0.0",
        env: { ERROR_WEB_HOOK: `${UP}/feishu` },
        gitLab: "https://gitlab.shadow-rpa.net/proj/repo",
        publishList: [{ id: "pub-0", version: "1.0.0" }],
      },
    })
    await appService.upsertApp({
      appId: "xybot-aipower-web",
      domain: "aipower.test",
      config: {
        appId: "xybot-aipower-web",
        url: `${UP}/static/aipower`,
        version: "2",
        publishList: [
          { id: "pub-a2", version: "2" },
          { id: "pub-a1", version: "1" },
        ],
        backendGray: { enabled: true, featureKey: "feat-x", version: "3.0.0" },
      },
    })
    const { createGatewayApp } = await import("../src/app.js")
    app = await createGatewayApp()
  })

  it("report：POST / 落 PG 事件 + span=http error 触发飞书告警", async () => {
    const res = await app.fetch(
      new Request("http://localhost/report-api/", {
        method: "POST",
        headers: { "content-type": "application/json", domain: "p5.test" },
        body: JSON.stringify({ level: "error", msg: "前端报错", span: "http", req: "{}", res: "{}" }),
      }),
    )
    expect(((await res.json()) as any).data).toBe("success")
    const { pool, schemaName } = await import("../src/db/index.js")
    const rows = await pool.query(`SELECT app_id, level, message FROM ${schemaName}.report_events ORDER BY id DESC LIMIT 1`)
    expect(rows.rows[0]).toMatchObject({ app_id: "p5-report-app", level: "error", message: "前端报错" })
    for (let i = 0; i < 30 && alertHits.length === 0; i++) await new Promise((r) => setTimeout(r, 100))
    expect(alertHits.length).toBeGreaterThan(0)
  })

  it("report：/app/:appId/:version 剔除 env/microApps 并按版本过滤", async () => {
    const res = await app.fetch(new Request("http://localhost/report-api/app/p5-report-app/1.0.0"))
    const body = ((await res.json()) as any).data
    expect(body.appId).toBe("p5-report-app")
    expect(body.env).toBeUndefined()
    expect(body.microApps).toBeUndefined()
    expect(body.publishList).toHaveLength(1)
    expect(body.publishList[0].version).toBe("1.0.0")
  })

  it("report：/log/:traceId 透传 ELK", async () => {
    const res = await app.fetch(new Request("http://localhost/report-api/log/trace-abc"))
    expect(((await res.json()) as any).data).toMatchObject({ hits: { total: { value: 1 } } })
    expect(elkHits[0]!.index.startsWith("log_xybot-front-gateway_online")).toBe(true)
    expect((elkHits[0]!.body as any).query.term.traceId).toBe("trace-abc")
  })

  it("apps：publish 写 version/publishList + publish 流水；publishList 可查", async () => {
    const res = await app.fetch(
      new Request("http://localhost/gw-api/apps/publish/p5-report-app", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "1.1.0", commit: "abc123", commitMsg: "fix", publisher: "ruomu" }),
      }),
    )
    expect(((await res.json()) as any).data).toBe("success")
    const appRow = await appServiceGet("p5-report-app")
    expect(appRow.version).toBe("1.1.0")
    const publishList = appRow.publishList as any[]
    expect(publishList[0]).toMatchObject({ version: "1.1.0", commit: "abc123" })
    expect(publishList.length).toBeLessThanOrEqual(50)

    const list = ((await (await app.fetch(new Request("http://localhost/gw-api/apps/publishList/p5-report-app"))).json()) as any).data as any[]
    expect(list[0].version).toBe("1.1.0")

    const { pool, schemaName } = await import("../src/db/index.js")
    const pub = await pool.query(`SELECT publish_version, status FROM ${schemaName}.publishes WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`, ["p5-report-app"])
    expect(pub.rows[0]).toMatchObject({ publish_version: "1.1.0", status: "success" })
  })

  it("ap：GET /:id 目标应用、rollback 校验与执行、backend-gray 双模式", async () => {
    // 目标应用
    const target = ((await (await app.fetch(new Request("http://localhost/gw-api/ap/xybot-aipower-web"))).json()) as any).data
    expect(target.appId).toBe("xybot-aipower-web")

    // version 旋转：当前版本 2 置顶
    const versions = ((await (await app.fetch(new Request("http://localhost/gw-api/ap/version"))).json()) as any).data as any[]
    expect(versions[0].version).toBe("2")

    // 回滚到 1.0.0
    const rollback = await app.fetch(
      new Request("http://localhost/gw-api/ap/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      }),
    )
    expect(((await rollback.json()) as any).data.success).toBe(true)
    const afterRollback = await appServiceGet("xybot-aipower-web")
    expect(afterRollback.version).toBe("1")

    // 回滚到不存在的版本
    const bad = await app.fetch(
      new Request("http://localhost/gw-api/ap/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 99 }),
      }),
    )
    expect(JSON.stringify(await bad.json())).toContain("目标版本不在发布历史中")

    // backend-gray 查询模式
    const query = ((await (await app.fetch(new Request("http://localhost/gw-api/ap/backend-gray", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).json()) as any).data
    expect(query).toMatchObject({ enabled: true, featureKey: "feat-x" })

    // backend-gray 设置模式
    await app.fetch(
      new Request("http://localhost/gw-api/ap/backend-gray", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, featureKey: "feat-y", version: 9 }),
      }),
    )
    const updated = await appServiceGet("xybot-aipower-web")
    expect(updated.backendGray).toMatchObject({ featureKey: "feat-y", version: "9" })
  })

  it("webhook：审批回调更新 publishList 的 approval/step", async () => {
    const { appService } = await import("../src/domains/apps/service.js")
    await appService.updateAppConfig("xybot-aipower-web", "full", {
      ...(await appServiceGet("xybot-aipower-web")),
      publishList: [{ id: "pub-a1", version: "1.0.0" }, { id: "pub-a2", version: "2.0.0" }],
    })
    const res = await app.fetch(
      new Request("http://localhost/gw-api/webhook/publish/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ _status: "approved", _param: { appId: "xybot-aipower-web", id: "pub-a1", env: "online" } }),
      }),
    )
    const body = ((await res.json()) as any).data
    expect(body).toBe("success")
    const after = await appServiceGet("xybot-aipower-web")
    const item = (after.publishList as any[]).find((p) => p.id === "pub-a1")
    expect(item).toMatchObject({ approval: "approved", step: "online" })

    // 未找到发布记录
    const missing = await app.fetch(
      new Request("http://localhost/gw-api/webhook/publish/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ _status: "approved", _param: { appId: "xybot-aipower-web", id: "no-such", env: "online" } }),
      }),
    )
    expect(JSON.stringify(await missing.json())).toContain("未找到")
  })

  it("upload：file 与 text 转投媒体服务", async () => {
    const form = new FormData()
    form.append("file", new File([new TextEncoder().encode("hello upload")], "a.txt", { type: "text/plain" }))
    const fileRes = await app.fetch(new Request("http://localhost/gw-api/upload/file", { method: "POST", body: form }))
    expect(((await fileRes.json()) as any).data).toEqual({ readUrl: `${UP}/read/file-x` })

    const textRes = await app.fetch(
      new Request("http://localhost/gw-api/upload/text", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: "note.md", content: "# hi" }),
      }),
    )
    expect(((await textRes.json()) as any).data).toEqual({ readUrl: `${UP}/read/file-x` })
    expect(mediaHits.some((h) => h.path === "/put-bucket" && h.method === "PUT")).toBe(true)
  })

  it("gitlab：namespace/branches/members 代理", async () => {
    const ns = await app.fetch(new Request("http://localhost/gw-api/gitlab/namespace"))
    expect(((await ns.json()) as any).data[0].path).toBe("frontend")
    const branches = await app.fetch(new Request("http://localhost/gw-api/gitlab/branches?namespaceWithPath=proj/repo"))
    expect(((await branches.json()) as any).data[0].name).toBe("main")
    const members = await app.fetch(new Request("http://localhost/gw-api/gitlab/members?namespaceWithPath=proj/repo"))
    expect(((await members.json()) as any).data[0].username).toBe("dev")
  })

  it("pipelines：未配置云效时返回 503 提示", async () => {
    const res = await app.fetch(new Request("http://localhost/gw-api/pipelines"))
    expect(res.status).toBe(503)
  })
})

async function appServiceGet(appId: string): Promise<Record<string, unknown>> {
  const { appService } = await import("../src/domains/apps/service.js")
  return (await appService.getAppByAppId(appId)) as Record<string, unknown>
}
