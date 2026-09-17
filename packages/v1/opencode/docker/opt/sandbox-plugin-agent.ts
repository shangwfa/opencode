/**
 * Sandbox Plugin Agent — 在沙箱里常驻运行的 HTTP 服务，加载 session plugins 并暴露 hooks + tools endpoint。
 *
 * 启动方式（由 SandboxPluginRuntime 通过 exec background 调用）：
 *   SESSION_ID=ses_xxx PLUGINS_BASE64='...' bun /opt/sandbox-plugin-agent.ts
 *
 * 通信协议：
 *   GET  /health              → { status, plugins, hooks, tools }
 *   POST /hook/{hookName}     → { result }（hook 返回值覆盖 output）
 *   GET  /tools               → { name: { description, args } }
 *   POST /tool/{toolName}     → { result }（工具执行结果）
 */
import { pathToFileURL } from "url"
import { tmpdir } from "os"
import path from "path"
import { z } from "zod"
import { installNpmPlugin } from "./sandbox-plugin-npm"

const PORT = parseInt(process.env.PLUGIN_AGENT_PORT || "9200")
const SESSION_ID = process.env.SESSION_ID || ""
const MODULE_DIR = process.env.PLUGIN_AGENT_MODULE_DIR || "/workspace/.opencode/session-plugins"
const PLUGIN_CONTEXT: {
  project?: unknown
  directory?: string
  worktree?: string
  serverUrl?: string
} = JSON.parse(
  process.env.PLUGIN_CONTEXT_BASE64
    ? Buffer.from(process.env.PLUGIN_CONTEXT_BASE64, "base64").toString()
    : "{}",
)
const PLUGINS: Array<{ name: string; source: string; spec?: string; code?: string }> = JSON.parse(
  process.env.PLUGINS_BASE64
    ? Buffer.from(process.env.PLUGINS_BASE64, "base64").toString()
    : process.env.PLUGINS_JSON || "[]",
)

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
  "permission.ask",
  "experimental.compaction.autocontinue",
])

const HOOK_TIMEOUT_MS = 5000
const hookHandlers = new Map<string, Array<(input: unknown, output: unknown) => Promise<unknown> | unknown>>()
const disposeHandlers: Array<() => Promise<unknown> | unknown> = []
const loadErrors: Array<{ name: string; error: string }> = []
let loadedPlugins = 0
const toolDefinitions = new Map<
  string,
  {
    description: string
    jsonSchema: Record<string, unknown>
    parse: (input: unknown) => unknown
    execute: (args: unknown, context: Record<string, unknown>) => Promise<unknown>
  }
>()
let server: ReturnType<typeof Bun.serve>

async function loadPlugin(plugin: { name: string; source: string; spec?: string; code?: string }, codeFile?: string) {
  let mod: Record<string, unknown>
  if (plugin.source === "npm" && plugin.spec) {
    mod = await import(pathToFileURL(await installNpmPlugin(plugin.spec, MODULE_DIR)).href)
  } else if (codeFile) {
    mod = await import(`${pathToFileURL(codeFile).href}?plugin=${encodeURIComponent(plugin.name)}`)
  } else {
    throw new Error(`Plugin ${plugin.name} has no spec or code`)
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
    client: undefined,
    project: PLUGIN_CONTEXT.project,
    directory: PLUGIN_CONTEXT.directory ?? "/workspace",
    worktree: PLUGIN_CONTEXT.worktree ?? "/workspace",
    experimental_workspace: { register() {} },
    serverUrl: new URL(PLUGIN_CONTEXT.serverUrl ?? "http://localhost:4096"),
    $: Bun.$,
    sessionID: SESSION_ID,
    workdir: PLUGIN_CONTEXT.directory ?? "/workspace",
  }
  const hooks = await fn(context)
  let hookCount = 0
  for (const [name, handler] of Object.entries(hooks)) {
    if (typeof handler === "function") {
      if (name === "dispose") {
        disposeHandlers.push(handler as () => Promise<unknown>)
        continue
      }
      if (!ALLOWED_HOOKS.has(name)) continue
      if (!hookHandlers.has(name)) hookHandlers.set(name, [])
      hookHandlers.get(name)!.push(handler as (input: unknown, output: unknown) => Promise<unknown>)
      hookCount++
    } else if (name === "tool" && handler && typeof handler === "object") {
      for (const [toolName, toolDef] of Object.entries(handler as Record<string, Record<string, unknown>>)) {
        if (!toolDef || typeof toolDef.execute !== "function" || !toolDef.args || typeof toolDef.args !== "object") continue
        const schema = z.object(toolDef.args as z.ZodRawShape)
        toolDefinitions.set(toolName, {
          description: String(toolDef.description ?? ""),
          jsonSchema: z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown>,
          parse: (input) => schema.parse(input),
          execute: toolDef.execute as (args: unknown, context: Record<string, unknown>) => Promise<unknown>,
        })
      }
    }
  }
  loadedPlugins++
  console.error(`[plugin-agent] loaded: ${plugin.name} (${hookCount} hooks, ${toolDefinitions.size} tools)`)
}

