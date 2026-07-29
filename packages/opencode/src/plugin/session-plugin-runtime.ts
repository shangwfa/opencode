import type { Hooks, Plugin as PluginInstance, PluginInput, PluginModule, ToolDefinition } from "@opencode-ai/plugin"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Deferred, Duration, Effect, Layer, Option } from "effect"
import { SessionPlugin } from "./session-plugin"
import { Plugin } from "."
import type { SessionID } from "../session/schema"
import path from "path"
import { pathToFileURL } from "url"
import { PluginLoader } from "./loader"
import { readV1Plugin } from "./shared"
import { EventV2Bridge } from "../event-v2-bridge"
import { SandboxProvider } from "../tool/sandbox-provider"

type Hook = (input: unknown, output: unknown) => Promise<void> | void
type Loaded = { readonly code: string; readonly hooks: Hooks }

const allowed = new Set([
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
  "tool.definition",
  "permission.ask",
  "experimental.compaction.autocontinue",
])

const moduleCache = new Map<string, Promise<PluginInstance>>()

export async function importPluginCode(code: string): Promise<PluginInstance> {
  const cached = moduleCache.get(code)
  if (cached) return cached

  const promise = (async () => {
    const fs = await import("fs/promises")
    const file = path.join(import.meta.dir, `.opencode-spl-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`)
    await fs.writeFile(file, code)
    try {
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod.default !== "function") throw new TypeError("Session plugin must default-export a function")
      return mod.default as PluginInstance
    } finally {
      await fs.unlink(file).catch(() => {})
    }
  })()

  moduleCache.set(code, promise)
  void promise.catch(() => moduleCache.delete(code))
  return promise
}

async function importPlugins(row: SessionPlugin.Row, context: PluginInput): Promise<Hooks[]> {
  if (row.source === "npm") {
    if (!row.spec) throw new TypeError(`Session npm plugin ${row.name} is missing a package spec`)
    const resolved = await PluginLoader.resolve({ spec: row.spec, options: undefined, deprecated: false }, "server")
    if (!resolved.ok) {
      if (resolved.stage === "missing") throw new TypeError(resolved.value.message)
      throw resolved.error
    }
    const loaded = await PluginLoader.load(resolved.value)
    if (!loaded.ok) throw loaded.error
    const v1 = readV1Plugin(loaded.value.mod, row.spec, "server", "detect")
    if (v1) return [await (v1 as PluginModule).server(context, undefined)]
    const plugins = Object.values(loaded.value.mod).flatMap((value) => {
      if (typeof value === "function") return [value as PluginInstance]
      if (typeof value !== "object" || value === null || !("server" in value) || typeof value.server !== "function") return []
      return [value.server as PluginInstance]
    })
    if (!plugins.length) throw new TypeError(`Session npm plugin ${row.spec} must export a server plugin`)
    return await Promise.all(plugins.map((plugin) => plugin(context)))
  }
  return [await (await importPluginCode(row.code))(context)]
}

function filterHooks(hooks: Hooks): Hooks {
  return Object.fromEntries(Object.entries(hooks).filter(([name]) => allowed.has(name))) as Hooks
}

const PLUGIN_AGENT_PORT = 9200
const HOOK_TIMEOUT_MS = 5000

