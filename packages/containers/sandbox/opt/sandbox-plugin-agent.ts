/**
 * Sandbox Plugin Agent — 在会话沙箱里常驻的 HTTP 服务，加载 session plugins 并暴露
 * V2 类型化 hook 端点。插件代码在沙箱内执行，SaaS server 只做 HTTP 转发（无状态多 pod 安全）。
 *
 * 启动方式（由 SessionPlugins 的沙箱 runtime 通过 exec background 调用）：
 *   SESSION_ID=ses_xxx PLUGINS_BASE64='...' nohup bun /opt/sandbox-plugin-agent.ts > /tmp/plugin-agent.log 2>&1 &
 *
 * 插件格式（hook key = V2 `domain.name`，事件为单对象 + 原地 mutation）：
 *   export default async (ctx) => ({
 *     "session.prompt": (event) => { event.prompt.text += " …" },
 *     "tool.execute.before": (event) => { if (event.tool === "read") throw new Error("blocked") },
 *   })
 *
 * 通信协议：
 *   GET  /health                     → { status, plugins, errors, hooks }
 *   POST /hook/{domain}/{name}       → { event }（修改后）；tool.execute.before 抛错 → { veto }
 *   POST /shutdown                   → 执行 dispose 并退出
 */
import { pathToFileURL } from "url"
import { tmpdir } from "os"
import path from "path"
import { createHash } from "node:crypto"
import { installNpmPlugin } from "./sandbox-plugin-npm"

const PORT = parseInt(process.env.PLUGIN_AGENT_PORT || "9200")
const SESSION_ID = process.env.SESSION_ID || ""
const MODULE_DIR = process.env.PLUGIN_AGENT_MODULE_DIR || "/workspace/.opencode/session-plugins"
const PLUGIN_CONTEXT: { serverUrl?: string } = JSON.parse(
  process.env.PLUGIN_CONTEXT_BASE64 ? Buffer.from(process.env.PLUGIN_CONTEXT_BASE64, "base64").toString() : "{}",
)
type PluginRow = {
  name: string
  source: { type: "code"; code: string } | { type: "npm"; spec: string }
}
const INITIAL_PLUGINS: PluginRow[] = JSON.parse(
  process.env.PLUGINS_BASE64 ? Buffer.from(process.env.PLUGINS_BASE64, "base64").toString() : "[]",
)

/** V2 类型化 hook 白名单：事件必须 JSON 可往返且携带 sessionID 才能被 server 侧按会话路由。
 *  session.http.request/http.response（活 Request/Response 对象）、session.retry（Error class）
 *  与 shell 域（事件无 sessionID）因此不在内。 */
const ALLOWED_HOOKS = new Set([
  "session.prompt",
  "session.context",
  "session.compaction",
  "session.generate",
  "session.title",
  "session.model.request",
  "tool.execute.before",
  "tool.execute.after",
  "permission.evaluate",
])

const HOOK_TIMEOUT_MS = 5000
let hookHandlers = new Map<string, Array<(event: unknown) => Promise<unknown> | unknown>>()
let disposeHandlers: Array<() => Promise<unknown> | unknown> = []
let loadErrors: Array<{ name: string; error: string }> = []
let loadedPlugins = 0
let codeFiles: Array<string | undefined> = []
let loadedVersion = ""
let configuring: Promise<void> = Promise.resolve()
const hookRequests: Record<string, number> = {}

async function loadPlugin(plugin: PluginRow, codeFile?: string) {
  let mod: Record<string, unknown>
  if (plugin.source.type === "npm") {
    mod = await import(pathToFileURL(await installNpmPlugin(plugin.source.spec, MODULE_DIR)).href)
  } else if (codeFile) {
    mod = await import(`${pathToFileURL(codeFile).href}?plugin=${encodeURIComponent(plugin.name)}`)
  } else {
    throw new Error(`Plugin ${plugin.name} has no source`)
  }

  let fn: (ctx: unknown) => Promise<Record<string, unknown>>
  if (typeof mod.default === "function") {
    fn = mod.default as typeof fn
  } else if (mod.default && typeof (mod.default as Record<string, unknown>).server === "function") {
    fn = (mod.default as Record<string, unknown>).server as typeof fn
  } else {
    const found = Object.values(mod).find(
      (v) =>
        typeof v === "function" ||
        (v && typeof v === "object" && typeof (v as Record<string, unknown>).server === "function"),
    )
    if (!found) throw new Error(`No server plugin found in ${plugin.name}`)
    fn = (typeof found === "function" ? found : (found as Record<string, unknown>).server) as typeof fn
  }

  const context = {
    sessionID: SESSION_ID,
    workdir: "/workspace",
    directory: "/workspace",
    serverUrl: PLUGIN_CONTEXT.serverUrl ? new URL(PLUGIN_CONTEXT.serverUrl) : undefined,
    $: Bun.$,
  }
  const hooks = await fn(context)
  let hookCount = 0
  for (const [name, handler] of Object.entries(hooks)) {
    if (typeof handler !== "function") continue
    if (name === "dispose") {
      disposeHandlers.push(handler as () => Promise<unknown>)
      continue
    }
    if (!ALLOWED_HOOKS.has(name)) continue
    if (!hookHandlers.has(name)) hookHandlers.set(name, [])
    hookHandlers.get(name)!.push(handler as (event: unknown) => Promise<unknown>)
    hookCount++
  }
  loadedPlugins++
  console.error(`[plugin-agent] loaded: ${plugin.name} (${hookCount} hooks)`)
}

