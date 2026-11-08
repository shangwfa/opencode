import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { bodyLimit } from "hono/body-limit"
import { and, desc, eq, isNull, or, ilike } from "drizzle-orm"
import { z } from "zod"
import { db } from "../db/index.js"
import { browserSession, browserScript, browserScriptVersion } from "../db/schema.js"
import { writeTuples, check } from "../authz/index.js"
import { requireAuth, type AppEnv } from "../middleware/auth.js"
import { AppError, errors } from "../lib/errors.js"
import { writeAudit } from "../lib/audit.js"
import { saasCreateSession, saasRunShell } from "../lib/saas.js"
import {
  BROWSER_INSTRUCTIONS,
  browserUpstream,
  startBrowser,
  connectCdp,
  cdpCommand,
  validTarget,
} from "../lib/browser-cdp.js"

const json = { "content-type": "application/json" }
const fileName = z
  .string()
  .min(4)
  .max(160)
  .regex(/^[^/\\\0\r\n]+\.js$/u)
const content = z
  .string()
  .min(1)
  .refine((text) => Buffer.byteLength(text) <= 256 * 1024, "脚本不能超过 256 KiB")
const source = z
  .object({ content: content.optional(), sessionId: z.string().optional(), fileName: fileName.optional() })
  .refine(
    (v) =>
      (v.content !== undefined && v.sessionId === undefined && v.fileName === undefined) ||
      (v.content === undefined && Boolean(v.sessionId) && Boolean(v.fileName)),
    "请选择脚本内容或沙箱文件，不能同时提交",
  )

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw errors.invalid(result.error.issues[0]?.message ?? "参数错误")
  return result.data
}

export async function requireBrowser(userId: string, id: string, permission = "read") {
  const [row] = await db
    .select()
    .from(browserSession)
    .where(and(eq(browserSession.id, id), isNull(browserSession.deletedAt)))
    .limit(1)
  if (
    !row ||
    !(await check(db, { subject: { type: "user", id: userId }, object: { type: "session", id }, permission }))
  ) {
    throw errors.notFound("browser")
  }
  return row
}

async function readableScript(userId: string, id: string, ownerOnly = false) {
  const [row] = await db
    .select()
    .from(browserScript)
    .where(
      and(
        eq(browserScript.id, id),
        isNull(browserScript.deletedAt),
        ownerOnly
          ? eq(browserScript.ownerId, userId)
          : or(eq(browserScript.ownerId, userId), eq(browserScript.visibility, "public")),
      ),
    )
    .limit(1)
  if (!row) throw errors.notFound("script")
  return row
}

async function scriptContent(userId: string, input: z.infer<typeof source>) {
  if (input.content !== undefined) return input.content
  await requireBrowser(userId, input.sessionId!)
  const res = await browserUpstream(
    `/api/session/${encodeURIComponent(input.sessionId!)}/fs/read/output/${encodeURIComponent(input.fileName!)}`,
  )
  // 先限长，避免把任意体积的沙箱文件装进内存/数据库。
  const reader = res.body?.getReader()
  if (!reader) throw errors.invalid("脚本文件为空")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 256 * 1024) throw errors.invalid("脚本不能超过 256 KiB")
      chunks.push(chunk.value)
    }
  } finally {
    await reader.cancel()
  }
  return parse(content, Buffer.concat(chunks).toString("utf8"))
}

export const browserRoutes = new Hono<AppEnv>()
browserRoutes.use("*", requireAuth)
browserRoutes.use(
  "*",
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ code: "payload_too_large", message: "请求内容过大" }, 413),
  }),
)

browserRoutes.get("/sessions", async (c) => {
  const rows = await db
    .select()
    .from(browserSession)
    .where(and(eq(browserSession.ownerId, c.get("userId")), isNull(browserSession.deletedAt)))
    .orderBy(desc(browserSession.timeCreated))
    .limit(200)
  return c.json({ items: rows })
})

