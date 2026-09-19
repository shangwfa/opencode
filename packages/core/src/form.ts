export * as Form from "./form.js"

import { Form } from "@opencode/schema/form"
import { Cache, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Hitl } from "./hitl/index.js"
import { Location } from "./location.js"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Bus } from "./bus.js"
import { SessionStore } from "./session/store.js"

const RETENTION = Duration.minutes(10)

export const ID = Form.ID
export type ID = typeof ID.Type

export const Info = Form.Info
export type Info = typeof Info.Type

export const Field = Form.Field
export type Field = Form.Field

export const Fields = Form.Fields
export type Fields = Form.Fields

export const When = Form.When
export type When = Form.When

export const State = Form.State
export type State = typeof State.Type
export type TerminalState = Exclude<State, { readonly status: "pending" }>

export const Answer = Form.Answer
export type Answer = typeof Answer.Type

export const Reply = Form.Reply
export type Reply = typeof Reply.Type

export { Event } from "@opencode/schema/form"

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Form.NotFoundError", {
  id: ID,
}) {
  override get message() {
    return `Form not found: ${this.id}`
  }
}

export class AlreadySettledError extends Schema.TaggedError<AlreadySettledError>()("Form.AlreadySettledError", {
  id: ID,
}) {
  override get message() {
    return `Form already settled: ${this.id}`
  }
}

export class AlreadyExistsError extends Schema.TaggedError<AlreadyExistsError>()("Form.AlreadyExistsError", {
  id: ID,
}) {
  override get message() {
    return `Form already exists: ${this.id}`
  }
}

export class InvalidAnswerError extends Schema.TaggedError<InvalidAnswerError>()("Form.InvalidAnswerError", {
  id: ID,
  message: Schema.String,
}) {}

export class InvalidFormError extends Schema.TaggedError<InvalidFormError>()("Form.InvalidFormError", {
  message: Schema.String,
}) {}

export type CreateInput = Omit<Form.Info, "id"> & { readonly id?: ID }

export interface ReplyInput {
  readonly id: ID
  readonly answer: Answer
  /** Acting user; when present a mismatched owner reads as not-found (v1 cross-tenant guard). */
  readonly userID?: string
}