const codeFiles = await Promise.all(
  PLUGINS.map(async (plugin) => {
    if (!plugin.code || plugin.source === "npm") return
    const file = path.join(tmpdir(), `spa-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`)
    await Bun.write(file, plugin.code)
    return file
  }),
)

for (const [index, plugin] of PLUGINS.entries()) {
  try {
    await loadPlugin(plugin, codeFiles[index])
  } catch (e) {
    console.error(`[plugin-agent] load failed: ${plugin.name}: ${e}`)
    loadErrors.push({ name: plugin.name, error: String(e) })
  }
}

server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return Response.json({
        status: loadErrors.length ? "degraded" : "ok",
        plugins: loadedPlugins,
        configuredPlugins: PLUGINS.length,
        errors: loadErrors,
        hooks: [...hookHandlers.keys()],
        tools: [...toolDefinitions.keys()],
      })
    }

    if (url.pathname === "/tools") {
      const tools: Record<string, { description: string; jsonSchema: Record<string, unknown> }> = {}
      for (const [name, def] of toolDefinitions) {
        tools[name] = { description: def.description, jsonSchema: def.jsonSchema }
      }
      return Response.json(tools)
    }

    if (url.pathname.startsWith("/tool/") && req.method === "POST") {
      const toolName = url.pathname.replace("/tool/", "")
      const def = toolDefinitions.get(toolName)
      if (!def) return Response.json({ error: `tool ${toolName} not found` }, { status: 404 })
      const body = await req.json().catch(() => ({}))
      try {
        const metadata: Array<Record<string, unknown>> = []
        const context = {
          ...(body.context && typeof body.context === "object" ? body.context : {}),
          abort: new AbortController().signal,
          metadata: (input: Record<string, unknown>) => metadata.push(input),
          ask: async () => {},
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const result = await Promise.race([
          Promise.resolve(def.execute(def.parse(body.args ?? body), context)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`tool ${toolName} timeout`)), 30000)
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer)
        })
        return Response.json({ result, metadata })
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500, headers: { "X-OpenCode-Plugin-Error": "true" } })
      }
    }

    if (url.pathname.startsWith("/hook/")) {
      const hookName = url.pathname.replace("/hook/", "")
      const handlers = hookHandlers.get(hookName) || []
      if (!handlers.length) return Response.json({ result: null })

      const body = await req.json().catch(() => ({}))
      let result = body.output ?? null

      for (const handler of handlers) {
        try {
          let timer: ReturnType<typeof setTimeout> | undefined
          const ret = await Promise.race([
            Promise.resolve(handler(body.input, result)),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`hook ${hookName} timeout`)), HOOK_TIMEOUT_MS)
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer)
          })
          if (
            ret !== undefined &&
            ret !== null &&
            (result === undefined || result === null || valueKind(result) === valueKind(ret))
          ) {
            result = ret
          }
        } catch (e) {
          console.error(`[plugin-agent] hook ${hookName} error: ${e}`)
          return Response.json({ error: String(e) }, { status: 500, headers: { "X-OpenCode-Plugin-Error": "true" } })
        }
      }

      return Response.json({ result })
    }

    if (url.pathname === "/shutdown" && req.method === "POST") {
      await Promise.all(disposeHandlers.map((handler) => Promise.resolve(handler()).catch(() => {})))
      await Promise.all(
        codeFiles.flatMap((file) =>
          file
            ? [
                Bun.file(file)
                  .delete()
                  .catch(() => {}),
              ]
            : [],
        ),
      )
      setTimeout(() => server.stop(true), 0)
      return Response.json({ status: "stopping" })
    }

    return new Response("Not found", { status: 404 })
  },
})

function valueKind(value: unknown) {
  if (Array.isArray(value)) return "array"
  if (value === null) return "null"
  return typeof value
}

console.error(
  `[plugin-agent] listening on :${PORT} (${hookHandlers.size} hook types, ${toolDefinitions.size} tools)`,
)