browserRoutes.post("/sessions", async (c) => {
  const input = parse(
    z.object({ title: z.string().trim().min(1).max(200), scriptId: z.string().optional() }).strict(),
    await c.req.json().catch(() => null),
  )
  const ownerId = c.get("userId")
  const script = input.scriptId ? await readableScript(ownerId, input.scriptId) : undefined
  const version = script
    ? (
        await db
          .select()
          .from(browserScriptVersion)
          .where(and(eq(browserScriptVersion.scriptId, script.id), eq(browserScriptVersion.version, script.version)))
      )[0]
    : undefined
  if (script && !version) throw errors.notFound("script")
  const id = await saasCreateSession({ title: input.title, directory: "/workspace" })
  // 即使浏览器启动失败也保留可重试的会话；创建失败则回收 SaaS 会话，避免无主沙箱。
  try {
    await db.transaction(async (tx) => {
      await writeTuples(tx as unknown as typeof db, [
        {
          resourceType: "session",
          resourceId: id,
          relation: "owner",
          subjectType: "user",
          subjectId: ownerId,
          createdBy: ownerId,
        },
      ])
      await tx
        .insert(browserSession)
        .values({ id, title: input.title, ownerId, status: "preparing", timeCreated: Date.now() })
    })
  } catch (error) {
    await browserUpstream(`/api/session/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {})
    throw error
  }
  // 云端模板自举安装可能数分钟；创建接口立即返回，后台准备，前端轮询状态。
  void prepareBrowserSession(id, version?.content).catch(() => {})
  await writeAudit({ actorId: ownerId, action: "browser.create", resourceType: "session", resourceId: id }, c)
  return c.json({ session: { id, title: input.title, ownerId }, status: "preparing", ready: false, error: null }, 201)
})

/** 幂等准备：写会话 skill、启动浏览器、物化已发布脚本，最后把状态写回 PG。 */
async function prepareBrowserSession(id: string, scriptContent?: string) {
  try {
    // AGENTS.md 由 startBrowser 在缺失时写入，避免覆盖用户后续自定义的指令。
    await browserUpstream(`/api/session/${encodeURIComponent(id)}/skills`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        id: "agent-browser",
        name: "agent-browser",
        description: "Operate the shared sandbox browser and review its UI",
        content: BROWSER_INSTRUCTIONS,
        autoinvoke: true,
      }),
    })
    await startBrowser(id)
    if (scriptContent) {
      const encoded = Buffer.from(scriptContent).toString("base64")
      const result = await saasRunShell(
        id,
        `mkdir -p /workspace/output && printf '%s' '${encoded}' | base64 -d > /workspace/output/published-script.js # ${crypto.randomUUID()}`,
      )
      if (result.exit !== 0) throw errors.upstream(503, "脚本准备失败")
    }
    await db
      .update(browserSession)
      .set({ status: "ready", error: null })
      .where(and(eq(browserSession.id, id), isNull(browserSession.deletedAt)))
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await db
      .update(browserSession)
      .set({ status: "failed", error: message.slice(0, 2000) })
      .where(and(eq(browserSession.id, id), isNull(browserSession.deletedAt)))
      .catch(() => {})
    throw cause
  }
}

/** 浏览器准备状态；前端在 preparing 时轮询。 */
browserRoutes.get("/sessions/:id/browser", async (c) => {
  const row = await requireBrowser(c.get("userId"), c.req.param("id"))
  return c.json({ sessionId: row.id, status: row.status, error: row.error })
})

browserRoutes.delete("/sessions/:id", async (c) => {
  const row = await requireBrowser(c.get("userId"), c.req.param("id"))
  if (row.ownerId !== c.get("userId")) throw errors.notFound("browser")
  try {
    await browserUpstream(`/api/session/${encodeURIComponent(row.id)}`, { method: "DELETE" })
  } catch (error) {
    // SaaS 会话已被回收时仍允许清理历史；其它失败保留记录，避免隐藏未回收的沙箱。
    if (!(error instanceof AppError && error.status === 404)) throw error
  }
  await db.update(browserSession).set({ deletedAt: Date.now() }).where(eq(browserSession.id, row.id))
  await writeAudit(
    { actorId: c.get("userId"), action: "browser.delete", resourceType: "session", resourceId: row.id },
    c,
  )
  return c.json({ deleted: true })
})

