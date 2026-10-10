export * as SessionPlugins from "./plugins.js"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Scope } from "effect"
import { SessionPlugin } from "@opencode/schema/session-plugin"
import { Tool } from "@opencode/schema/tool"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { PluginHooks } from "../plugin/hooks.js"
import { SandboxProvider } from "../sandbox/provider.js"
import type { Session } from "../session.js"
import { SessionStore } from "./store.js"
import { SessionPluginTable } from "./sql.js"
import { SessionResourceOwner } from "./resource-owner.js"

export type Info = SessionPlugin.Info
export type Payload = SessionPlugin.Payload
type Stored = Omit<Info, "source"> & { readonly source: SessionPlugin.Source }

export interface Interface {
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info>
  readonly remove: (session: Session.Info, name: SessionPlugin.Name) => Effect.Effect<void>
  readonly clear: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPlugins") {}

const PORT = 9200
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const hookNames = [
  ["session", "prompt"], ["session", "context"], ["session", "compaction"], ["session", "generate"],
  ["session", "title"], ["session", "model.request"], ["tool", "execute.before"],
  ["tool", "execute.after"], ["permission", "evaluate"],
] as const

function fromRow(row: typeof SessionPluginTable.$inferSelect): Stored {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source,
    time: { created: row.time_created, updated: row.time_updated },
  } as Stored
}

