export * as Permission from "./permission.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Permission } from "@opencode/schema/permission"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Wildcard } from "./util/wildcard.js"
import { SessionEvent } from "@opencode/schema/session-event"
import type { SessionMessage } from "@opencode/schema/session-message"
import { PermissionSaved } from "./permission/saved.js"
import { Hitl } from "./hitl/index.js"
import { recordDenial } from "./exec-log/index.js"
import { PluginHooks } from "./plugin/hooks.js"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset } from "@opencode/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  agent: Agent.ID.pipe(Schema.optional),
}).annotate({ identifier: "Permission.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  /** Acting user; when present a mismatched owner reads as not-found (v1 cross-tenant guard). */
  userID: Schema.optional(Schema.String),
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Permission.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "Permission.AskResult" })
export type AskResult = typeof AskResult.Type

export { Event } from "@opencode/schema/permission"

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID, userID?: string) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: (userID?: string) => Effect.Effect<ReadonlyArray<Request>>
  /**
   * Drops this session's pending asks. `closeReason` settles the persisted rows
   * (abort sweep: instance-restart); omitting it only clears memory because the
   * caller deletes the rows itself (session removal: FK cascade).
   */
  readonly cancelBySession: (sessionID: SessionSchema.ID, closeReason?: "instance-restart" | "shutdown") => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  /** Owning user recorded at ask time; used to scope list/reply without touching the public Request shape. */
  readonly userID: string
  /**
   * Restored by boot recovery rather than created by this instance. Recovered
   * asks are not renewed: their original owner is gone, so they must reach the
   * lease sweep that ends the dangling tool call (v1 restart semantics).
   */
  readonly recovered: boolean
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