browserRoutes.post("/sessions/:id/start", async (c) => {
  const id = c.req.param("id")
  const row = await requireBrowser(c.get("userId"), id, "run")
  if (row.status === "ready") {
    await startBrowser(id)
    return c.json({ ready: true, status: "ready" })
  }
  await db
    .update(browserSession)
    .set({ status: "preparing", error: null })
    .where(and(eq(browserSession.id, id), isNull(browserSession.deletedAt)))
  try {
    await prepareBrowserSession(id)
    return c.json({ ready: true, status: "ready" })
  } catch (cause) {
    return c.json({ ready: false, status: "failed", error: cause instanceof Error ? cause.message : String(cause) })
  }
})

browserRoutes.post("/sessions/:id/stop", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id, "run")
  const result = await saasRunShell(
    id,
    `flock --close -w 45 /tmp/opencode-cdp.lock /opt/cdp-browser/cdp-browser.sh stop # ${crypto.randomUUID()}`,
  )
  if (result.exit !== 0) throw errors.upstream(503, "停止浏览器失败")
  return c.json({ stopped: true })
})

browserRoutes.get("/sessions/:id/forms", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id)
  const res = await browserUpstream(`/api/session/${encodeURIComponent(id)}/form`)
  return c.json(await res.json())
})

browserRoutes.post("/sessions/:id/forms/:form/reply", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id, "run")
  const input = parse(
    z
      .object({ answer: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])) })
      .strict(),
    await c.req.json().catch(() => null),
  )
  const res = await browserUpstream(
    `/api/session/${encodeURIComponent(id)}/form/${encodeURIComponent(c.req.param("form"))}/reply`,
    { method: "POST", headers: json, body: JSON.stringify(input) },
  )
  return c.json(await res.json().catch(() => ({ replied: true })))
})

browserRoutes.get("/sessions/:id/targets", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id)
  const res = await browserUpstream(`/api/session/${encodeURIComponent(id)}/proxy/9222/json/list`)
  const targets = parse(
    z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), type: z.string() })),
    await res.json(),
  )
  return c.json({ items: targets.filter((t) => t.type === "page") })
})

browserRoutes.post("/sessions/:id/targets", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id, "run")
  const input = parse(
    z
      .object({
        url: z
          .string()
          .url()
          .refine((v) => /^https?:\/\//.test(v)),
      })
      .strict(),
    await c.req.json().catch(() => null),
  )
  // Chromium 的 /json/new 不解码整个查询串；用 CDP 导航保留 URL 的查询和片段。
  const response = await browserUpstream(`/api/session/${encodeURIComponent(id)}/proxy/9222/json/new?about:blank`, {
    method: "PUT",
  })
  const target = parse(
    z.object({ id: z.string(), title: z.string(), url: z.string(), type: z.string() }),
    await response.json(),
  )
  await cdpCommand(id, target.id, "Page.navigate", { url: input.url }, c.req.raw.signal)
  return c.json({ ...target, url: input.url }, 201)
})

browserRoutes.delete("/sessions/:id/targets/:target", async (c) => {
  const id = c.req.param("id"),
    target = c.req.param("target")
  await requireBrowser(c.get("userId"), id, "run")
  if (!validTarget(target)) throw errors.invalid("无效的标签页")
  await browserUpstream(`/api/session/${encodeURIComponent(id)}/proxy/9222/json/close/${encodeURIComponent(target)}`)
  return c.json({ deleted: true })
})