async function configure(plugins: PluginRow[]) {
  const version = createHash("sha256").update(JSON.stringify(plugins)).digest("hex")
  configuring = configuring.catch(() => {}).then(async () => {
    if (loadedVersion === version) return
    await Promise.all(disposeHandlers.map((handler) => Promise.resolve(handler()).catch(() => {})))
    await Promise.all(codeFiles.flatMap((file) => file ? [Bun.file(file).delete().catch(() => {})] : []))
    hookHandlers = new Map()
    disposeHandlers = []
    loadErrors = []
    loadedPlugins = 0
    codeFiles = await Promise.all(plugins.map(async (plugin) => {
      if (plugin.source.type !== "code") return
      const file = path.join(tmpdir(), `spa-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`)
      await Bun.write(file, plugin.source.code)
      return file
    }))
    for (const [index, plugin] of plugins.entries()) {
      try {
        await loadPlugin(plugin, codeFiles[index])
      } catch (e) {
        console.error(`[plugin-agent] load failed: ${plugin.name}: ${e}`)
        loadErrors.push({ name: plugin.name, error: String(e) })
      }
    }
    loadedVersion = version
  })
  await configuring
}

await configure(INITIAL_PLUGINS)

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ])

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return Response.json({
        status: loadErrors.length ? "degraded" : "ok",
        plugins: loadedPlugins,
        configuredPlugins: loadedPlugins + loadErrors.length,
        version: loadedVersion,
        hookRequests,
        errors: loadErrors,
        hooks: [...hookHandlers.keys()],
      })
    }

    if (url.pathname === "/configure" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { plugins?: PluginRow[] }
      await configure(body.plugins ?? [])
      return Response.json({ status: loadErrors.length ? "degraded" : "ok", version: loadedVersion })
    }

    if (url.pathname.startsWith("/hook/") && req.method === "POST") {
      const hookName = url.pathname.replace("/hook/", "").replaceAll("/", ".")
      hookRequests[hookName] = (hookRequests[hookName] ?? 0) + 1
      const body = (await req.json().catch(() => ({}))) as { event?: unknown; plugins?: PluginRow[] }
      if (body.plugins) await configure(body.plugins)
      const handlers = hookHandlers.get(hookName) || []
      if (!handlers.length) return Response.json({ event: null })
      const event = body.event ?? {}

      for (const handler of handlers) {
        try {
          await withTimeout(Promise.resolve(handler(event)), HOOK_TIMEOUT_MS, `hook ${hookName}`)
        } catch (e) {
          console.error(`[plugin-agent] hook ${hookName} error: ${e}`)
          // tool.execute.before 的异常是显式 veto（V1 .env 保护语义）；其余 hook fail-open。
          if (hookName === "tool.execute.before") return Response.json({ veto: String(e) })
          return Response.json({ error: String(e) }, { status: 500 })
        }
      }
      return Response.json({ event })
    }

    if (url.pathname === "/shutdown" && req.method === "POST") {
      await Promise.all(disposeHandlers.map((handler) => Promise.resolve(handler()).catch(() => {})))
      await Promise.all(
        codeFiles.flatMap((file) =>
          file ? [Bun.file(file).delete().catch(() => {})] : [],
        ),
      )
      setTimeout(() => server.stop(true), 0)
      return Response.json({ status: "stopping" })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.error(`[plugin-agent] listening on :${PORT} (${hookHandlers.size} hook types)`)