export interface ListInput {
  readonly sessionID?: Form.Info["sessionID"]
  /** Restricts results to a single owner; omit for internal cross-user sweeps. */
  readonly userID?: string
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly create: (input: CreateInput) => Effect.Effect<Info, AlreadyExistsError | InvalidFormError>
  readonly ask: (input: CreateInput) => Effect.Effect<TerminalState, AlreadyExistsError | InvalidFormError>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly state: (id: ID) => Effect.Effect<State, NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, AlreadySettledError | InvalidAnswerError | NotFoundError>
  readonly cancel: (id: ID) => Effect.Effect<void, AlreadySettledError | NotFoundError>
  /**
   * Drops this session's pending forms. `closeReason` settles the persisted rows
   * (abort sweep: instance-restart); omitting it only clears memory because the
   * caller deletes the rows itself (session removal: FK cascade).
   */
  readonly cancelBySession: (
    sessionID: Form.Info["sessionID"],
    closeReason?: "instance-restart" | "shutdown",
  ) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Form") {}

interface Entry {
  readonly form: Info
  readonly state: State
  /** Owning user recorded at ask time; scopes list/reply without widening the public Info shape. */
  readonly userID: string
  /**
   * Restored by boot recovery rather than created by this instance. Recovered
   * asks are not renewed so they reach the lease sweep that ends the dangling
   * tool call (v1 restart semantics).
   */
  readonly recovered: boolean
  readonly deferred: Deferred.Deferred<TerminalState>
}

/** Rebuild a pending form from a persisted hitl_request row; malformed rows yield undefined. */
function formFromRow(row: Hitl.Row): Info | undefined {
  const raw: unknown = row.payload
  const payload = typeof raw === "string" ? tryParse(raw) : raw
  if (payload === null || typeof payload !== "object") return undefined
  const fields = (payload as { fields?: Info["fields"] }).fields
  if (fields === undefined || fields.length === 0) return undefined
  const metadata = (payload as { metadata?: Record<string, unknown> | null }).metadata
  return {
    id: row.id as ID,
    sessionID: row.session_id,
    title: String((payload as { title?: string }).title ?? "Questions"),
    ...(metadata === undefined || metadata === null ? {} : { metadata }),
    fields,
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const ownerId = Hitl.ownerID()
    // Location resolves at call time from the ambient context: acquiring it at
    // layer-build time deadlocks graphs where this layer feeds Location's own
    // construction (LocationActivity's handmade map wedges otherwise). Hosts
    // without a Location degrade to the empty directory, which matches no
    // persisted rows and is therefore a safe no-op for the mirror.
    const directoryOf = Effect.fnUntraced(function* () {
      const location = yield* Effect.serviceOption(Location.Service)
      return Option.isNone(location) ? "" : location.value.directory
    })
    let closed = false
    const forms = yield* Cache.makeWith<ID, Entry>(
      () => Effect.die(new Error("Form cache must be used via set/getSuccess, never get")),
      {
        capacity: Number.MAX_SAFE_INTEGER,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.state.status === "pending" ? Duration.infinity : RETENTION,
      },
    )

    // Delivers a terminal tool result for an ask its run never settled:
    // replied backfills the submitted answer, rejected/pending close with an
    // explicit reason. The terminal event only moves `running` parts, so a run
    // that already settled its part makes this a safe no-op.
    const backfill = Effect.fnUntraced(function* (action: Hitl.SweepAction) {
      const base = {
        // Cast: the "global" elicitation owner is not a branded SessionID; a
        // publish that fails its event schema is swallowed by the sweep guard.
        sessionID: action.sessionID as Session.ID,
        assistantMessageID: action.messageID as SessionMessage.ID,
        id: action.toolID,
        executed: true,
        metadata: { hitl: { salvaged: true, requestID: action.id } },
      }
      if (action.status === "replied") {
        yield* bus.publish(SessionEvent.Tool.Success, {
          ...base,
          content: [{ type: "text" as const, text: action.answer ?? "The user answered the question." }],
        })
        yield* Hitl.markBackfilled(action.id)
        return
      }
      yield* bus.publish(SessionEvent.Tool.Failed, {
        ...base,
        error: {
          type: action.status === "rejected" ? "question.rejected" : "instance-restart",
          message: action.status === "rejected" ? "The user declined to answer." : "实例重启，问题未回答",
        },
      })
      if (action.status === "pending") yield* Hitl.markSwept(action.id, "closed", "instance-restart")
    })

    // SaaS restart recovery: rebuild still-pending asks from the hitl table so
    // clients can list and reply after a restart (v1 parity). Rows whose lease
    // expired while this instance was down are closed as lease-expired.
    {
      // The layer is Location-scoped and freshly built, so the cache starts
      // empty; every still-pending row is a restart orphan to restore. The
      // recovery must never fail the layer: a single malformed row (e.g. json
      // text arriving un-parsed through the PG bridge) is skipped, not thrown.
      const pendingRows = yield* Hitl.listPending({ kind: "question", directory: yield* directoryOf() })
      yield* Effect.logInfo("[hitl-recovery] boot", { pending: pendingRows?.length ?? 0 })
      for (const row of pendingRows ?? []) {
        const form = formFromRow(row)
        if (form === undefined) continue
        yield* Cache.set(forms, form.id, {
          form,
          state: { status: "pending" },
          userID: row.user_id,
          recovered: true,
          deferred: Deferred.makeUnsafe<TerminalState>(),
        })
      }
      // SaaS: answers submitted before the previous holder died never reached
      // their run; deliver them now so a resumed run reads the user's answer
      // instead of a dangling tool call (v1's answered-lost salvage). A bad row
      // must never fail the layer, same as recovery.
      yield* Effect.forEach(yield* Hitl.backfillables("question"), (action) => backfill(action), {
        discard: true,
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("hitl question backfill failed", cause)))
      yield* Hitl.closeExpired()
    }

    const requireEntry = Effect.fn("Form.requireEntry")((id: ID) =>
      Cache.getSuccess(forms, id).pipe(
        Effect.flatMap((entry) => Effect.fromOption(entry, () => new NotFoundError({ id }))),
      ),
    )

    const create = Effect.fn("Form.create")((input: CreateInput, userID = "") =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const id = input.id ?? ID.create()
          const existing = yield* Cache.getSuccess(forms, id)
          if (Option.isSome(existing)) return yield* new AlreadyExistsError({ id })
          const invalid = validateFields(input.fields)
          if (invalid) return yield* new InvalidFormError({ message: invalid })
          const form: Info = {
            id,
            sessionID: input.sessionID,
            title: input.title,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            fields: input.fields,
          }
          const entry: Entry = {
            form,
            state: { status: "pending" },
            userID,
            recovered: false,
            deferred: yield* Deferred.make<TerminalState>(),
          }
          yield* Cache.set(forms, id, entry)
          // SaaS: mirror pending asks into the hitl table so they survive restarts.
          yield* Hitl.insertPending({
            id,
            kind: "question",
            directory: yield* directoryOf(),
            sessionID: input.sessionID,
            userID,
            ownerID: ownerId,
            payload: { title: input.title, fields: input.fields, metadata: input.metadata ?? null },
          })
          yield* bus.publish(Form.Event.Created, { form }).pipe(Effect.onError(() => Cache.invalidate(forms, id)))
          if (closed) yield* cancel(id).pipe(Effect.orDie)
          return form
        }),
      ),
    )

    const ask = Effect.fn("Form.ask")((input: CreateInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Identity travels on the requesting user message metadata (v1 parity).
          // Session history is optional here so hosts without it still work.
          const store = yield* Effect.serviceOption(SessionStore.Service)
          const messages = Option.isNone(store)
            ? []
            : yield* store.value
                .context(input.sessionID as Session.ID)
                .pipe(Effect.orElseSucceed(() => []))
          const form = yield* create(input, Hitl.userIDFromMessages(messages))
          const entry = yield* requireEntry(form.id).pipe(Effect.orDie)
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.onInterrupt(() => Effect.ignore(cancel(form.id))),
          )
        }),
      ),
    )

    const get = Effect.fn("Form.get")(function* (id: ID) {
      return (yield* requireEntry(id)).form
    })

    // Live pendings live in the Location instance whose sandbox the run used,
    // which is not necessarily the instance answering a directory-scoped list
    // request. Merge the persisted rows so a pending list shows every
    // outstanding ask across sessions and instances (v1 semantics).
    const list = Effect.fn("Form.list")(function* (input?: ListInput) {
      const entries = yield* Cache.values(forms)
      // Reconcile against persisted terminal rows: entries settled elsewhere
      // (another instance's sweep) stop being offered from this cache too.
      // Absent rows are kept — a cascade delete or a host without persistence
      // is not evidence the ask was answered.
      const settled = yield* Hitl.settledIds("question", yield* directoryOf())
      const dropped = settled === undefined ? undefined : new Set(settled)
      const local = Array.from(entries)
        .filter((entry) => entry.state.status === "pending")
        .filter((entry) => dropped === undefined || !dropped.has(entry.form.id))
        .filter((entry) => input?.sessionID === undefined || entry.form.sessionID === input.sessionID)
        .filter((entry) => input?.userID === undefined || entry.userID === input.userID)
        .map((entry) => entry.form)
      const seen = new Set(local.map((form) => form.id))
      const rows = yield* Hitl.listPending({ kind: "question", directory: yield* directoryOf(), userID: input?.userID })
      const persisted = (rows ?? []).flatMap((row) => {
        const form = formFromRow(row)
        if (form === undefined || seen.has(form.id)) return []
        if (input?.sessionID !== undefined && form.sessionID !== input.sessionID) return []
        return [form]
      })
      return [...local, ...persisted]
    })

    const state = Effect.fn("Form.state")(function* (id: ID) {
      return (yield* requireEntry(id)).state
    })

    const reply = Effect.fn("Form.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const maybe = yield* Cache.getSuccess(forms, input.id)
          if (Option.isNone(maybe)) {
            // The ask may live in a graph this instance cannot reach (an idle
            // eviction detached it while its run still borrows it). Settle the
            // persisted row anyway; the holder's reconcile pass wakes its run.
            const row = yield* Hitl.row(input.id)
            if (row === undefined || row.status !== "pending" || row.kind !== "question")
              return yield* new NotFoundError({ id: input.id })
            if (input.userID !== undefined && row.user_id !== input.userID)
              return yield* new NotFoundError({ id: input.id })
            const rebuilt = formFromRow(row)
            if (rebuilt === undefined) return yield* new NotFoundError({ id: input.id })
            const invalid = validateAnswer(rebuilt.fields, input.answer)
            if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
            yield* Hitl.settle(input.id, {
              status: "replied",
              result: { answer: input.answer },
              closeReason: "answered-delivered",
              ...(input.userID === undefined ? {} : { userID: input.userID }),
            })
            yield* bus.publish(Form.Event.Replied, { id: input.id, sessionID: row.session_id, answer: input.answer })
            return
          }
          // A mismatched owner reads as not-found before any state is revealed.
          const settled = maybe.value
          if (input.userID !== undefined && settled.userID !== input.userID)
            return yield* new NotFoundError({ id: input.id })
          if (settled.state.status !== "pending") return yield* new AlreadySettledError({ id: input.id })
          const invalid = validateAnswer(settled.form.fields, input.answer)
          if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
          const next: TerminalState = { status: "answered", answer: input.answer }
          yield* Hitl.settle(input.id, {
            status: "replied",
            result: { answer: input.answer },
            closeReason: "answered-delivered",
            ...(input.userID === undefined ? {} : { userID: input.userID }),
          })
          yield* bus.publish(Form.Event.Replied, {
            id: input.id,
            sessionID: settled.form.sessionID,
            answer: input.answer,
          })
          yield* Cache.set(forms, input.id, { ...settled, state: next })
          yield* Deferred.succeed(settled.deferred, next)
        }),
      ),
    )

    const cancel = Effect.fn("Form.cancel")((id: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const entry = yield* requireEntry(id)
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id })
          const next: TerminalState = { status: "cancelled" }
          // Explicit user cancellation closes the row as shutdown; the layer's
          // shutdown sweep calls this same path for every pending entry, and a
          // restart must NOT consume the row — recovery on the next boot
          // re-creates the form from the still-pending row. Distinguish by
          // whether the shutdown sweep already started.
          if (!closed) yield* Hitl.settle(id, { status: "closed", closeReason: "shutdown" })
          yield* bus.publish(Form.Event.Cancelled, { id, sessionID: entry.form.sessionID })
          yield* Cache.set(forms, id, { ...entry, state: next })
          yield* Deferred.succeed(entry.deferred, next)
        }),
      ),
    )

    // SaaS: keep live questions leased against another instance's cleanup.
    yield* Effect.forkScoped(
      Hitl.renewal(() =>
        Cache.values(forms).pipe(
          Effect.map((entries) =>
            Array.from(entries)
              .filter((entry) => entry.state.status === "pending" && !entry.recovered)
              .map((entry) => entry.form.id),
          ),
        ),
      ),
    )

    // SaaS: end dangling asks whose owner died (v1's salvage): answered asks
    // backfill a completed tool result so the model can use the answer, and
    // unanswered ones fail with an explicit restart reason. Terminal events
    // only move `running` parts, so re-publishing is a safe CAS.
    // A reply settled from outside this graph (PG fallback in reply, or
    // another instance) leaves the borrowed run waiting forever. Reconcile
    // local pendings against the persisted rows each tick and wake them with
    // the submitted answer.
    const reconcile = Effect.gen(function* () {
      const entries = yield* Cache.values(forms)
      for (const entry of Array.from(entries)) {
        if (entry.state.status !== "pending") continue
        const row = yield* Hitl.row(entry.form.id)
        if (row === undefined) continue
        if (row.status === "replied") {
          const answer = (row.result as { answer?: Answer } | null)?.answer
          if (answer === undefined) continue
          const next: TerminalState = { status: "answered", answer }
          yield* bus.publish(Form.Event.Replied, { id: entry.form.id, sessionID: entry.form.sessionID, answer })
          yield* Cache.set(forms, entry.form.id, { ...entry, state: next })
          yield* Deferred.succeed(entry.deferred, next)
          continue
        }
        if (row.status === "rejected" || row.status === "closed") {
          const next: TerminalState = { status: "cancelled" }
          yield* Cache.set(forms, entry.form.id, { ...entry, state: next })
          yield* Deferred.succeed(entry.deferred, next)
        }
      }
    }).pipe((effect) => Hitl.loopTick(effect, "hitl question reconcile failed"))

    const sweep = Effect.gen(function* () {
      yield* reconcile
      for (const action of yield* Hitl.sweepables("question")) {
        // The recovered entry may live in this instance's cache; settle it so
        // the list stops offering a swept ask.
        const local = yield* Cache.getSuccess(forms, action.id as ID)
        if (Option.isSome(local) && local.value.state.status === "pending") {
          yield* Cache.set(forms, action.id as ID, { ...local.value, state: { status: "cancelled" } })
          yield* Deferred.succeed(local.value.deferred, { status: "cancelled" })
        }
        yield* backfill(action)
      }
    }).pipe((effect) => Hitl.loopTick(effect, "hitl question sweep failed"))
    yield* Effect.forkScoped(
      Effect.forever(Effect.sleep(Hitl.LEASE_RENEW_MS).pipe(Effect.andThen(sweep))),
    )

    const close = Effect.sync(() => {
      closed = true
    }).pipe(
      Effect.andThen(Cache.values(forms)),
      Effect.flatMap((entries) =>
        Effect.forEach(
          Array.from(entries).filter((entry) => entry.state.status === "pending"),
          (entry) => cancel(entry.form.id).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )
    yield* Effect.addFinalizer(() => close)

    // SaaS: session removal sweeps its still-pending forms. The deferred
    // succeeds with a cancelled terminal state so a suspended run unblocks;
    // the hitl_request rows themselves are deleted by the caller (v1 cascade).
    const cancelBySession = Effect.fn("Form.cancelBySession")(function* (
      sessionID: Form.Info["sessionID"],
      closeReason?: "instance-restart" | "shutdown",
    ) {
      // A session's live run may borrow a detached older graph (idle eviction
      // keeps the borrowed instance alive), so this instance's cache is not
      // authoritative. Settle the persisted rows first, then mirror locally.
      if (closeReason !== undefined) {
        const rows = yield* Hitl.listPending({ kind: "question", directory: yield* directoryOf() })
        for (const row of rows ?? []) {
          if (row.session_id !== sessionID) continue
          yield* Hitl.settle(row.id, { status: "closed", closeReason })
        }
      }
      const entries = yield* Cache.values(forms)
      for (const entry of Array.from(entries)) {
        if (entry.form.sessionID !== sessionID || entry.state.status !== "pending") continue
        const next: TerminalState = { status: "cancelled" }
        if (closeReason !== undefined) yield* Hitl.settle(entry.form.id, { status: "closed", closeReason })
        yield* bus.publish(Form.Event.Cancelled, { id: entry.form.id, sessionID })
        yield* Cache.set(forms, entry.form.id, { ...entry, state: next })
        yield* Deferred.succeed(entry.deferred, next)
      }
    })

    return Service.of({ create, ask, get, list, state, reply, cancel, cancelBySession, close })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Location.node] })

