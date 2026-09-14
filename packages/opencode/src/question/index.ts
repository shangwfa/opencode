import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Deferred, Effect, Layer, Schema, Context, Schedule } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"
import { HitlStore } from "@/hitl/store"
import { Flag } from "@/flag/flag"
import { HitlSalvage } from "@/hitl/salvage"

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

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("Question.ConflictError", {
  requestID: QuestionID,
  status: Schema.String,
  closeReason: Schema.optional(Schema.String),
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
  }) => Effect.Effect<void, NotFoundError | ConflictError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError | ConflictError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* (ctx) {
        const value = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of value.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            value.pending.clear()
          }),
        )

        if (HitlStore.enabled()) {
          let tick = 0
          const poll = Effect.gen(function* () {
            const ids = Array.from(value.pending.keys(), (id) => id as string)
            const changed = yield* Effect.tryPromise({
              try: () => HitlStore.changed(ids, ownerID, ctx.directory),
              catch: (error) => new Error(`hitl poll failed: ${String(error)}`),
            })

            for (const row of changed) {
              const entry = value.pending.get(row.id as QuestionID)
              if (entry === undefined) continue
              value.pending.delete(row.id as QuestionID)
              ;(yield* Effect.currentSpan).attribute("hitl.remote_consumed", 1)
              if (row.status === "replied") {
                const answers = Array.isArray(row.result?.["answers"])
                  ? (row.result["answers"] as unknown as ReadonlyArray<Answer>)
                  : []
                yield* Deferred.succeed(entry.deferred, answers)
                continue
              }
              yield* Deferred.fail(entry.deferred, new RejectedError())
            }

            tick += 1
            if (tick % RENEW_EVERY_TICKS !== 0) return
            yield* Effect.tryPromise({
              try: () => HitlStore.renewLease(ids, ownerID, ctx.directory),
              catch: (error) => new Error(`hitl lease renewal failed: ${String(error)}`),
            })
            yield* HitlSalvage.sweepKind(events, "question", ctx.directory)
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) =>
                Effect.logError("question HITL polling failed", { directory: ctx.directory, cause: String(cause) }),
            ),
          )
          yield* poll.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL_MS)), Effect.forkScoped)
        }

        return value
      }),
    )

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
      const sessionPending = Array.from(pending.values(), (x) => x.info.sessionID).filter(
        (sid) => sid === input.sessionID,
      ).length
      if (sessionPending >= Flag.OPENCODE_HITL_MAX_PENDING_PER_SESSION) {
        return yield* Effect.die(
          new Error(`Too many pending questions (${sessionPending}) for session ${input.sessionID}`),
        )
      }

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      return yield* Effect.gen(function* () {
        // Register locally BEFORE the PG row becomes visible (see permission ask).
        pending.set(id, { info, deferred })
        if (HitlStore.enabled()) {
          const directory = yield* InstanceState.directory
          const inserted = yield* Effect.tryPromise({
            try: () =>
              HitlStore.insertPendingLimited(
                {
                  id: id as string,
                  kind: "question",
                  directory,
                  sessionID: input.sessionID as string,
                  ownerID,
                  payload: info as unknown as Record<string, unknown>,
                },
                Flag.OPENCODE_HITL_MAX_PENDING_PER_SESSION,
              ),
            catch: (error) => new Error(`hitl insert failed: ${String(error)}`),
          }).pipe(Effect.orDie)
          if (!inserted) {
            return yield* Effect.die(new Error(`Too many pending questions for session ${input.sessionID}`))
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

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)

      if (HitlStore.enabled()) {
        const directory = yield* InstanceState.directory
        const transition = {
          status: "replied" as const,
          result: { answers: input.answers as unknown as unknown[] },
        }
        const outcome = yield* Effect.tryPromise({
          try: () => HitlStore.casTransition(input.requestID as string, "question", directory, transition),
          catch: (error) => new Error(`hitl reply cas failed: ${String(error)}`),
        }).pipe(Effect.orDie)
        const row = outcome.updated ?? outcome.current
        if (row === undefined) return yield* new NotFoundError({ requestID: input.requestID })
        if (outcome.current !== undefined && !HitlStore.sameTransition(outcome.current, transition)) {
          return yield* new ConflictError({
            requestID: input.requestID,
            status: outcome.current.status,
            closeReason: outcome.current.close_reason ?? undefined,
          })
        }
        const answers = Array.isArray(row.result?.["answers"])
          ? (row.result["answers"] as unknown as ReadonlyArray<Answer>)
          : []
        if (outcome.updated !== undefined) {
          const request = row.payload as unknown as Request
          yield* events.publish(Event.Replied, {
            sessionID: request.sessionID,
            requestID: request.id,
            answers: answers.map((answer) => [...answer]),
          })
        }
        if (existing === undefined) return
        pending.delete(input.requestID)
        yield* Deferred.succeed(existing.deferred, answers)
        return
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
        const directory = yield* InstanceState.directory
        const transition = { status: "rejected" as const }
        const outcome = yield* Effect.tryPromise({
          try: () => HitlStore.casTransition(requestID as string, "question", directory, transition),
          catch: (error) => new Error(`hitl reject cas failed: ${String(error)}`),
        }).pipe(Effect.orDie)
        const row = outcome.updated ?? outcome.current
        if (row === undefined) return yield* new NotFoundError({ requestID })
        if (outcome.current !== undefined && !HitlStore.sameTransition(outcome.current, transition)) {
          return yield* new ConflictError({
            requestID,
            status: outcome.current.status,
            closeReason: outcome.current.close_reason ?? undefined,
          })
        }
        if (outcome.updated !== undefined) {
          const request = row.payload as unknown as Request
          yield* events.publish(Event.Rejected, { sessionID: request.sessionID, requestID: request.id })
        }
        if (existing === undefined) return
        pending.delete(requestID)
        yield* Deferred.fail(existing.deferred, new RejectedError())
        return
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
        }).pipe(
          Effect.tapError((error) => Effect.logError("question HITL list failed", { directory, error: String(error) })),
          Effect.orDie,
        )
        return rows.map((row) => row.payload as unknown as Request)
      }
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (x) => x.info)
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Question from "."
