import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Deferred, Effect, Layer, Schema, Context, Schedule } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { HitlStore } from "@/hitl/store"
import { Flag } from "@/flag/flag"

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

// Per-process instance identifier; rows owned by this process carry it in owner_id.
const ownerID = crypto.randomUUID()

const POLL_INTERVAL_MS = 1_000
const RENEW_EVERY_TICKS = 30

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    // Poll PG for status changes on local pending IDs; every N ticks renew lease + sweep dead instances.
    // Only active in PG mode; scoped to the InstanceState lifetime.
    const startPolling = Effect.fn("Question.hitlPoll")(function* () {
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
          const entry = pending.get(row.id as QuestionID)
          if (entry === undefined) continue
          pending.delete(row.id as QuestionID)
          if (row.status === "replied") {
            const answers = Array.isArray(row.result?.["answers"])
              ? (row.result["answers"] as unknown as ReadonlyArray<Answer>)
              : []
            yield* Deferred.succeed(entry.deferred, answers)
          } else {
            yield* Deferred.fail(entry.deferred, new RejectedError())
          }
        }

        tick += 1
        if (tick % RENEW_EVERY_TICKS === 0 && ids.length > 0) {
          yield* Effect.tryPromise({
            try: () => HitlStore.renewLease(ids, Date.now() + HitlStore.LEASE_TTL_MS),
            catch: () => new Error("lease renew failed"),
          }).pipe(Effect.catchCause(() => Effect.void))
        }
      }).pipe(
        Effect.repeat(Schedule.spaced(POLL_INTERVAL_MS)),
        Effect.catchCause(() => Effect.void),
        Effect.forkScoped,
      )
    })

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }

      // Pending limit: memory count covers both modes (single-process view).
      const sessionPending = Array.from(pending.values(), (x) => x.info.sessionID).filter((sid) => sid === input.sessionID).length
      if (sessionPending >= Flag.OPENCODE_HITL_MAX_PENDING_PER_SESSION) {
        return yield* Effect.die(
          new Error(`Too many pending questions (${sessionPending}) for session ${input.sessionID}`),
        )
      }

      // HITL: PG insert (fail fast).
      if (HitlStore.enabled()) {
        const directory = yield* InstanceState.directory
        yield* Effect.tryPromise({
          try: () =>
            HitlStore.insertPending({
              id: id as string,
              kind: "question",
              directory,
              sessionID: input.sessionID as string,
              ownerID,
              payload: info as unknown as Record<string, unknown>,
              leaseUntil: Date.now() + HitlStore.LEASE_TTL_MS,
            }),
          catch: (error) => new Error(`hitl insert failed: ${String(error)}`),
        }).pipe(Effect.orDie)
      }

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      pending.set(id, { info, deferred })
      yield* events.publish(Event.Asked, info)

      return yield* Effect.ensuring(
        Deferred.await(deferred),
        Effect.gen(function* () {
          pending.delete(id)
          // Defensive close: if the PG row is still pending after the deferred
          // resolved through an in-process path, archive it now.
          if (HitlStore.enabled()) {
            yield* Effect.tryPromise({
              try: () =>
                HitlStore.casTransition(id as string, "question", {
                  status: "closed",
                  closeReason: "answered-delivered",
                }),
              catch: () => new Error("hitl defensive close failed"),
            }).pipe(Effect.catchCause(() => Effect.void))
          }
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)

      if (HitlStore.enabled()) {
        const outcome = yield* Effect.tryPromise({
          try: () =>
            HitlStore.casTransition(input.requestID as string, "question", {
              status: "replied",
              result: { answers: input.answers as unknown as unknown[] },
            }),
          catch: (error) => new Error(`hitl reply cas failed: ${String(error)}`),
        }).pipe(Effect.orDie)
        // CAS succeeded (or idempotent repeat): consume locally if we own the deferred.
        if (outcome.updated !== undefined || outcome.current !== undefined) {
          if (existing !== undefined) {
            pending.delete(input.requestID)
            yield* events.publish(Event.Replied, {
              sessionID: existing.info.sessionID,
              requestID: existing.info.id,
              answers: input.answers.map((a) => [...a]),
            })
            yield* Deferred.succeed(existing.deferred, input.answers)
          }
          return
        }
        // Row doesn't exist in PG either → genuine 404.
        if (existing === undefined) {
          return yield* new NotFoundError({ requestID: input.requestID })
        }
      }

      // SQLite fallback (original behavior).
      if (!existing) {
        yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
        return yield* new NotFoundError({ requestID: input.requestID })
      }
      pending.delete(input.requestID)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
      yield* Deferred.succeed(existing.deferred, input.answers)
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)

      if (HitlStore.enabled()) {
        const outcome = yield* Effect.tryPromise({
          try: () => HitlStore.casTransition(requestID as string, "question", { status: "rejected" }),
          catch: (error) => new Error(`hitl reject cas failed: ${String(error)}`),
        }).pipe(Effect.orDie)
        if (outcome.updated !== undefined || outcome.current !== undefined) {
          if (existing !== undefined) {
            pending.delete(requestID)
            yield* events.publish(Event.Rejected, { sessionID: existing.info.sessionID, requestID: existing.info.id })
            yield* Deferred.fail(existing.deferred, new RejectedError())
          }
          return
        }
        if (existing === undefined) {
          return yield* new NotFoundError({ requestID })
        }
      }

      if (!existing) {
        yield* Effect.logWarning("reject for unknown request", { requestID })
        return yield* new NotFoundError({ requestID })
      }
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, { sessionID: existing.info.sessionID, requestID: existing.info.id })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    const list = Effect.fn("Question.list")(function* () {
      if (HitlStore.enabled()) {
        const directory = yield* InstanceState.directory
        const rows = yield* Effect.tryPromise({
          try: () => HitlStore.listPending("question", directory),
          catch: (error) => new Error(`hitl list failed: ${String(error)}`),
        }).pipe(Effect.catchCause(() => Effect.succeed([] as HitlStore.Row[])))
        return rows.map((row) => row.payload as unknown as Request)
      }
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    // Start polling within the instance scope.
    yield* startPolling()

    return Service.of({ ask, reply, reject, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Question from "."
