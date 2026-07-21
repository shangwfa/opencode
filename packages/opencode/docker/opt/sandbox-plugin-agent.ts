/**
 * Sandbox Plugin Agent — 在沙箱里常驻运行的 HTTP 服务，加载 session plugins 并暴露 hooks endpoint。
 *
 * 启动方式（由 SandboxPluginRuntime 通过 exec background 调用）：
 *   SESSION_ID=ses_xxx PLUGINS_JSON='[...]' bun /opt/sandbox-plugin-agent.ts
 *
 * 通信协议：
 *   GET  /health              → { status, plugins, hooks }
 *   POST /hook/{hookName}     → { result }（hook 返回值覆盖 output）
 */
const PORT = parseInt(process.env.PLUGIN_AGENT_PORT || "9200")
const SESSION_ID = process.env.SESSION_ID || ""
const PLUGINS: Array<{ name: string; source: string; spec?: string; code?: string }> =
  JSON.parse(process.env.PLUGINS_JSON || "[]")

const ALLOWED_HOOKS = new Set([
  "tool.execute.before",
  "tool.execute.after",
  "chat.message",
  "chat.params",
  "chat.headers",
  "command.execute.before",
  "shell.env",
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.session.compacting",
  "experimental.text.complete",
  "event",
  "tool",
  "tool.definition",
  "dispose",
  "experimental.compaction.autocontinue",
])

const HOOK_TIMEOUT_MS = 5000
const hookHandlers = new Map<string, Array<(input: unknown, output: unknown) => Promise<unknown> | unknown>>()

async function loadPlugin(plugin: { name: string; source: string; spec?: string; code?: string }) {
  let mod: Record<string, unknown>
  if (plugin.source === "npm" && plugin.spec) {
    mod = await import(plugin.spec)
  } else if (plugin.code) {
    const tmp = `/tmp/spa-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`
    await Bun.write(tmp, plugin.code)
    try {
      mod = await import(tmp)
    } finally {
      await Bun.file(tmp).delete().catch(() => {})
    }
  } else {
    throw new Error(`Plugin ${plugin.name} has no spec or code`)
  }

  let fn: ((ctx: unknown) => Promise<Record<string, unknown>>)
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
    fn = (typeof found === "function"
      ? found
      : (found as Record<string, unknown>).server) as typeof fn
  }

  const context = { sessionID: SESSION_ID, workdir: "/workspace" }
  const hooks = await fn(context)
  let count = 0
  for (const [name, handler] of Object.entries(hooks)) {
    if (typeof handler !== "function") continue
    if (!ALLOWED_HOOKS.has(name)) continue
    if (!hookHandlers.has(name)) hookHandlers.set(name, [])
    hookHandlers.get(name)!.push(handler as (input: unknown, output: unknown) => Promise<unknown>)
    count++
  }
  console.error(`[plugin-agent] loaded: ${plugin.name} (${count} hooks)`)
}

for (const p of PLUGINS) {
  try {
    await loadPlugin(p)
  } catch (e) {
    console.error(`[plugin-agent] load failed: ${p.name}: ${e}`)
  }
}

const hasPlugins = hookHandlers.size > 0
if (!hasPlugins) {
  console.error("[plugin-agent] no plugins loaded, exiting")
  process.exit(0)
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        plugins: PLUGINS.length,
        hooks: [...hookHandlers.keys()],
      })
    }

    if (url.pathname.startsWith("/hook/")) {
      const hookName = url.pathname.replace("/hook/", "")
      const handlers = hookHandlers.get(hookName) || []
      if (!handlers.length) return Response.json({ result: null })

      const body = await req.json().catch(() => ({}))
      let result = body.output ?? body ?? null

      for (const handler of handlers) {
        try {
          const ret = await Promise.race([
            Promise.resolve(handler(body.input, body.output)),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`hook ${hookName} timeout`)), HOOK_TIMEOUT_MS),
            ),
          ])
          if (ret !== undefined && ret !== null) result = ret
        } catch (e) {
          console.error(`[plugin-agent] hook ${hookName} error: ${e}`)
        }
      }

      return Response.json({ result })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.error(`[plugin-agent] listening on :${PORT} (${hookHandlers.size} hook types)`)
