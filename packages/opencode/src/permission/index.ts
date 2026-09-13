import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { InstanceState } from "@/effect/instance-state"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Layer, Context, Schedule } from "effect"
import os from "os"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionPluginRuntime } from "@/plugin/session-plugin-runtime"
import { insertExecLog } from "@/session/exec-log"
import { HitlStore } from "@/hitl/store"

// Per-process instance identifier for hitl_request.owner_id.
const hitlOwnerID = crypto.randomUUID()
const HITL_POLL_INTERVAL_MS = 1_000
const HITL_RENEW_EVERY_TICKS = 30

export const Event = PermissionV1.Event

export interface Interface {
  readonly ask: (input: PermissionV1.AskInput) => Effect.Effect<void, PermissionV1.Error>
  readonly reply: (input: PermissionV1.ReplyInput) => Effect.Effect<void, PermissionV1.NotFoundError>
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
  return Effect.promise(() =>
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
        void ctx
        const state = {
          pending: new Map<PermissionV1.ID, PendingEntry>(),
          approved: [],
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new PermissionV1.RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    // HITL polling: check PG for cross-instance replies; every N ticks renew lease.
    const startHitlPolling = Effect.fn("Permission.hitlPoll")(function* () {
      if (!HitlStore.enabled()) return
      let tick = 0
      yield* Effect.gen(function* () {
        const pending = (yield* InstanceState.get(state)).pending
        const ids = Array.from(pending.keys(), (id) => id as string)

        const changed = yield* Effect.tryPromise({
          try: () => HitlStore.changed(ids),
          catch: (error) => new Error(`hitl poll failed: ${String(error)}`),
        }).pipe(Effect.catchCause(() => Effect.succeed([] as HitlStore.Row[])))

        for (const row of changed) {
          const entry = pending.get(row.id as PermissionV1.ID)
          if (entry === undefined) continue
          pending.delete(row.id as PermissionV1.ID)
          if (row.status === "replied") {
            yield* Deferred.succeed(entry.deferred, undefined)
          } else {
            yield* Deferred.fail(entry.deferred, new PermissionV1.RejectedError())
          }
        }

        tick += 1
        if (tick % HITL_RENEW_EVERY_TICKS === 0 && ids.length > 0) {
          yield* Effect.tryPromise({
            try: () => HitlStore.renewLease(ids, Date.now() + HitlStore.LEASE_TTL_MS),
            catch: () => new Error("lease renew failed"),
          }).pipe(Effect.catchCause(() => Effect.void))
        }
      }).pipe(
        Effect.repeat(Schedule.spaced(HITL_POLL_INTERVAL_MS)),
        Effect.catchCause(() => Effect.void),
        Effect.forkScoped,
      )
    })

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

      // HITL: PG insert (fail fast — PG unavailable means the tool errors rather than producing an invisible pending).
      if (HitlStore.enabled()) {
        const directory = yield* InstanceState.directory
        yield* Effect.tryPromise({
          try: () =>
            HitlStore.insertPending({
              id: id as string,
              kind: "permission",
              directory,
              sessionID: request.sessionID as string,
              ownerID: hitlOwnerID,
              payload: info as unknown as Record<string, unknown>,
              leaseUntil: Date.now() + HitlStore.LEASE_TTL_MS,
            }),
          catch: (error) => new Error(`hitl insert failed: ${String(error)}`),
        }).pipe(Effect.orDie)
      }

      const deferred = yield* Deferred.make<void, PermissionV1.RejectedError | PermissionV1.CorrectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)
      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.gen(function* () {
          pending.delete(id)
          if (HitlStore.enabled()) {
            yield* Effect.tryPromise({
              try: () =>
                HitlStore.casTransition(id as string, "permission", {
                  status: "closed",
                  closeReason: "answered-delivered",
                }),
              catch: () => new Error("hitl defensive close failed"),
            }).pipe(Effect.catchCause(() => Effect.void))
          }
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: PermissionV1.ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)

      // HITL: CAS the PG row first; cross-instance replies succeed here and
      // the owning instance's polling fiber resolves the deferred.
      if (HitlStore.enabled()) {
        const transition: HitlStore.Transition =
          input.reply === "reject"
            ? { status: "rejected" as const }
            : { status: "replied" as const, result: { reply: input.reply } }
        const outcome = yield* Effect.tryPromise({
          try: () => HitlStore.casTransition(input.requestID as string, "permission", transition),
          catch: (error) => new Error(`hitl reply cas failed: ${String(error)}`),
        }).pipe(Effect.orDie)
        if (outcome.updated !== undefined || outcome.current !== undefined) {
          if (existing !== undefined) {
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
            } else {
              yield* Deferred.succeed(existing.deferred, undefined)
            }
          }
          return
        }
        if (existing === undefined) {
          return yield* new PermissionV1.NotFoundError({ requestID: input.requestID })
        }
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
        }).pipe(Effect.catchCause(() => Effect.succeed([] as HitlStore.Row[])))
        return rows.map((row) => row.payload as unknown as PermissionV1.Request)
      }
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    // Start HITL polling within the instance scope.
    yield* startHitlPolling()

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