browserRoutes.post("/sessions/:id/targets/:target/command", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id, "run")
  const input = parse(
    z.object({ method: z.string(), params: z.record(z.string(), z.unknown()).default({}) }).strict(),
    await c.req.json().catch(() => null),
  )
  return c.json(await cdpCommand(id, c.req.param("target"), input.method, input.params, c.req.raw.signal))
})

browserRoutes.get("/sessions/:id/targets/:target/frames", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id)
  const ws = await connectCdp(id, c.req.param("target"), c.req.raw.signal)
  return streamSSE(c, async (stream) => {
    let sequence = 0
    const send = (method: string, params?: unknown) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ id: ++sequence, method, params }))
    }
    const params = { format: "jpeg", quality: 65, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }
    let pending: Promise<void> = Promise.resolve()
    const ended = new Promise<void>((resolve) => {
      // error 常驻监听：ws 库在无监听时 emit error 会抛出进程级异常。
      ws.on("error", () => resolve())
      ws.once("close", () => resolve())
    })
    stream.onAbort(() => ws.terminate())
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw))
        if (message.method !== "Page.screencastFrame") return
        // Ack 仅在前一帧写出后发送；慢客户端不会无限积压 JPEG。
        pending = pending
          .then(async () => {
            await stream.writeSSE({ data: JSON.stringify(message.params) })
            send("Page.screencastFrameAck", { sessionId: message.params.sessionId })
          })
          .catch(() => ws.terminate())
      } catch {
        /* 忽略未知 CDP 消息 */
      }
    })
    const keepalive = setInterval(() => {
      send("Page.startScreencast", params)
      void stream.write(": keepalive\n\n").catch(() => ws.terminate())
    }, 8000)
    try {
      await stream.writeSSE({ data: JSON.stringify({ connected: true }) })
      send("Page.enable")
      send("Page.startScreencast", params)
      await ended
    } finally {
      clearInterval(keepalive)
      ws.terminate()
    }
  })
})

browserRoutes.get("/sessions/:id/files", async (c) => {
  const id = c.req.param("id")
  await requireBrowser(c.get("userId"), id)
  const res = await browserUpstream(`/api/session/${encodeURIComponent(id)}/fs/list?path=output`)
  return c.json(await res.json())
})

browserRoutes.get("/sessions/:id/files/:name", async (c) => {
  const input = parse(source, { sessionId: c.req.param("id"), fileName: parse(fileName, c.req.param("name")) })
  return c.json({ content: await scriptContent(c.get("userId"), input) })
})

