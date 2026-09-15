import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Cause, Deferred, Effect, Layer, Context, Schedule, Schema } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPluginRuntime } from "@/plugin/session-plugin-runtime"
import { insertExecLog } from "@/session/exec-log"
import { HitlStore } from "@/hitl/store"
import { HitlSalvage } from "@/hitl/salvage"
import { Flag } from "@/flag/flag"
import { Database } from "@/storage/db"
import { SessionTable } from "@/session/session.pg"
import { eq, sql } from "drizzle-orm"

// Per-process instance identifier for hitl_request.owner_id.
const hitlOwnerID = crypto.randomUUID()
const HITL_POLL_INTERVAL_MS = 1_000
const HITL_RENEW_EVERY_TICKS = 30

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError | ConflictError>
  readonly list: () => Effect.Effect<ReadonlyArray<PermissionV1.Request>>
}

interface PendingEntry {
  info: PermissionV1.Request
  deferred: Deferred.Deferred<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>
}

interface State {
  pending: Map<PermissionV1.ID, PendingEntry>
  approved: PermissionV1.Rule[]
}

export function evaluate(permission: string, pattern: string, ...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Permission.ConflictError", {
  requestID: PermissionV1.ID,
  status: Schema.String,
  closeReason: Schema.optional(Schema.String),
}) {}

// Metadata is arbitrary tool input and may contain circular references or
// bigints, either of which makes JSON.stringify throw. Preserve the
// identifying fields and degrade only the unserializable parts.
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint") return item.toString()
      if (typeof item === "object" && item !== null) {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    })
  } catch {
    return "{}"
  }
}