export function validateAnswer(form: ReadonlyArray<Form.Field>, answer: Answer) {
  const fields = new Map(form.map((field) => [field.key, field] as const))
  for (const key of Object.keys(answer)) {
    if (!fields.has(key)) return `Unknown form field: ${key}`
  }
  for (const field of form) {
    const value = answer[field.key]
    if (field.type === "external") {
      if (value !== true) return `External form field must be acknowledged: ${field.key}`
      continue
    }
    const active = isActive(field, answer)
    if (value === undefined) {
      if (field.required && active) return `Missing required form field: ${field.key}`
      continue
    }
    if (!active) return `Form field is not active: ${field.key}`
    const invalid = validateField(field, value)
    if (invalid) return invalid
  }
}

type InputField = Exclude<Form.Field, Form.ExternalField>

function isActive(field: InputField, answer: Answer) {
  if (!field.when) return true
  return field.when.every((when) => matches(when, answer[when.key]))
}

// An unanswered referenced field makes the condition false for both ops. Combined with inactive
// fields being unanswerable, this cascades: hiding a field falsifies every condition referencing it.
function matches(when: Form.When, value: Form.Value | undefined) {
  if (value === undefined) return false
  const hit = Array.isArray(value) ? value.some((item) => item === when.value) : value === when.value
  return when.op === "eq" ? hit : !hit
}

