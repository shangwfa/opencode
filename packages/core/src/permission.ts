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
import { SessionAgents } from "./session/agents.js"
import { Wildcard } from "./util/wildcard.js"
import { PermissionSaved } from "./permission/saved.js"
import { SessionPermissionApproval } from "./permission/session-approval.js"
import { Database } from "./database/database.js"
import { HitlLedger } from "./hitl/ledger.js"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionTurnPermissions } from "./session/turn-permissions.js"

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
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError | BlockedError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  /**
   * Waits for a request's decision, reviving it from the durable ledger when
   * this process does not hold it (recovery after a restart, or a request
   * another pod created). Returns the decision with its optional feedback.
   */
  readonly awaitSettled: (
    id: ID,
  ) => Effect.Effect<{ readonly reply: Permission.Reply; readonly message?: string }, NotFoundError>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

interface Options {
  readonly approvalScope?: "session" | "project"
}

const DEFAULT_POLL_MS = 1_000
const pollIntervalMs = (() => {
  const value = Number(process.env["OPENCODE_HITL_POLL_MS"])
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_MS
})()

const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const location = yield* Location.Service
      const sessions = yield* SessionStore.Service
      const sessionAgents = yield* SessionAgents.Service
      const saved = yield* PermissionSaved.Service
      const approvals = yield* SessionPermissionApproval.Service
      const database = yield* Database.Service
      // PG is the SaaS execution plane. Keep local clients' legacy project
      // approvals unchanged; SaaS never consumes or writes those approvals.
      const sessionScoped =
        (options?.approvalScope ?? (database.dialect === "postgres" ? "session" : "project")) === "session"
      const hooks = yield* PluginHooks.Service
      // Durable HITL ledger on PostgreSQL: pending requests survive process
      // death and any pod may settle them; SQLite stays memory-only.
      const ledger = database.dialect === "postgres" ? HitlLedger.make(database.db) : undefined
      const scope = yield* Effect.scope
      const pending = new Map<ID, Pending>()
      let closed = false

      const close = Effect.gen(function* () {
        closed = true
        yield* Effect.forEach(Array.from(pending.values()), (item) =>
          ledger
            ? // Process teardown keeps durable requests pending for the next
              // owner: fail only the local waiter, publish no user reject.
              Deferred.fail(item.deferred, new DeclinedError()).pipe(Effect.asVoid)
            : bus
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

      const savedRules = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
        if (sessionScoped) {
          return (yield* approvals.list(sessionID)).map(
            (item): Permission.Rule => ({ action: item.action, resource: item.resource, effect: "allow" }),
          )
        }
        return (yield* saved.list({ projectID: location.project.id })).map(
          (item): Permission.Rule => ({
            action: item.action,
            resource: item.resource,
            effect: "allow",
          }),
        )
      })

      const configured = Effect.fnUntraced(function* (
        sessionID: SessionSchema.ID,
        agentID?: Agent.ID,
        assistantMessageID?: string,
      ) {
        const session = yield* sessions.get(sessionID)
        if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
        if (assistantMessageID) {
          const assistant = yield* sessions.message(SessionMessage.ID.make(assistantMessageID))
          if (assistant?.sessionID === sessionID && assistant.message.type === "assistant") {
            const promptMessageID = assistant.message.promptMessageID
            if (promptMessageID) {
              const prompt = yield* sessions.message(promptMessageID)
              if (prompt?.sessionID === sessionID) {
                const turnRules = SessionTurnPermissions.resolve(prompt.message)
                // Prompt-scoped rules are exclusive for this turn. An unset prompt policy
                // retains the existing Agent/Session rules and saved approvals.
                if (turnRules !== undefined) return { rules: turnRules, turnScoped: true }
              }
            }
          }
        }
        const selected = yield* sessionAgents.select(session, agentID ?? session.agent)
        return {
          rules: merge(selected.info?.permissions ?? missingAgentPermissions, session.permissions ?? []),
          turnScoped: false,
        }
      })

      function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
        return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
      }

      function relevant(input: AssertInput, rules: Permission.Ruleset) {
        return rules.filter((rule) => Wildcard.match(input.action, rule.action))
      }

      const checkCurrentDeny = Effect.fn("Permission.checkCurrentDeny")(function* (input: AssertInput) {
        const policy = yield* configured(input.sessionID, input.agent, input.source?.messageID)
        if (denied(input, policy.rules)) {
          return yield* new BlockedError({
            rules: relevant(input, policy.rules),
            permission: input.action,
            resources: input.resources,
          })
        }
      })

      const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
        const configuredRules = yield* configured(input.sessionID, input.agent, input.source?.messageID)
        const rules = configuredRules.rules
        if (denied(input, rules)) return { effect: "deny" as const, rules }
        const savedApprovals = configuredRules.turnScoped ? [] : yield* savedRules(input.sessionID)
        const all = [...rules, ...savedApprovals]
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

      const create = (request: Request, agent?: Agent.ID) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
            const item = { request, agent, deferred }
            if (closed) {
              yield* Deferred.fail(deferred, new DeclinedError())
              return item
            }
            if (pending.has(request.id))
              return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
            pending.set(request.id, item)
            if (ledger) {
              yield* ledger
                .register({ id: request.id, kind: "permission", sessionID: request.sessionID, payload: request })
                .pipe(Effect.orDie)
            }
            yield* bus
              .publish(Permission.Event.Asked, request)
              .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
            return item
          }),
        )

      // Rebuilds a local pending entry from the durable ledger so any pod can
      // settle a request created elsewhere (or left by a dead owner).
      const restore = Effect.fnUntraced(function* (id: ID) {
        if (!ledger) return undefined
        const row = yield* ledger.get(id).pipe(Effect.orDie)
        if (!row || row.kind !== "permission" || row.decision !== "pending") return undefined
        const item: Pending = {
          request: row.payload as Request,
          deferred: yield* Deferred.make<void, DeclinedError | CorrectedError>(),
        }
        pending.set(id, item)
        return item
      })

      const awaitSettled = (
        id: ID,
      ): Effect.Effect<{ readonly reply: Permission.Reply; readonly message?: string }, NotFoundError> =>
        Effect.gen(function* () {
          const decisionOf = (row: HitlLedger.Row | undefined) => {
            if (!row || row.kind !== "permission" || row.decision === "pending") return undefined
            const payload = (row.result ?? {}) as { readonly reply?: Permission.Reply; readonly message?: string }
            return {
              reply: (row.decision === "rejected" ? "reject" : (payload.reply ?? "once")) as Permission.Reply,
              ...(payload.message === undefined ? {} : { message: payload.message }),
            }
          }
          let item = pending.get(id)
          if (!item) {
            if (!ledger) return yield* new NotFoundError({ requestID: id })
            const settled = decisionOf(yield* ledger.get(id).pipe(Effect.orDie))
            if (settled) return settled
            const restored = yield* restore(id)
            if (!restored) return yield* new NotFoundError({ requestID: id })
            item = restored
          }
          // The local waiter resolves through the owner-side poller (or the local
          // reply path); failures carry decline semantics and map to reject.
          const approved = yield* Deferred.await(item.deferred).pipe(
            Effect.as(true),
            Effect.catchTag("Permission.DeclinedError", () => Effect.succeed(false)),
            Effect.catchTag("Permission.CorrectedError", () => Effect.succeed(false)),
          )
          const settled = ledger ? decisionOf(yield* ledger.get(id).pipe(Effect.orDie)) : undefined
          if (settled) return settled
          return { reply: (approved ? "once" : "reject") as Permission.Reply }
        })

      // Owner-side consumption of decisions committed by another pod. The
      // settling pod published the public event; this only wakes local waiters
      // and applies the same-session cascade the local reply path performs.
      const consume = Effect.fnUntraced(function* (item: Pending, decision: "approved" | "rejected", result: unknown) {
        const payload = (result ?? {}) as { readonly reply?: Permission.Reply; readonly message?: string }
        pending.delete(item.request.id)
        if (decision === "rejected") {
          yield* Deferred.fail(
            item.deferred,
            payload.message ? new CorrectedError({ feedback: payload.message }) : new DeclinedError(),
          )
          // Reject cascades to the Session's other pending requests, matching
          // the local reply path.
          for (const [id, other] of pending) {
            if (other.request.sessionID !== item.request.sessionID) continue
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: other.request.sessionID,
              requestID: other.request.id,
              reply: "reject",
            })
            if (ledger)
              yield* ledger.decide(other.request.id, "rejected", { message: payload.message }).pipe(Effect.orDie)
            yield* Deferred.fail(other.deferred, new DeclinedError())
            pending.delete(id)
          }
          return
        }
        yield* Deferred.succeed(item.deferred, undefined)
        if (payload.reply !== "always" || !item.request.save?.length) return
        for (const [id, other] of pending) {
          if (sessionScoped && other.request.sessionID !== item.request.sessionID) continue
          const result = yield* evaluateInput({ ...other.request, agent: other.agent }).pipe(
            Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
          )
          if (result?.effect !== "allow") continue
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: other.request.sessionID,
            requestID: other.request.id,
            reply: "always",
          })
          if (ledger) yield* ledger.decide(other.request.id, "approved", { reply: "always" }).pipe(Effect.orDie)
          yield* Deferred.succeed(other.deferred, undefined)
          pending.delete(id)
        }
      })

      const pollLoop = Effect.gen(function* () {
        while (ledger) {
          yield* Effect.sleep(pollIntervalMs)
          if (pending.size === 0) continue
          const rows = yield* ledger.states([...pending.keys()]).pipe(Effect.orDie)
          for (const row of rows) {
            if (row.decision === "pending") continue
            const item = pending.get(row.id as ID)
            if (!item) continue
            if (row.decision === "approved") yield* consume(item, "approved", row.result)
            if (row.decision === "rejected") yield* consume(item, "rejected", row.result)
          }
        }
      })
      if (ledger) yield* pollLoop.pipe(Effect.forkIn(scope))

      const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
        if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
        const result = yield* evaluateInput(input)
        const value = request(input, result.message)
        if (result.effect === "ask") yield* create(value, input.agent)
        return { id: value.id, effect: result.effect }
      })

      const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
        Effect.gen(function* () {
          if (closed) return yield* Effect.die(new DeclinedError())
          const result = yield* evaluateInput(input)
          return yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              if (result.effect === "deny") {
                return yield* new BlockedError({
                  rules: relevant(input, result.rules),
                  permission: input.action,
                  resources: input.resources,
                  reason: result.message,
                })
              }
              if (result.effect === "allow") return
              const item = yield* create(request(input, result.message), input.agent)
              return yield* restore(Deferred.await(item.deferred)).pipe(
                Effect.andThen(sessionScoped ? checkCurrentDeny(input) : Effect.void),
                // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
                // must not convert a user's decline into model-facing tool output. The decline
                // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
                // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
                // it into ToolFailure and the model continues.
                Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
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
            let existing = pending.get(input.requestID)
            if (!existing) {
              const restored = yield* restore(input.requestID)
              if (!restored) return yield* new NotFoundError({ requestID: input.requestID })
              existing = restored
            }
            if (sessionScoped && input.reply !== "reject") {
              yield* checkCurrentDeny({ ...existing.request, agent: existing.agent }).pipe(
                Effect.catchTag("Session.NotFoundError", () => new NotFoundError({ requestID: input.requestID })),
              )
            }
            // The durable decision commits first: any pod observing the ledger
            // afterwards sees the settled request, never a half-applied reply.
            if (ledger) {
              const outcome = yield* ledger
                .decide(
                  input.requestID,
                  input.reply === "reject" ? "rejected" : "approved",
                  input.reply === "reject"
                    ? { message: input.message }
                    : { reply: input.reply, message: input.message },
                )
                .pipe(Effect.orDie)
              if (outcome === "missing") return yield* new NotFoundError({ requestID: input.requestID })
              if (outcome === "settled") return yield* new NotFoundError({ requestID: input.requestID })
            }
            // Commit saved authority before publishing approval or releasing
            // the waiter. Durable decision + cascade will join this transaction
            // when the HITL ledger is wired in.
            if (input.reply === "always" && existing.request.save?.length) {
              if (sessionScoped) {
                yield* approvals.add({
                  sessionID: existing.request.sessionID,
                  action: existing.request.action,
                  resources: existing.request.save,
                  sourceRequestID: existing.request.id,
                })
              } else {
                yield* saved.add({
                  projectID: location.project.id,
                  action: existing.request.action,
                  resources: existing.request.save,
                })
              }
            }
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

            yield* Deferred.succeed(existing.deferred, undefined)
            pending.delete(input.requestID)
            if (input.reply !== "always" || !existing.request.save?.length) return

            for (const [id, item] of pending) {
              if (sessionScoped && item.request.sessionID !== existing.request.sessionID) continue
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

      const list = Effect.fn("Permission.list")(function* () {
        if (ledger) {
          const rows = yield* ledger.pending().pipe(Effect.orDie)
          for (const row of rows) {
            if (row.kind !== "permission" || pending.has(row.id as ID)) continue
            yield* restore(row.id as ID)
          }
        }
        return Array.from(pending.values(), (item) => item.request)
      })

      const get = Effect.fn("Permission.get")(function* (id: ID) {
        return pending.get(id)?.request
      })

      const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
        if (ledger) {
          const rows = yield* ledger.pending(sessionID).pipe(Effect.orDie)
          for (const row of rows) {
            if (row.kind !== "permission" || pending.has(row.id as ID)) continue
            yield* restore(row.id as ID)
          }
        }
        return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
      })

      return Service.of({ ask, assert, reply, awaitSettled, get, forSession, list, close })
    }),
  )

export const configured = (options?: Options) =>
  makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [
      Database.node,
      Bus.node,
      Location.node,
      Agent.node,
      SessionAgents.node,
      SessionStore.node,
      PermissionSaved.node,
      SessionPermissionApproval.node,
      PluginHooks.node,
    ],
  })

export const node = configured()