function recordDenial(request: Omit<PermissionV1.AskInput, "ruleset">, rule: string) {
  return Effect.promise(
    () =>
      insertExecLog({
        // Date.now() alone collides when multiple asks are denied in the same
        // millisecond; the random suffix keeps concurrent denials distinct.
        id: `deny-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        session_id: request.sessionID,
        command: safeStringify({
          permission: request.permission,
          patterns: request.patterns,
          tool: request.tool,
          metadata: request.metadata,
        }),
        status: "denied",
        rule,
        source: "permission-deny",
        time_started: Date.now(),
        time_finished: Date.now(),
      }),
    // Audit must never break the deny path. `Effect.catch` would miss a defect
    // (e.g. a synchronous throw while building the row), so catch the whole cause.
  ).pipe(Effect.catchCause(() => Effect.void))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessionPlugins = yield* SessionPluginRuntime.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const value = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [] as PermissionV1.Rule[],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of value.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            value.pending.clear()
          }),
        )

        if (HitlStore.enabled()) {
          let tick = 0
          const poll = Effect.gen(function* () {
            const ids = Array.from(value.pending.keys(), (id) => id as string)
            const changed = yield* Effect.tryPromise({
              try: () => HitlStore.changed(ids, hitlOwnerID, ctx.directory),
              catch: (error) => new Error(`hitl poll failed: ${String(error)}`),
            })

            let consumed = 0
            for (const row of changed) {
              const entry = value.pending.get(row.id as PermissionV1.ID)
              if (entry === undefined) continue
              value.pending.delete(row.id as PermissionV1.ID)
              consumed += 1
              const reply = row.result?.["reply"]
              if (row.status === "replied" && (reply === "once" || reply === "always")) {
                if (reply === "always") {
                  value.approved.push(
                    ...entry.info.always.map((pattern) => ({
                      permission: entry.info.permission,
                      pattern,
                      action: "allow" as const,
                    })),
                  )
                }
                yield* Deferred.succeed(entry.deferred, undefined)
                continue
              }
              const message = row.result?.["message"]
              yield* Deferred.fail(
                entry.deferred,
                typeof message === "string"
                  ? new PermissionV1.CorrectedError({ feedback: message })
                  : new PermissionV1.RejectedError(),
              )
            }
            if (consumed > 0) (yield* Effect.currentSpan).attribute("hitl.remote_consumed", consumed)

            tick += 1
            if (tick % HITL_RENEW_EVERY_TICKS !== 0) return
            yield* Effect.tryPromise({
              try: () => HitlStore.renewLease(ids, hitlOwnerID, ctx.directory),
              catch: (error) => new Error(`hitl lease renewal failed: ${String(error)}`),
            })
            yield* HitlSalvage.sweepKind(events, "permission", ctx.directory)
          }).pipe(
            Effect.withSpan("permission.hitlPoll", { attributes: { directory: ctx.directory } }),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) =>
                Effect.logError("permission HITL polling failed", { directory: ctx.directory, cause: String(cause) }),
            ),
          )
          yield* poll.pipe(Effect.repeat(Schedule.spaced(HITL_POLL_INTERVAL_MS)), Effect.forkScoped)
        }

        return value
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: PermissionV1.AskInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const { ruleset, ...request } = input
      let needsAsk = false

      for (const pattern of request.patterns) {
        const rule = evaluate(request.permission, pattern, ruleset, approved)
        yield* Effect.logInfo("evaluated", { permission: request.permission, pattern, action: rule })
        if (rule.action === "deny") {
          yield* recordDenial(request, `${request.permission}: ${rule.pattern}`)
          return yield* new PermissionV1.DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        if (rule.action === "allow") continue
        needsAsk = true
      }

      if (!needsAsk) return

      const decision = yield* (yield* sessionPlugins.acquire(request.sessionID)).trigger("permission.ask", request, {
        status: "ask",
      } as { status: "ask" | "deny" | "allow" })
      if (decision.status === "allow") return
      if (decision.status === "deny") {
        yield* recordDenial(request, `${request.permission}: plugin`)
        return yield* new PermissionV1.DeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
        })
      }

      const id = request.id ?? PermissionV1.ID.ascending()
      const info: PermissionV1.Request = {
        id,
        sessionID: request.sessionID,
        permission: request.permission,
        patterns: request.patterns,
        metadata: request.metadata,
        always: request.always,
        tool: request.tool,
      }
      yield* Effect.logInfo("asking", { id, permission: info.permission, patterns: info.patterns })

      const sessionPending = Array.from(pending.values(), (item) => item.info.sessionID).filter(
        (sessionID) => sessionID === request.sessionID,
      ).length
      if (sessionPending >= Flag.OPENCODE_HITL_MAX_PENDING_PER_SESSION) {
        return yield* Effect.die(new Error(`Too many pending HITL requests for session ${request.sessionID}`))
      }

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      return yield* Effect.gen(function* () {
        // Register locally BEFORE the PG row becomes visible: replies and
        // same-session cascades resolve deferreds through this map, so a PG
        // row must never be observable before its local entry exists.
        pending.set(id, { info, deferred })
        if (HitlStore.enabled()) {
          const directory = yield* InstanceState.directory
          const inserted = yield* Effect.tryPromise({
            try: () =>
              HitlStore.insertPendingLimited(
                {
                  id: id as string,
                  kind: "permission",
                  directory,
                  sessionID: request.sessionID as string,
                  ownerID: hitlOwnerID,
                  payload: info as unknown as Record<string, unknown>,
                },
                Flag.OPENCODE_HITL_MAX_PENDING_PER_SESSION,
              ),
            catch: (error) => new Error(`hitl insert failed: ${String(error)}`),
          }).pipe(Effect.orDie)
          if (!inserted) {
            return yield* Effect.die(new Error(`Too many pending permission requests for session ${request.sessionID}`))
          }
        }
        yield* events.publish(Event.Asked, info)
        return yield* Deferred.await(deferred)
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pending.delete(id)
          }),
        ),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)

      // HITL: CAS the PG row first; cross-instance replies succeed here and
      // the owning instance's polling fiber resolves the deferred.
      if (HitlStore.enabled()) {
        const directory = yield* InstanceState.directory
        const transition: HitlStore.Transition =
          input.reply === "reject"
            ? {
                status: "rejected" as const,
                result: { reply: "reject", ...(input.message === undefined ? {} : { message: input.message }) },
              }
            : { status: "replied" as const, result: { reply: input.reply } }
        const result = yield* Effect.tryPromise({
          try: () =>
            Database.transaction(async (db) => {
              const outcome = await HitlStore.casTransition(
                input.requestID as string,
                "permission",
                directory,
                transition,
              )
              if (outcome.updated === undefined) return { outcome, cascaded: [] as HitlStore.Row[] }

              const request = outcome.updated.payload as unknown as PermissionV1.Request
              await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`hitl:${directory}:${request.sessionID}`}))`)
              const cascade: HitlStore.Row[] = []
              if (input.reply === "always") {
                const additions = request.always.map((pattern) => ({
                  permission: request.permission,
                  pattern,
                  action: "allow" as const,
                }))
                const session = await db
                  .select({ permission: SessionTable.permission })
                  .from(SessionTable)
                  .where(eq(SessionTable.id, request.sessionID))
                  .limit(1)
                  .get()
                const rules = [...(session?.permission ?? []), ...additions]
                await db
                  .update(SessionTable)
                  .set({ permission: rules, time_updated: Date.now() })
                  .where(eq(SessionTable.id, request.sessionID))
                  .run()
                for (const row of await HitlStore.listSessionPending("permission", directory, request.sessionID)) {
                  const item = row.payload as unknown as PermissionV1.Request
                  const allowed = item.patterns.every(
                    (pattern) => evaluate(item.permission, pattern, rules).action === "allow",
                  )
                  if (!allowed) continue
                  const next = await HitlStore.casTransition(row.id, "permission", directory, {
                    status: "replied",
                    result: { reply: "always", causedBy: input.requestID },
                  })
                  if (next.updated !== undefined) cascade.push(next.updated)
                }
              }
              if (input.reply === "reject") {
                for (const row of await HitlStore.listSessionPending("permission", directory, request.sessionID)) {
                  const next = await HitlStore.casTransition(row.id, "permission", directory, {
                    status: "rejected",
                    result: { reply: "reject", causedBy: input.requestID },
                  })
                  if (next.updated !== undefined) cascade.push(next.updated)
                }
              }
              return { outcome, cascaded: cascade }
            }),
          catch: (error) => new Error(`hitl reply cas failed: ${String(error)}`),
        }).pipe(Effect.orDie)
        const row = result.outcome.updated ?? result.outcome.current
        if (row === undefined) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
        if (result.outcome.current !== undefined && !HitlStore.sameTransition(result.outcome.current, transition)) {
          return yield* new ConflictError({
            requestID: input.requestID,
            status: result.outcome.current.status,
            closeReason: result.outcome.current.close_reason ?? undefined,
          })
        }

        const changed = result.outcome.updated === undefined ? [] : [row, ...result.cascaded]
        for (const item of changed) {
          const request = item.payload as unknown as PermissionV1.Request
          const reply = item.result?.["reply"]
          yield* events.publish(Event.Replied, {
            sessionID: request.sessionID,
            requestID: request.id,
            reply: reply === "once" ? "once" : reply === "always" ? "always" : "reject",
          })
        }

        for (const item of result.outcome.updated === undefined ? [row] : [row, ...result.cascaded]) {
          const local = pending.get(item.id as PermissionV1.ID)
          if (local === undefined) continue
          pending.delete(item.id as PermissionV1.ID)
          const reply = item.result?.["reply"]
          if (reply === "reject" || item.status === "rejected") {
            const message = item.result?.["message"]
            yield* Deferred.fail(
              local.deferred,
              typeof message === "string"
                ? new PermissionV1.CorrectedError({ feedback: message })
                : new PermissionV1.RejectedError(),
            )
            continue
          }
          if (item.id === row.id && reply === "always") {
            approved.push(
              ...local.info.always.map((pattern) => ({
                permission: local.info.permission,
                pattern,
                action: "allow" as const,
              })),
            )
          }
          yield* Deferred.succeed(local.deferred, undefined)
        }
        return
      }

      if (!existing) return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })

      pending.delete(input.requestID)
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message
            ? new PermissionV1.CorrectedError({ feedback: input.message })
            : new PermissionV1.RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* events.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* events.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      if (HitlStore.enabled()) {
        const directory = yield* InstanceState.directory
        const rows = yield* Effect.tryPromise({
          try: () => HitlStore.listPending("permission", directory),
          catch: (error) => new Error(`hitl list failed: ${String(error)}`),
        }).pipe(
          Effect.tapError((error) =>
            Effect.logError("permission HITL list failed", { directory, error: String(error) }),
          ),
          Effect.orDie,
        )
        return rows.map((row) => row.payload as unknown as PermissionV1.Request)
      }
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    return Service.of({ ask, reply, list })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermissionV1.Info) {
  const ruleset: PermissionV1.Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: PermissionV1.Ruleset[]): PermissionV1.Rule[] {
  return rulesets.flat()
}

export function disabled(tools: string[], ruleset: PermissionV1.Ruleset): Set<string> {
  const edits = ["edit", "write", "apply_patch"]
  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]
  return new Set(
    tools.filter((tool) => {
      const permission = edits.includes(tool) ? "edit" : reads.includes(tool) ? "read" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}

export function visibleTools<T>(tools: Record<string, T>, ruleset: PermissionV1.Ruleset): Record<string, T> {
  const hidden = disabled(Object.keys(tools), ruleset)
  return Object.fromEntries(Object.entries(tools).filter(([name]) => !hidden.has(name)))
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [EventV2Bridge.node, SessionPluginRuntime.node],
})

export * as Permission from "."