// Create-time validation of `when` references: each condition must point at an earlier field,
// carry a value matching that field's type, and use a declared option when the field's options
// are closed. Rejecting these at creation surfaces authoring mistakes to the caller instead of
// silently never matching.
export function validateFields(fields: ReadonlyArray<Form.Field>) {
  if (fields.length === 0) return "Form must have at least one field"
  const earlier = new Map<string, InputField>()
  const keys = new Set<string>()
  for (const field of fields) {
    if (keys.has(field.key)) return `Duplicate form field key: ${field.key}`
    keys.add(field.key)
    if (field.type === "external") continue
    for (const when of field.when ?? []) {
      const target = earlier.get(when.key)
      if (!target) return `Form field condition must reference an earlier field: ${field.key} -> ${when.key}`
      const invalid = validateWhen(when, target)
      if (invalid) return `${invalid}: ${field.key} -> ${when.key}`
    }
    earlier.set(field.key, field)
  }
}

function validateWhen(when: Form.When, target: InputField) {
  if (target.type === "boolean") {
    if (typeof when.value !== "boolean") return "Form field condition value must be a boolean"
    return
  }
  if (target.type === "number" || target.type === "integer") {
    if (typeof when.value !== "number") return "Form field condition value must be a number"
    return
  }
  // string and multiselect targets both compare against string values
  if (typeof when.value !== "string") return "Form field condition value must be a string"
  const closed = target.type === "multiselect" ? !target.custom : target.options !== undefined && !target.custom
  if (closed && !target.options?.some((option) => option.value === when.value)) {
    return "Form field condition value must be one of the field's options"
  }
}