browserRoutes.get("/scripts", async (c) => {
  const keyword = (c.req.query("q") ?? "").slice(0, 200)
  const rows = await db
    .select()
    .from(browserScript)
    .where(
      and(
        isNull(browserScript.deletedAt),
        or(eq(browserScript.ownerId, c.get("userId")), eq(browserScript.visibility, "public")),
        keyword ? ilike(browserScript.name, `%${keyword.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
      ),
    )
    .orderBy(desc(browserScript.timeUpdated))
    .limit(200)
  return c.json({ items: rows })
})

browserRoutes.post("/scripts", async (c) => {
  const input = parse(
    z
      .object({
        name: z.string().trim().min(1).max(120),
        description: z.string().max(4000).default(""),
        visibility: z.enum(["private", "public"]).default("private"),
        source,
        changelog: z.string().max(4000).default(""),
      })
      .strict(),
    await c.req.json().catch(() => null),
  )
  const text = await scriptContent(c.get("userId"), input.source)
  const now = Date.now(),
    id = `bs_${crypto.randomUUID().replaceAll("-", "")}`
  const script = {
    id,
    name: input.name,
    description: input.description,
    visibility: input.visibility,
    ownerId: c.get("userId"),
    version: 1,
    timeCreated: now,
    timeUpdated: now,
  }
  await db.transaction(async (tx) => {
    await tx.insert(browserScript).values(script)
    await tx
      .insert(browserScriptVersion)
      .values({ scriptId: id, version: 1, content: text, changelog: input.changelog, timeCreated: now })
  })
  await writeAudit(
    { actorId: c.get("userId"), action: "browser.script.create", resourceType: "browser_script", resourceId: id },
    c,
  )
  return c.json(script, 201)
})

browserRoutes.get("/scripts/:id", async (c) => {
  const script = await readableScript(c.get("userId"), c.req.param("id"))
  const versions = await db
    .select({
      scriptId: browserScriptVersion.scriptId,
      version: browserScriptVersion.version,
      changelog: browserScriptVersion.changelog,
      timeCreated: browserScriptVersion.timeCreated,
    })
    .from(browserScriptVersion)
    .where(eq(browserScriptVersion.scriptId, script.id))
    .orderBy(desc(browserScriptVersion.version))
    .limit(200)
  const [latest] = await db
    .select()
    .from(browserScriptVersion)
    .where(and(eq(browserScriptVersion.scriptId, script.id), eq(browserScriptVersion.version, script.version)))
  return c.json({ script, versions, content: latest?.content ?? "" })
})

browserRoutes.get("/scripts/:id/versions/:version", async (c) => {
  const script = await readableScript(c.get("userId"), c.req.param("id"))
  const version = parse(z.coerce.number().int().positive(), c.req.param("version"))
  const [row] = await db
    .select()
    .from(browserScriptVersion)
    .where(and(eq(browserScriptVersion.scriptId, script.id), eq(browserScriptVersion.version, version)))
  if (!row) throw errors.notFound("version")
  return c.json(row)
})

browserRoutes.post("/scripts/:id/versions", async (c) => {
  const script = await readableScript(c.get("userId"), c.req.param("id"), true)
  const input = parse(
    z
      .object({ expectedVersion: z.number().int().positive(), source, changelog: z.string().max(4000).default("") })
      .strict(),
    await c.req.json().catch(() => null),
  )
  const text = await scriptContent(c.get("userId"), input.source)
  const version = input.expectedVersion + 1,
    now = Date.now()
  await db.transaction(async (tx) => {
    const changed = await tx
      .update(browserScript)
      .set({ version, timeUpdated: now })
      .where(
        and(
          eq(browserScript.id, script.id),
          eq(browserScript.version, input.expectedVersion),
          isNull(browserScript.deletedAt),
        ),
      )
      .returning()
    if (!changed.length) throw errors.conflict("脚本已被更新，请刷新后重试")
    await tx
      .insert(browserScriptVersion)
      .values({ scriptId: script.id, version, content: text, changelog: input.changelog, timeCreated: now })
  })
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: "browser.script.version",
      resourceType: "browser_script",
      resourceId: script.id,
      metadata: { version },
    },
    c,
  )
  return c.json({ version }, 201)
})

browserRoutes.patch("/scripts/:id", async (c) => {
  const script = await readableScript(c.get("userId"), c.req.param("id"), true)
  const input = parse(
    z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(4000).optional(),
        visibility: z.enum(["private", "public"]).optional(),
      })
      .strict(),
    await c.req.json().catch(() => null),
  )
  await db
    .update(browserScript)
    .set({ ...input, timeUpdated: Date.now() })
    .where(and(eq(browserScript.id, script.id), isNull(browserScript.deletedAt)))
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: "browser.script.update",
      resourceType: "browser_script",
      resourceId: script.id,
    },
    c,
  )
  return c.json({ updated: true })
})

browserRoutes.delete("/scripts/:id", async (c) => {
  const script = await readableScript(c.get("userId"), c.req.param("id"), true)
  await db.update(browserScript).set({ deletedAt: Date.now() }).where(eq(browserScript.id, script.id))
  await writeAudit(
    {
      actorId: c.get("userId"),
      action: "browser.script.delete",
      resourceType: "browser_script",
      resourceId: script.id,
    },
    c,
  )
  return c.json({ deleted: true })
})
