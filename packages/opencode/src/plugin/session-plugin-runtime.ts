import type { Hooks, Plugin as PluginInstance, PluginInput, PluginModule, ToolDefinition } from "@opencode-ai/plugin"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Context, Deferred, Effect, Layer } from "effect"
import { SessionPlugin } from "./session-plugin"
import { Plugin } from "."
import type { SessionID } from "../session/schema"
import path from "path"
import { pathToFileURL } from "url"
import { PluginLoader } from "./loader"
import { readV1Plugin } from "./shared"
import { EventV2Bridge } from "../event-v2-bridge"

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
  "auth",
  "tool",
  "tool.definition",
  "dispose",
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

export interface Runtime {
  readonly trigger: <Output>(name: string, input: unknown, output: Output) => Effect.Effect<Output>
  readonly event: (input: unknown) => Effect.Effect<void>
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
      return runtime.event({
        event: { id: event.id, type: event.type, properties: event.data },
      })
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
            yield* Effect.tryPromise({
              try: () => Promise.resolve((handler as Hook)(input, output)),
              catch: (error) => String(error),
            }).pipe(Effect.ignore)
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
      if (!plugin.context) {
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
      const runtime = yield* load(sessionID, yield* plugin.context()).pipe(
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

    return Service.of({ acquire, invalidate, dispose })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SessionPlugin.node, Plugin.node, EventV2Bridge.node],
})

export * as SessionPluginRuntime from "./session-plugin-runtime"