/** Rebuild a permission Request from a persisted hitl_request row; malformed rows yield undefined. */
function requestFromRow(row: Hitl.Row): { readonly request: Request; readonly userID: string } | undefined {
  const raw: unknown = row.payload
  const payload = typeof raw === "string" ? tryParse(raw) : raw
  if (payload === null || typeof payload !== "object") return undefined
  const action = (payload as { action?: unknown }).action
  const resources = (payload as { resources?: unknown }).resources
  if (typeof action !== "string" || !Array.isArray(resources)) return undefined
  return {
    request: {
      id: row.id as ID,
      sessionID: row.session_id as SessionSchema.ID,
      action,
      resources: resources as Array<string>,
      save: Array.isArray((payload as { save?: unknown }).save) ? (payload as { save: Array<string> }).save : undefined,
      metadata: (payload as { metadata?: Record<string, unknown> | null }).metadata ?? undefined,
      source: (payload as { source?: Request["source"] | null }).source ?? undefined,
      message: (payload as { message?: string | null }).message ?? undefined,
    },
    userID: row.user_id,
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const ownerId = Hitl.ownerID()
    const pending = new Map<ID, Pending>()
    let closed = false
    // Delivers a terminal tool result for an ask its run never settled:
    // replied backfills the submitted decision, rejected/pending close with an
    // explicit reason. The terminal event only moves `running` parts, so a run
    // that already settled its part makes this a safe no-op.
    const backfill = Effect.fnUntraced(function* (action: Hitl.SweepAction) {
      const base = {
        sessionID: action.sessionID as SessionSchema.ID,
        assistantMessageID: action.messageID as SessionMessage.ID,
        id: action.toolID,
        executed: true,
        metadata: { hitl: { salvaged: true, requestID: action.id } },
      }
      if (action.status === "replied") {
        yield* bus.publish(SessionEvent.Tool.Success, {
          ...base,
          content: [{ type: "text" as const, text: action.answer ?? "The user approved this action." }],
        })
        yield* Hitl.markBackfilled(action.id)
        return
      }
      yield* bus.publish(SessionEvent.Tool.Failed, {
        ...base,
        error: {
          type: action.status === "rejected" ? "permission.declined" : "instance-restart",
          message: action.status === "rejected" ? "The user declined this action." : "实例重启，审批未处理",
        },
      })
      if (action.status === "pending") yield* Hitl.markSwept(action.id, "closed", "instance-restart")
    })

    // SaaS restart recovery: rebuild still-pending permission asks from the
    // hitl_request table (kind=permission). Malformed rows are skipped; the
    // recovery must never fail the layer.
    {
      const rows = yield* Hitl.listPending({ kind: "permission", directory: location.directory })
      for (const row of rows ?? []) {
        const rebuilt = requestFromRow(row)
        if (rebuilt === undefined) continue
        pending.set(rebuilt.request.id, {
          request: rebuilt.request,
          userID: rebuilt.userID,
          recovered: true,
          deferred: Deferred.makeUnsafe<void, DeclinedError | CorrectedError>(),
        })
      }
      // SaaS: answers submitted before the previous holder died never reached
      // their run; deliver them now so a resumed run reads the user's answer
      // instead of a dangling tool call (v1's answered-lost salvage). A bad row
      // must never fail the layer, same as recovery.
      yield* Effect.forEach(yield* Hitl.backfillables("permission"), (action) => backfill(action), {
        discard: true,
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("hitl permission backfill failed", cause)))
      yield* Hitl.closeExpired()
    }

    // SaaS: keep live asks leased so another instance's boot cleanup cannot
    // reclaim them as instance-restart while this holder is still waiting.
    yield* Effect.forkScoped(
      Hitl.renewal(() =>
        Effect.sync(() =>
          Array.from(pending.values())
            .filter((item) => !item.recovered)
            .map((item) => item.request.id),
        ),
      ),
    )

    // SaaS: end dangling asks whose owner died, so the model sees a terminal
    // tool result instead of a tool call that never resolves (v1's salvage):
    // pending -> failed(instance-restart); replied -> success(answer backfill);
    // rejected -> failed(declined). Terminal events only move `running` parts,
    // so re-publishing is a safe CAS, and a live owner keeps its lease fresh.
    // A reply settled from outside this graph (PG fallback above, or another
    // instance) leaves the borrowed run waiting forever. Reconcile local
    // pendings against the persisted rows each tick and wake them.
    const reconcile = Effect.gen(function* () {
      for (const [id, item] of Array.from(pending.entries())) {
        const row = yield* Hitl.row(id)
        if (row === undefined) continue
        if (row.status === "replied") {
          pending.delete(id)
          yield* bus.publish(Permission.Event.Replied, { sessionID: item.request.sessionID, requestID: id, reply: "once" })
          yield* Deferred.succeed(item.deferred, undefined).pipe(Effect.ignore)
          continue
        }
        if (row.status === "rejected") {
          pending.delete(id)
          yield* bus.publish(Permission.Event.Replied, { sessionID: item.request.sessionID, requestID: id, reply: "reject" })
          yield* Deferred.fail(item.deferred, new DeclinedError()).pipe(Effect.ignore)
          continue
        }
        if (row.status === "closed") {
          pending.delete(id)
          yield* Deferred.fail(item.deferred, new DeclinedError()).pipe(Effect.ignore)
        }
      }
    }).pipe((effect) => Hitl.loopTick(effect, "hitl permission reconcile failed"))

    const sweep = Effect.gen(function* () {
      yield* reconcile
      for (const action of yield* Hitl.sweepables("permission")) {
        // The recovered entry may live in this instance's map; drop it with its
        // pending row so the list stops offering a swept ask.
        const local = pending.get(action.id as ID)
        if (local) {
          pending.delete(action.id as ID)
          yield* Deferred.fail(local.deferred, new DeclinedError()).pipe(Effect.ignore)
        }
        yield* backfill(action)
      }
    }).pipe((effect) => Hitl.loopTick(effect, "hitl permission sweep failed"))
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(Hitl.LEASE_RENEW_MS).pipe(Effect.andThen(sweep))),
    )

    const close = Effect.gen(function* () {
      // SaaS: the shutdown sweep keeps hitl_request rows pending; the next
      // boot's recovery pass re-creates them.
      closed = true
      yield* Effect.forEach(Array.from(pending.values()), (item) =>
        bus
          .publish(Permission.Event.Replied, {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply: "reject",
          })
          .pipe(Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError()))),
      )
      pending.clear()
    }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() => close)

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return merge(agent?.permissions ?? missingAgentPermissions, session.permissions ?? [])
    })

    function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = effects.includes("ask") ? "ask" : "allow"
      const event = yield* hooks.trigger("permission", "evaluate", {
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: input.resources,
        metadata: input.metadata,
        source: input.source,
        effect,
      })
      return { effect: event.effect, message: event.message, rules: all }
    })

    function request(input: AssertInput, message?: string): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        save: input.save,
        metadata: input.metadata,
        source: input.source,
        message,
      }
    }

    const create = (request: Request, agent: Agent.ID | undefined, userID: string) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, userID, recovered: false, deferred }
          if (closed) {
            yield* Deferred.fail(deferred, new DeclinedError())
            return item
          }
          if (pending.has(request.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          pending.set(request.id, item)
          // SaaS: mirror pending permission asks into hitl_request (kind=permission).
          yield* Hitl.insertPending({
            id: request.id,
            kind: "permission",
            directory: location.directory,
            sessionID: request.sessionID,
            userID,
            ownerID: ownerId,
            payload: {
              action: request.action,
              resources: request.resources,
              save: request.save ?? null,
              metadata: request.metadata ?? null,
              source: request.source ?? null,
              message: request.message ?? null,
            },
          })
          yield* bus
            .publish(Permission.Event.Asked, request)
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      const result = yield* evaluateInput(input)
      const value = request(input, result.message)
      if (result.effect === "ask") {
        // Identity travels on the requesting user message metadata (v1 parity),
        // so a bare HTTP reply can be scoped to the asking user.
        const messages = yield* sessions.context(input.sessionID).pipe(Effect.orElseSucceed(() => []))
        yield* create(value, input.agent, Hitl.userIDFromMessages(messages))
      }
      return { id: value.id, effect: result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.die(new DeclinedError())
        const result = yield* evaluateInput(input)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (result.effect === "deny") {
              // SaaS: a deny is a silent, model-invisible decision, so the audit
              // trail is the only record (v1's recordDenial -> exec_log).
              const matched = relevant(input, result.rules)
              yield* recordDenial({
                sessionID: input.sessionID,
                permission: input.action,
                patterns: input.resources,
                tool:
                  input.source?.type === "tool"
                    ? { messageID: input.source.messageID, callID: input.source.id }
                    : null,
                metadata: input.metadata ?? null,
                rule: matched.map((rule) => `${rule.action}: ${rule.resource}`).join(", "),
              })
              return yield* new BlockedError({
                rules: matched,
                permission: input.action,
                resources: input.resources,
                reason: result.message,
              })
            }
            if (result.effect === "allow") return
            const messages = yield* sessions.context(input.sessionID).pipe(Effect.orElseSucceed(() => []))
            const item = yield* create(request(input, result.message), input.agent, Hitl.userIDFromMessages(messages))
            return yield* restore(Deferred.await(item.deferred)).pipe(
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              // Any exit — including an interruption abandoning the ask — drops
              // the in-memory entry and closes the mirrored row so a pending
              // list never offers an ask nobody is waiting for anymore.
              Effect.ensuring(
                Effect.gen(function* () {
                  pending.delete(item.request.id)
                  yield* Hitl.settle(item.request.id, { status: "closed", closeReason: "shutdown" })
                }),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(item.request.id)
                }),
              ),
            )
          }),
        )
      }),
    )

    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) {
            // The ask may live in a graph this instance cannot reach (an idle
            // eviction detached it while its run still borrows it). Settle the
            // persisted row anyway; the holder's reconcile pass wakes its run.
            const row = yield* Hitl.row(input.requestID)
            if (row === undefined || row.status !== "pending" || row.kind !== "permission")
              return yield* new NotFoundError({ requestID: input.requestID })
            if (input.userID !== undefined && row.user_id !== input.userID)
              return yield* new NotFoundError({ requestID: input.requestID })
            yield* Hitl.settle(input.requestID, {
              status: input.reply === "reject" ? "rejected" : "replied",
              result: { reply: input.reply, ...(input.message === undefined ? {} : { message: input.message }) },
              closeReason: input.reply === "reject" ? "decision-delivered" : "answered-delivered",
              ...(input.userID === undefined ? {} : { userID: input.userID }),
            })
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: row.session_id as SessionSchema.ID,
              requestID: input.requestID,
              reply: input.reply,
            })
            return
          }
          // A mismatched owner reads as not-found: cross-tenant submits must not
          // reveal (or settle) another user's pending ask (v1 guard).
          if (input.userID !== undefined && existing.userID !== input.userID)
            return yield* new NotFoundError({ requestID: input.requestID })
          yield* Hitl.settle(input.requestID, {
            status: input.reply === "reject" ? "rejected" : "replied",
            result: { reply: input.reply, ...(input.message === undefined ? {} : { message: input.message }) },
            closeReason: input.reply === "reject" ? "decision-delivered" : "answered-delivered",
            ...(input.userID === undefined ? {} : { userID: input.userID }),
          })
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              yield* Deferred.fail(item.deferred, new DeclinedError())
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          for (const [id, item] of pending) {
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            if (result?.effect !== "allow") continue
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    // Live pendings sit in the Location instance whose sandbox the run used,
    // which is not necessarily the instance answering a directory-scoped list
    // request. Merge in the persisted pending rows so approval centers see
    // every outstanding ask across sessions and instances (v1 semantics).
    const persisted = Effect.fnUntraced(function* (userID?: string) {
      const rows = yield* Hitl.listPending({ kind: "permission", directory: location.directory, userID })
      return (rows ?? []).flatMap((row) => {
        const rebuilt = requestFromRow(row)
        return rebuilt === undefined ? [] : [rebuilt.request]
      })
    })

    const mergeRequests = (local: ReadonlyArray<Request>, rows: ReadonlyArray<Request>) => {
      const seen = new Set(local.map((request) => request.id))
      return [...local, ...rows.filter((request) => !seen.has(request.id))]
    }

    const list = Effect.fn("Permission.list")(function* (userID?: string) {
      // Reconcile against persisted terminal rows: an entry settled elsewhere
      // (another instance's sweep) stops being offered even though this map
      // still holds it. Absent rows are kept — a cascade delete or a host
      // without persistence is not evidence the ask was answered.
      const settled = yield* Hitl.settledIds("permission", location.directory)
      const dropped = settled === undefined ? undefined : new Set(settled)
      const local = Array.from(pending.values())
        .filter((item) => userID === undefined || item.userID === userID)
        .filter((item) => dropped === undefined || !dropped.has(item.request.id))
        .map((item) => item.request)
      return mergeRequests(local, yield* persisted(userID))
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID, userID?: string) {
      const local = Array.from(pending.values())
        .filter((item) => item.request.sessionID === sessionID)
        .filter((item) => userID === undefined || item.userID === userID)
        .map((item) => item.request)
      const rows = (yield* persisted(userID)).filter((request) => request.sessionID === sessionID)
      return mergeRequests(local, rows)
    })

    // SaaS: session removal sweeps its still-pending permission asks. The
    // deferred failure unblocks any suspended run so it can wind down; the
    // hitl_request rows themselves are deleted by the caller (v1's FK cascade).
    const cancelBySession = Effect.fn("Permission.cancelBySession")(function* (
      sessionID: SessionSchema.ID,
      closeReason?: "instance-restart" | "shutdown",
    ) {
      // A session's live run may borrow a detached older graph (idle eviction
      // keeps the borrowed instance alive), so this instance's map is not
      // authoritative. Settle the persisted rows first, then mirror locally.
      if (closeReason !== undefined) {
        const rows = yield* Hitl.listPending({ kind: "permission", directory: location.directory })
        for (const row of rows ?? []) {
          if (row.session_id !== sessionID) continue
          yield* Hitl.settle(row.id, { status: "closed", closeReason })
        }
      }
      for (const [id, item] of Array.from(pending.entries())) {
        if (item.request.sessionID !== sessionID) continue
        pending.delete(id)
        if (closeReason !== undefined) yield* Hitl.settle(id, { status: "closed", closeReason })
        yield* bus.publish(Permission.Event.Replied, { sessionID, requestID: id, reply: "reject" }).pipe(
          Effect.andThen(Deferred.fail(item.deferred, new DeclinedError())),
          Effect.orDie,
        )
      }
    })

    return Service.of({ ask, assert, reply, get, forSession, list, cancelBySession, close })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, Agent.node, SessionStore.node, PermissionSaved.node, PluginHooks.node],
})