type Runtime = { endpoint: string; version: string }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sandbox = yield* SandboxProvider.Service
    const store = yield* SessionStore.Service
    const hooks = yield* PluginHooks.Service
    const runtimes = new Map<Session.ID, Runtime>()
    const locks = KeyedMutex.makeUnsafe<Session.ID>()

    const stored = (ownerID: Session.ID) =>
      db.select().from(SessionPluginTable).where(eq(SessionPluginTable.session_id, ownerID)).all().pipe(
        Effect.map((rows) => rows.map(fromRow).toSorted((a, b) => a.name.localeCompare(b.name))),
        Effect.orDie,
      )

    const launch = Effect.fn("SessionPlugins.launch")(function* (sessionID: Session.ID) {
      const session = yield* store.get(sessionID).pipe(
        Effect.flatMap((value) => value ? Effect.succeed(value) : Effect.fail(new Error(`Session not found: ${sessionID}`))),
      )
      const pid = "/tmp/plugin-agent.pid"
      const start = [
        `if [ -s ${quote(pid)} ]; then`,
        `agent_pid="$(cat ${quote(pid)})"`,
        `if kill -0 "$agent_pid" 2>/dev/null && tr '\\000' '\\n' < "/proc/$agent_pid/cmdline" | grep -Fxq '/opt/sandbox-plugin-agent.ts'; then`,
        `  if bun -e 'fetch("http://127.0.0.1:${PORT}/health", { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then`,
        "    echo ready",
        "    exit 0",
        "  fi",
        `  kill "$agent_pid" 2>/dev/null || true`,
        "fi",
        `rm -f ${quote(pid)}`,
        "fi",
        `SESSION_ID=${quote(sessionID)} nohup bun /opt/sandbox-plugin-agent.ts > /tmp/plugin-agent.log 2>&1 </dev/null &`,
        `echo $! > ${quote(pid)}`,
      ].join("\n")
      const command = `flock --close -x ${quote(`${pid}.lock`)} -c ${quote(start)}`
      const launchStartedAt = Date.now()
      const started = yield* sandbox.run({
        sessionID,
        hostWorkdir: session.location.directory,
        command,
        timeoutMs: 10_000,
        detached: true,
      }).pipe(
        Effect.tap((result) => Effect.logInfo("Session plugin agent launch command completed", {
          sessionID,
          ms: Date.now() - launchStartedAt,
          exitCode: result.exitCode,
          output: result.output.slice(0, 200),
        })),
        Effect.tapError((error) => Effect.logWarning("Session plugin agent launch command failed", {
          sessionID,
          ms: Date.now() - launchStartedAt,
          error: error.message,
        })),
      )
      if (started.exitCode !== 0) return yield* Effect.fail(new Error(`Session plugin agent launch failed: ${started.output}`))
      let endpoint: string | undefined
      // A restored snapshot can take several seconds to resume the container and
      // expose port 9200 even after a detached launch command succeeds.
      for (let attempt = 0; attempt < 60; attempt++) {
        const resolved = yield* sandbox.endpoint(sessionID, PORT, true)
        if (resolved._tag === "resolved") {
          endpoint = `http://${resolved.endpoint.replace(/\/$/, "")}`
          const health = yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1500) })
              if (!response.ok) throw new Error(`Plugin agent health HTTP ${response.status}`)
              return await response.json() as { status: string }
            },
            catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
          }).pipe(Effect.orElseSucceed(() => undefined))
          if (health) return { endpoint, version: "agent" }
        }
        yield* Effect.sleep("250 millis")
      }
      yield* Effect.logWarning("Session plugin agent health probe exhausted", {
        sessionID,
        launchMs: Date.now() - launchStartedAt,
        endpoint,
      })
      return yield* Effect.fail(new Error(`Session plugin agent not ready for ${sessionID}`))
    })

    const ensure = (sessionID: Session.ID) => {
      return locks.withLock(sessionID)(
        Effect.gen(function* () {
          const cached = runtimes.get(sessionID)
          if (cached) {
            // Snapshot restore / sandbox recycle can replace the backing container while
            // the provider still exposes the same session. Re-resolve the current tunnel
            // before trusting a process-local endpoint cache (important in multi-pod mode).
            const current = yield* sandbox.endpoint(sessionID, PORT, true)
            const currentEndpoint = current._tag === "resolved"
              ? `http://${current.endpoint.replace(/\/$/, "")}`
              : undefined
            const alive = yield* Effect.tryPromise({
              try: async () => currentEndpoint === cached.endpoint &&
                (await fetch(`${cached.endpoint}/health`, { signal: AbortSignal.timeout(1000) })).ok,
              catch: () => new Error("Plugin agent health check failed"),
            }).pipe(Effect.orElseSucceed(() => false))
            if (alive) return cached
            runtimes.delete(sessionID)
          }
          const runtime = yield* launch(sessionID)
          runtimes.set(sessionID, runtime)
          return runtime
        }),
      )
    }

    const dispatch = (domain: string, name: string, event: Record<string, unknown>) =>
      Effect.gen(function* () {
        const sessionID = event.sessionID as Session.ID | undefined
        if (!sessionID) return event
        const ownerID = yield* SessionResourceOwner.id(db, sessionID)
        const rows = yield* stored(ownerID)
        if (!rows.length) return event
        const runtime = yield* ensure(ownerID).pipe(
          Effect.catch((error) => Effect.logWarning("Session plugin agent unavailable; hook skipped", {
            sessionID, hook: `${domain}.${name}`, error: error.message,
          }).pipe(Effect.as(undefined))),
        )
        if (!runtime) return event
        const result = yield* Effect.tryPromise<{ event?: Record<string, unknown>; veto?: string }, Error>({
          try: async () => {
            const response = await fetch(`${runtime.endpoint}/hook/${domain}/${name}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                event,
                // PostgreSQL is the source of truth: every Pod supplies its current owner rows.
                // The sandbox agent serializes config updates and ignores identical generations.
                plugins: rows.map(({ name, source }) => ({ name, source })),
              }),
              signal: AbortSignal.timeout(6000),
            })
            const body = await response.json() as { event?: Record<string, unknown>; veto?: string }
            if (body.veto) return { veto: body.veto }
            if (!response.ok) throw new Error(`Plugin hook HTTP ${response.status}`)
            return { event: body.event }
          },
          catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
        }).pipe(Effect.catch((error: Error) => Effect.logWarning("Session plugin hook failed; continuing", {
          sessionID, hook: `${domain}.${name}`, error: error.message,
        }).pipe(Effect.as({} as { event?: Record<string, unknown>; veto?: string }))))
        if ("veto" in result && domain === "tool" && name === "execute.before") {
          return yield* Effect.fail(new Tool.Error({ message: result.veto! }))
        }
        if (result.event && typeof result.event === "object") {
          // `tool.execute.after` failure events carry live `Tool.Error` instances that support
          // the Effect yieldable protocol. A JSON round-trip through the sandbox replaces them
          // with plain objects, so merge the hook's mutations but rebuild the typed error from
          // its payload instead of assigning the plain object back (`ToolHooks["execute.after"]`
          // declares `error` mutable, and the caller does `return yield* afterEvent.error`).
          const merged = result.event as Record<string, unknown>
          const { error, ...rest } = merged
          Object.assign(event, rest)
          if ("error" in merged) {
            const original = event.error
            const payload =
              error !== null && typeof error === "object"
                ? (error as { message?: unknown; metadata?: unknown })
                : undefined
            const message = typeof payload?.message === "string" ? payload.message : undefined
            if (message !== undefined) {
              const metadata =
                payload?.metadata !== null && typeof payload?.metadata === "object"
                  ? (payload.metadata as Record<string, unknown>)
                  : original instanceof Tool.Error && original.metadata !== undefined
                    ? original.metadata
                    : undefined
              event.error = new Tool.Error({
                message,
                // Defect causes do not survive a JSON round-trip. Preserve the original
                // so error classification downstream (e.g. Permission.BlockedError ->
                // `permission.rejected`) still works even when the hook only edits message.
                ...(original instanceof Tool.Error && original.error !== undefined ? { error: original.error } : {}),
                ...(metadata === undefined ? {} : { metadata }),
              })
            }
          }
        }
        return event
      })

    // A small fixed set of bridge callbacks routes by the sessionID present in V2 hook events.
    for (const [domain, name] of hookNames) {
      const register = hooks.register as unknown as (
        d: string,
        n: string,
        cb: (event: Record<string, unknown>) => Effect.Effect<void, unknown>,
      ) => Effect.Effect<unknown, never, Scope.Scope>
      yield* register(domain, name, (event) => dispatch(domain, name, event as Record<string, unknown>).pipe(
        Effect.tap((updated) => Effect.sync(() => Object.assign(event, updated))),
        Effect.asVoid,
      ) as never)
    }

    const invalidate = (ownerID: Session.ID) => {
      const runtime = runtimes.get(ownerID)
      return Effect.gen(function* () {
        let endpoint = runtime?.endpoint
        if (!endpoint) {
          const resolved = yield* sandbox.endpoint(ownerID, PORT, true)
          if (resolved._tag !== "resolved") return
          endpoint = `http://${resolved.endpoint.replace(/\/$/, "")}`
        }
        const rows = yield* stored(ownerID)
        yield* Effect.tryPromise({
          try: async () => fetch(`${endpoint}/configure`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ plugins: rows.map(({ name, source }) => ({ name, source })) }),
            signal: AbortSignal.timeout(5000),
          }),
          catch: () => new Error("plugin agent reconfiguration failed"),
        }).pipe(Effect.ignore)
        runtimes.delete(ownerID)
      })
    }

    return Service.of({
      list: (sessionID) => SessionResourceOwner.id(db, sessionID).pipe(
        Effect.flatMap(stored),
        Effect.map((rows) => rows.map((row) => SessionPlugin.Info.make({ ...row, source: row.source.type === "code" ? { type: "code" } : row.source }))),
      ),
      create: (sessionID, input) => SessionResourceOwner.id(db, sessionID).pipe(Effect.flatMap((ownerID) => locks.withLock(ownerID)(Effect.gen(function* () {
        const now = Date.now()
        yield* db.insert(SessionPluginTable).values({
          id: SessionPlugin.ID.create(), session_id: ownerID, name: input.name,
          description: input.description, source: input.source, time_created: now, time_updated: now,
        }).onConflictDoUpdate({
          target: [SessionPluginTable.session_id, SessionPluginTable.name],
          set: { description: input.description, source: input.source, time_updated: sql`max(${now}, ${SessionPluginTable.time_updated} + 1)` },
        }).run().pipe(Effect.orDie)
        const row = yield* db.select().from(SessionPluginTable)
          .where(and(eq(SessionPluginTable.session_id, ownerID), eq(SessionPluginTable.name, input.name)))
          .get().pipe(Effect.orDie)
        if (!row) return yield* Effect.die(new Error(`Session plugin upsert disappeared: ${input.name}`))
        yield* invalidate(ownerID)
        const info = fromRow(row)
        return SessionPlugin.Info.make({ ...info, source: info.source.type === "code" ? { type: "code" } : info.source })
      })))),
      remove: (session, name) => SessionResourceOwner.id(db, session.id).pipe(Effect.flatMap((ownerID) => locks.withLock(ownerID)(Effect.gen(function* () {
        yield* db.delete(SessionPluginTable).where(and(
          eq(SessionPluginTable.session_id, ownerID), eq(SessionPluginTable.name, name),
        )).run().pipe(Effect.orDie)
        yield* invalidate(ownerID)
      })))),
      clear: (session) => SessionResourceOwner.id(db, session.id).pipe(Effect.flatMap((ownerID) => locks.withLock(ownerID)(Effect.gen(function* () {
        yield* db.delete(SessionPluginTable).where(eq(SessionPluginTable.session_id, ownerID)).run().pipe(Effect.orDie)
        yield* invalidate(ownerID)
      })))),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, SandboxProvider.node, PluginHooks.node, SessionStore.node] })