function validateField(field: InputField, value: Form.Value): string | undefined {
  if (field.type === "string") {
    if (typeof value !== "string") return `Expected string for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    if (field.minLength !== undefined && value.length < field.minLength) return `Form field is too short: ${field.key}`
    if (field.maxLength !== undefined && value.length > field.maxLength) return `Form field is too long: ${field.key}`
    if (field.pattern !== undefined) {
      try {
        if (!new RegExp(field.pattern).test(value)) return `Form field does not match pattern: ${field.key}`
      } catch {
        return `Form field has invalid pattern: ${field.key}`
      }
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return `Expected email for form field: ${field.key}`
    if (field.format === "uri" && !URL.canParse(value)) return `Expected URI for form field: ${field.key}`
    if (field.format === "date" && !isDate(value)) return `Expected date for form field: ${field.key}`
    if (field.format === "date-time" && !isDateTime(value)) return `Expected date-time for form field: ${field.key}`
    if (field.options && !field.custom && !field.options.some((option) => option.value === value)) {
      return `Invalid option for form field: ${field.key}`
    }
    return
  }
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `Expected number for form field: ${field.key}`
    if (field.type === "integer" && !Number.isInteger(value)) return `Expected integer for form field: ${field.key}`
    if (field.minimum !== undefined && value < field.minimum) return `Form field is too small: ${field.key}`
    if (field.maximum !== undefined && value > field.maximum) return `Form field is too large: ${field.key}`
    return
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") return `Expected boolean for form field: ${field.key}`
    return
  }
  if (field.type === "multiselect") {
    if (!isStringArray(value)) return `Expected string array for form field: ${field.key}`
    if (field.required && value.length === 0) return `Missing required form field: ${field.key}`
    if (field.minItems !== undefined && value.length < field.minItems)
      return `Too few selections for form field: ${field.key}`
    if (field.maxItems !== undefined && value.length > field.maxItems)
      return `Too many selections for form field: ${field.key}`
    if (!field.custom && value.some((item) => !field.options.some((option) => option.value === item))) {
      return `Invalid option for form field: ${field.key}`
    }
  }
}

function isStringArray(value: Form.Value): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function isDateTime(value: string) {
  return !Number.isNaN(new Date(value).getTime())
}