function createSandboxRuntime(
  sessionID: SessionID,
  sandbox: SandboxProvider.Interface,
  store: SessionPlugin.Interface,
  context: PluginInput | undefined,
): Effect.Effect<Runtime> {
  return Effect.gen(function* () {
    let agentUrl: string | null = null
    let disposed = false
    let empty = false
    let revision: string | undefined
    let startFailed = false

    const startAgent = Effect.gen(function* () {
      if (disposed || agentUrl) return
      startFailed = false
      const rows = yield* store.list(sessionID).pipe(Effect.catch(() => Effect.succeed([] as SessionPlugin.Row[])))
      const enabled = rows.filter((r: SessionPlugin.Row) => r.enabled)
      revision = JSON.stringify(enabled.map((row) => [row.name, row.source, row.spec, row.code, row.time_updated]))
      empty = enabled.length === 0
      if (empty) return

      const pluginsJson = JSON.stringify(
        enabled.map((r: SessionPlugin.Row) => ({ name: r.name, source: r.source, spec: r.spec, code: r.code })),
      )
      const encoded = Buffer.from(pluginsJson).toString("base64")
      const pluginContext = Buffer.from(JSON.stringify({
        project: context?.project,
        directory: context?.directory ?? "/workspace",
        worktree: context?.worktree ?? "/workspace",
        serverUrl: context?.serverUrl.toString(),
      })).toString("base64")

      yield* sandbox
        .runInSession(
          sessionID,
            `pkill -f "bun.*sandbox-plugin-agent" 2>/dev/null; sleep 0.5; ` +
            `SESSION_ID='${sessionID}' PLUGINS_BASE64='${encoded}' PLUGIN_CONTEXT_BASE64='${pluginContext}' ` +
            `setsid bun /opt/sandbox-plugin-agent.ts > /tmp/plugin-agent.log 2>&1 &`,
        )
        .pipe(Effect.catch(() => Effect.void))

      for (let attempt = 0; attempt < 15; attempt++) {
        const url = yield* sandbox.getEndpoint(sessionID, PLUGIN_AGENT_PORT).pipe(
          Effect.catch(() => Effect.succeed("")),
        )
        if (url) {
          const healthy = yield* Effect.tryPromise({
            try: () => fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok),
            catch: () => false,
          })
          if (healthy) {
              if (disposed) return
              agentUrl = url
              yield* Effect.logInfo("sandbox plugin-agent started", { sessionID, url })
              return
            }
        }
        yield* Effect.sleep("1 second")
      }
      startFailed = true
      yield* Effect.logWarning("sandbox plugin-agent failed to start", { sessionID })
    })

    const [ensureAgent, invalidateAgent] = yield* Effect.cachedInvalidateWithTTL(startAgent, Duration.infinity)
    const [refresh] = yield* Effect.cachedInvalidateWithTTL(
      Effect.gen(function* () {
        if (disposed || revision === undefined) return
        const rows = yield* store.list(sessionID).pipe(Effect.catch(() => Effect.succeed([] as SessionPlugin.Row[])))
        const enabled = rows.filter((row) => row.enabled)
        const next = JSON.stringify(enabled.map((row) => [row.name, row.source, row.spec, row.code, row.time_updated]))
        if (next === revision) return
        const url = agentUrl
        agentUrl = null
        revision = undefined
        empty = false
        startFailed = false
        yield* invalidateAgent
        if (url) {
          yield* Effect.tryPromise({
            try: () => fetch(`${url}/shutdown`, {
              method: "POST",
              signal: AbortSignal.timeout(1000),
            }),
            catch: () => undefined,
          }).pipe(Effect.ignore)
        }
      }),
      Duration.seconds(1),
    )

    const send = <Output>(name: string, input: unknown, output: Output): Effect.Effect<
      | { readonly ok: true; readonly value: Output }
      | { readonly ok: false; readonly url: string | null; readonly error?: string }
    > => Effect.gen(function* () {
      yield* refresh
      yield* ensureAgent.pipe(Effect.catch(() => Effect.void))
      const url = agentUrl
      if (!url || disposed) return { ok: false as const, url }
      const result = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${url}/hook/${name}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input, output }),
            signal: AbortSignal.timeout(HOOK_TIMEOUT_MS + 1000),
          })
          const body = await response.json().catch(() => undefined) as { result?: Output; error?: string } | undefined
          if (!response.ok) {
            if (response.headers.get("x-opencode-plugin-error") === "true") {
              return { error: body?.error ?? `hook ${name} failed with status ${response.status}` }
            }
            return
          }
          return body
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!result) return { ok: false as const, url }
      if (result.error) return { ok: false as const, url, error: result.error }
      return { ok: true as const, value: result.result ?? output }
    })

    const request = <Output>(name: string, input: unknown, output: Output, retry: boolean): Effect.Effect<Output> =>
      Effect.gen(function* () {
        const first = yield* send(name, input, output)
        if (first.ok) return first.value
        if (first.error) return yield* Effect.die(new Error(first.error))
        if (!retry || disposed || empty) return output
        if (!first.url && startFailed) {
          startFailed = false
          yield* invalidateAgent
          return output
        }
        if (agentUrl === first.url) {
          agentUrl = null
          yield* invalidateAgent
        }
        const second = yield* send(name, input, output)
        if (!second.ok && second.error) return yield* Effect.die(new Error(second.error))
        if (!second.ok && startFailed) {
          startFailed = false
          yield* invalidateAgent
        }
        return second.ok ? second.value : output
      })

    const runtime: Runtime = {
      trigger: (name, input, output) => request(name, input, output, true),
      event: (input: unknown, retry = true) => {
        if (!retry && !agentUrl) return Effect.void
        return request("event", input, null, retry).pipe(Effect.asVoid)
      },
      auth: () => Effect.succeed({} as Record<string, unknown>),
      tools: () =>
        Effect.gen(function* () {
          yield* refresh
          if (!agentUrl) {
            yield* ensureAgent.pipe(Effect.catch(() => Effect.void))
            if (!agentUrl) return {} as Record<string, ToolDefinition>
          }
          const fetchTools = Effect.gen(function* () {
            const url = agentUrl
            if (!url) return
            const toolsMap = yield* Effect.tryPromise({
              try: async () => {
                const response = await fetch(`${url}/tools`, { signal: AbortSignal.timeout(10000) })
                if (!response.ok) return
                return (await response.json()) as Record<
                  string,
                  { description: string; jsonSchema: Record<string, unknown> }
                >
              },
              catch: () => undefined,
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (toolsMap) return { url, toolsMap }
          })
          const first = yield* fetchTools
          const loaded = first ?? (yield* Effect.gen(function* () {
            agentUrl = null
            yield* invalidateAgent
            yield* ensureAgent.pipe(Effect.catch(() => Effect.void))
            return yield* fetchTools
          }))
          const result = {} as Record<string, ToolDefinition>
          if (loaded) {
            for (const [name, schema] of Object.entries(loaded.toolsMap)) {
              result[name] = {
                description: schema.description,
                args: {},
                jsonSchema: schema.jsonSchema,
                execute: async (args: Record<string, unknown>, context: {
                  sessionID: string
                  messageID: string
                  agent: string
                  directory: string
                  worktree: string
                }) => {
                  await Effect.runPromise(refresh)
                  if (!agentUrl) await Effect.runPromise(ensureAgent.pipe(Effect.catch(() => Effect.void)))
                  const current = agentUrl
                  if (!current) throw new Error(`tool ${name} agent is unavailable`)
                  const healthy = await fetch(`${current}/health`, { signal: AbortSignal.timeout(1000) })
                    .then((response) => response.ok)
                    .catch(() => false)
                  if (!healthy) {
                    if (agentUrl === current) agentUrl = null
                    await Effect.runPromise(invalidateAgent)
                    await Effect.runPromise(ensureAgent.pipe(Effect.catch(() => Effect.void)))
                  }
                  if (!agentUrl) throw new Error(`tool ${name} agent is unavailable`)
                  const resp = await fetch(`${agentUrl}/tool/${encodeURIComponent(name)}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      args,
                      context: {
                        sessionID: context.sessionID,
                        messageID: context.messageID,
                        agent: context.agent,
                        directory: context.directory,
                        worktree: context.worktree,
                      },
                    }),
                    signal: AbortSignal.timeout(30000),
                  })
                  const data = await resp.json().catch(() => undefined) as
                    | { result?: string | { output: string }; error?: string }
                    | undefined
                  if (!resp.ok) throw new Error(data?.error ?? `tool ${name} failed with status ${resp.status}`)
                  return data?.result ?? `tool ${name} returned no result`
                },
              } as unknown as ToolDefinition
            }
          }
          return result
        }),
      dispose: () => Effect.gen(function* () {
          if (disposed) return
          disposed = true
          const url = agentUrl
          agentUrl = null
          yield* invalidateAgent
          if (url) {
            yield* Effect.tryPromise({
            try: () => fetch(`${url}/shutdown`, {
              method: "POST",
              signal: AbortSignal.timeout(1000),
            }),
              catch: () => undefined,
            }).pipe(Effect.ignore)
          }
        }),
    }
    return runtime
  })
}

export interface Runtime {
  readonly trigger: <Output>(name: string, input: unknown, output: Output) => Effect.Effect<Output>
  readonly event: (input: unknown, retry?: boolean) => Effect.Effect<void>
  readonly auth: (input: { providerID: string; provider: unknown; auth: unknown }) => Effect.Effect<Record<string, unknown>>
  readonly tools: () => Effect.Effect<Record<string, ToolDefinition>>
  readonly dispose: () => Effect.Effect<void>
}

export interface Interface {
  readonly acquire: (sessionID: SessionID) => Effect.Effect<Runtime>
  readonly invalidate: (sessionID: SessionID) => Effect.Effect<void>
  readonly dispose: (sessionID: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPluginRuntime") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionPlugin.Service
    const plugin = yield* Plugin.Service
    const events = yield* EventV2Bridge.Service
    const maybeSandbox = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
    const runtimes = new Map<string, Runtime>()
    const pending = new Map<string, Deferred.Deferred<Runtime, Error>>()

    const eventSessionID = (input: unknown) => {
      if (!input || typeof input !== "object") return
      const properties = (input as { event?: { properties?: unknown } }).event?.properties
      if (!properties || typeof properties !== "object") return
      const value = properties as { sessionID?: unknown; info?: { sessionID?: unknown } }
      if (typeof value.sessionID === "string") return value.sessionID
      if (typeof value.info?.sessionID === "string") return value.info.sessionID
    }

    const unsubscribe = yield* events.listen((event) => {
      const sessionID = eventSessionID({ event: { properties: event.data } })
      const runtime = sessionID ? runtimes.get(sessionID) : undefined
      if (!runtime) return Effect.void
      return runtime.event(
        { event: { id: event.id, type: event.type, properties: event.data } },
        event.type !== "session.deleted",
      )
    })
    yield* Effect.addFinalizer(() => unsubscribe)

    const load = Effect.fn("SessionPluginRuntime.load")(function* (sessionID: SessionID, context: PluginInput) {
      const rows = yield* store.list(sessionID)
      const loaded: Loaded[] = []
      for (const row of rows) {
        if (!row.enabled) continue
        const hooks = yield* Effect.tryPromise({
          try: async () => {
            const filtered = (await importPlugins(row, context)).map(filterHooks)
            if (row.source === "npm" && filtered.every((hook) => Object.keys(hook).length === 0)) {
              throw new TypeError(`Session npm plugin ${row.spec} exposes no supported session hooks`)
            }
            return filtered
          },
          catch: () => undefined,
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("failed to load session plugin", {
              sessionID,
              name: row.name,
              source: row.source,
              ...(row.spec ? { spec: row.spec } : {}),
              error,
            }),
          ),
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (hooks) for (const hook of hooks) loaded.push({ code: row.code, hooks: hook })
      }

      const runtime: Runtime = {
        trigger: <Output>(name: string, input: unknown, output: Output) => Effect.gen(function* () {
          for (const item of loaded) {
            const handler = (item.hooks as Record<string, unknown>)[name]
            if (typeof handler !== "function") continue
            yield* Effect.promise(() => Promise.resolve((handler as Hook)(input, output)))
          }
          return output
        }),
        event: (input) => Effect.gen(function* () {
          for (const item of loaded) {
            const handler = item.hooks.event
            if (typeof handler !== "function") continue
            yield* Effect.tryPromise({
              try: () => Promise.resolve(handler(input as { event: never })),
              catch: (error) => String(error),
            }).pipe(Effect.ignore)
          }
        }),
        auth: (input) => Effect.gen(function* () {
          let options: Record<string, unknown> = {}
          for (const item of loaded) {
            const auth = item.hooks.auth
            if (!auth || auth.provider !== input.providerID || !auth.loader) continue
            const next = yield* Effect.tryPromise({
              try: () => auth.loader!(() => Promise.resolve(input.auth as never), input.provider as never),
              catch: (error) => String(error),
            }).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (next && typeof next === "object") options = { ...options, ...next }
          }
          return options
        }),
        tools: () => Effect.sync(() =>
          Object.assign({}, ...loaded.map((item) => item.hooks.tool ?? {})),
        ),
        dispose: () => Effect.gen(function* () {
          for (const item of loaded) {
            const handler = item.hooks.dispose
            if (typeof handler !== "function") continue
            yield* Effect.tryPromise({
              try: () => Promise.resolve(handler()),
              catch: (error) => String(error),
            }).pipe(
              Effect.tapError((error) => Effect.logError("session plugin dispose hook failed", { error })),
              Effect.ignore,
            )
          }
          loaded.length = 0
        }),
      }
      return runtime
    })

    const acquire: Interface["acquire"] = Effect.fn("SessionPluginRuntime.acquire")(function* (sessionID: SessionID) {
      const key = sessionID as string
      const current = runtimes.get(key)
      if (current) return current
      const inFlight = pending.get(key)
      if (inFlight) return yield* Deferred.await(inFlight).pipe(Effect.orDie)
      // V2 sandbox mode doesn't depend on global plugin context — plugins run in the sandbox.
      if (!maybeSandbox && !plugin.context) {
        const runtime: Runtime = {
          trigger: (_name, _input, output) => Effect.succeed(output),
          event: () => Effect.void,
          auth: () => Effect.succeed({}),
          tools: () => Effect.succeed({}),
          dispose: () => Effect.void,
        }
        runtimes.set(key, runtime)
        return runtime
      }
      const deferred = yield* Deferred.make<Runtime, Error>()
      pending.set(key, deferred)

      // V2: sandbox execution mode — if SandboxProvider available, plugins run in sandbox
      const context = plugin.context ? yield* plugin.context() : undefined
      const runtime = yield* (maybeSandbox
        ? createSandboxRuntime(sessionID, maybeSandbox, store, context)
        : load(sessionID, context!)
      ).pipe(
        Effect.tap((value) => Deferred.succeed(deferred, value).pipe(Effect.ignore)),
        Effect.tapError((error) => Deferred.fail(deferred, new Error(String(error))).pipe(Effect.ignore)),
        Effect.ensuring(Effect.sync(() => pending.delete(key))),
      )
      runtimes.set(key, runtime)
      yield* runtime.event({
        event: {
          id: `session-plugin-init-${key}`,
          type: "session.created",
          properties: { info: { id: key, title: "" } },
        },
      })
      return runtime
    })

    const dispose: Interface["dispose"] = Effect.fn("SessionPluginRuntime.disposeSession")(function* (sessionID: SessionID) {
      const key = sessionID as string
      const runtime = runtimes.get(key)
      if (!runtime) return
      runtimes.delete(key)
      yield* runtime.dispose()
    })

    const invalidate: Interface["invalidate"] = Effect.fn("SessionPluginRuntime.invalidate")(function* (sessionID: SessionID) {
      yield* dispose(sessionID)
    })

    yield* Effect.addFinalizer(() =>
      Effect.forEach(runtimes.values(), (runtime) => runtime.dispose(), { discard: true }).pipe(
        Effect.ensuring(Effect.sync(() => runtimes.clear())),
      ),
    )

    return Service.of({ acquire, invalidate, dispose })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionPlugin.node, Plugin.node, EventV2Bridge.node, SandboxProvider.node],
})

export * as SessionPluginRuntime from "./session-plugin-runtime"
