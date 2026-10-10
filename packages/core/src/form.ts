export * as Form from "./form.js"

import { Form } from "@opencode/schema/form"
import { Cache, Context, Deferred, Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { HitlLedger } from "./hitl/ledger.js"
import { SessionSchema } from "./session/schema.js"

const RETENTION = Duration.minutes(10)
const DEFAULT_POLL_MS = 1_000
const pollIntervalMs = (() => {
  const value = Number(process.env["OPENCODE_HITL_POLL_MS"])
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_MS
})()
/** The MCP elicitation sentinel owner is not a real Session and never persists. */
const durableOwner = (sessionID: string): sessionID is SessionSchema.ID => sessionID !== "global"

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
}

export interface ListInput {
  readonly sessionID?: Form.Info["sessionID"]
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly create: (input: CreateInput) => Effect.Effect<Info, AlreadyExistsError | InvalidFormError>
  readonly ask: (input: CreateInput) => Effect.Effect<TerminalState, AlreadyExistsError | InvalidFormError>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly state: (id: ID) => Effect.Effect<State, NotFoundError>
  /**
   * Waits for a request's terminal state, reviving it from the durable ledger
   * when this process does not hold it (recovery after a restart, or a request
   * another pod created). Already-settled requests return immediately.
   */
  readonly awaitSettled: (id: ID) => Effect.Effect<TerminalState, NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, AlreadySettledError | InvalidAnswerError | NotFoundError>
  readonly cancel: (id: ID) => Effect.Effect<void, AlreadySettledError | NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Form") {}

interface Entry {
  readonly form: Info
  readonly state: State
  readonly deferred: Deferred.Deferred<TerminalState>
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const database = yield* Database.Service
    // PostgreSQL SaaS: the durable HITL ledger keeps pending Forms alive across
    // process death and lets any pod settle them; SQLite stays memory-only.
    const ledger = database.dialect === "postgres" ? HitlLedger.make(database.db) : undefined
    const scope = yield* Effect.scope
    let closed = false
    const forms = yield* Cache.makeWith<ID, Entry>(
      () => Effect.die(new Error("Form cache must be used via set/getSuccess, never get")),
      {
        capacity: Number.MAX_SAFE_INTEGER,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.state.status === "pending" ? Duration.infinity : RETENTION,
      },
    )

    const requireEntry = Effect.fn("Form.requireEntry")((id: ID) =>
      Cache.getSuccess(forms, id).pipe(
        Effect.flatMap((entry) => Effect.fromOption(entry, () => new NotFoundError({ id }))),
      ),
    )

    // Rebuilds a local entry from the durable ledger: after a restart or for a
    // request another pod created. Settled rows revive already completed so a
    // duplicate reply can still be classified instead of 404.
    const restore = Effect.fn("Form.restore")(function* (id: ID) {
      if (!ledger) return undefined
      const row = yield* ledger.get(id).pipe(Effect.orDie)
      if (!row || row.kind !== "form") return undefined
      const form = row.payload as Info
      const state: State =
        row.decision === "answered"
          ? { status: "answered", answer: (row.result ?? {}) as Answer }
          : row.decision === "cancelled"
            ? { status: "cancelled" }
            : { status: "pending" }
      const deferred = yield* Deferred.make<TerminalState>()
      const entry: Entry = { form, state, deferred }
      if (state.status !== "pending") yield* Deferred.succeed(deferred, state)
      yield* Cache.set(forms, id, entry)
      return entry
    })

    const settleFromLedger = Effect.fn("Form.settleFromLedger")(function* (entry: Entry) {
      if (!ledger) return
      const row = yield* ledger.get(entry.form.id).pipe(Effect.orDie)
      if (!row || row.decision === "pending") return
      const next: TerminalState | undefined =
        row.decision === "answered"
          ? { status: "answered", answer: (row.result ?? {}) as Answer }
          : row.decision === "cancelled"
            ? { status: "cancelled" }
            : undefined
      if (!next) return
      yield* Cache.set(forms, entry.form.id, { ...entry, state: next })
      yield* Deferred.succeed(entry.deferred, next)
    })

    // Owner-side consumption: another pod settled a request this process is
    // waiting on. Wakes the local waiter only; the settling pod published the
    // public event, and cross-pod event fanout is tracked separately.
    const pollLoop = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(pollIntervalMs)
        const entries = Array.from(yield* Cache.values(forms)).filter(
          (entry) => entry.state.status === "pending" && durableOwner(entry.form.sessionID),
        )
        for (const entry of entries) yield* settleFromLedger(entry)
      }
    })
    if (ledger) yield* pollLoop.pipe(Effect.forkIn(scope))

    const create = Effect.fn("Form.create")((input: CreateInput) =>
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
            deferred: yield* Deferred.make<TerminalState>(),
          }
          yield* Cache.set(forms, id, entry)
          if (ledger && durableOwner(form.sessionID)) {
            yield* ledger.register({ id, kind: "form", sessionID: form.sessionID, payload: form }).pipe(Effect.orDie)
          }
          yield* bus
            .publish(Form.Event.Created, { sessionID: form.sessionID, form })
            .pipe(Effect.onError(() => Cache.invalidate(forms, id)))
          if (closed) yield* cancel(id).pipe(Effect.orDie)
          return form
        }),
      ),
    )

    const ask = Effect.fn("Form.ask")((input: CreateInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const form = yield* create(input)
          const entry = yield* requireEntry(form.id).pipe(Effect.orDie)
          return yield* restore(Deferred.await(entry.deferred)).pipe(
            Effect.onInterrupt(() => Effect.ignore(cancel(form.id))),
          )
        }),
      ),
    )

    const get = Effect.fn("Form.get")(function* (id: ID) {
      const local = yield* Cache.getSuccess(forms, id)
      if (Option.isSome(local)) return local.value.form
      const restored = yield* restore(id)
      if (!restored) return yield* new NotFoundError({ id })
      return restored.form
    })

    const list = Effect.fn("Form.list")(function* (input?: ListInput) {
      if (ledger) {
        // Pending Forms live in the ledger; revive them locally so callers on
        // any pod (including after a restart) see the same outstanding set.
        const sessionID = input?.sessionID
        const rows = yield* ledger
          .pending(sessionID === undefined || sessionID === "global" ? undefined : SessionSchema.ID.make(sessionID))
          .pipe(Effect.orDie)
        for (const row of rows) {
          if (row.kind !== "form") continue
          if (sessionID !== undefined && row.sessionID !== sessionID) continue
          const local = yield* Cache.getSuccess(forms, row.id as ID)
          if (Option.isNone(local)) yield* restore(row.id as ID)
        }
      }
      const entries = yield* Cache.values(forms)
      return Array.from(entries)
        .filter((entry) => entry.state.status === "pending")
        .filter((entry) => input?.sessionID === undefined || entry.form.sessionID === input.sessionID)
        .map((entry) => entry.form)
    })

    const state = Effect.fn("Form.state")(function* (id: ID) {
      const local = yield* Cache.getSuccess(forms, id)
      if (Option.isSome(local)) return local.value.state
      const restored = yield* restore(id)
      if (!restored) return yield* new NotFoundError({ id })
      return restored.state
    })

    const awaitSettled = Effect.fn("Form.awaitSettled")(function* (id: ID) {
      const local = yield* Cache.getSuccess(forms, id)
      const entry = Option.isSome(local) ? local.value : yield* restore(id)
      if (!entry) return yield* new NotFoundError({ id })
      if (entry.state.status !== "pending") return entry.state
      return yield* Deferred.await(entry.deferred)
    })

    const reply = Effect.fn("Form.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          let entry: Entry | undefined = Option.getOrUndefined(yield* Cache.getSuccess(forms, input.id))
          if (!entry) {
            const restored = yield* restore(input.id)
            if (!restored) return yield* new NotFoundError({ id: input.id })
            entry = restored
          }
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id: input.id })
          const invalid = validateAnswer(entry.form.fields, input.answer)
          if (invalid) return yield* new InvalidAnswerError({ id: input.id, message: invalid })
          if (ledger && durableOwner(entry.form.sessionID)) {
            const outcome = yield* ledger.decide(input.id, "answered", input.answer).pipe(Effect.orDie)
            if (outcome === "missing") return yield* new NotFoundError({ id: input.id })
            if (outcome === "settled") return yield* new AlreadySettledError({ id: input.id })
          }
          const next: TerminalState = { status: "answered", answer: input.answer }
          yield* bus.publish(Form.Event.Replied, {
            id: input.id,
            sessionID: entry.form.sessionID,
            answer: input.answer,
          })
          yield* Cache.set(forms, input.id, { ...entry, state: next })
          yield* Deferred.succeed(entry.deferred, next)
        }),
      ),
    )

    const cancel = Effect.fn("Form.cancel")((id: ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          let entry: Entry | undefined = Option.getOrUndefined(yield* Cache.getSuccess(forms, id))
          if (!entry) {
            const restored = yield* restore(id)
            if (!restored) return yield* new NotFoundError({ id })
            entry = restored
          }
          if (entry.state.status !== "pending") return yield* new AlreadySettledError({ id })
          if (ledger && durableOwner(entry.form.sessionID)) {
            const outcome = yield* ledger.decide(id, "cancelled").pipe(Effect.orDie)
            if (outcome === "missing") return yield* new NotFoundError({ id })
            if (outcome === "settled") return yield* new AlreadySettledError({ id })
          }
          const next: TerminalState = { status: "cancelled" }
          yield* bus.publish(Form.Event.Cancelled, { id, sessionID: entry.form.sessionID })
          yield* Cache.set(forms, id, { ...entry, state: next })
          yield* Deferred.succeed(entry.deferred, next)
        }),
      ),
    )

    const close = Effect.sync(() => {
      closed = true
    }).pipe(
      Effect.andThen(Cache.values(forms)),
      Effect.flatMap((entries) =>
        Effect.forEach(
          Array.from(entries).filter((entry) => entry.state.status === "pending"),
          (entry) =>
            ledger && durableOwner(entry.form.sessionID)
              ? // Process teardown keeps the durable request pending for the next
                // owner: wake only the local waiter, publish no user cancel.
                Effect.gen(function* () {
                  const next: TerminalState = { status: "cancelled" }
                  yield* Cache.set(forms, entry.form.id, { ...entry, state: next })
                  yield* Deferred.succeed(entry.deferred, next)
                })
              : cancel(entry.form.id).pipe(Effect.ignore),
          { discard: true },
        ),
      ),
    )
    yield* Effect.addFinalizer(() => close)

    return Service.of({ create, ask, get, list, state, awaitSettled, reply, cancel, close })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Database.node] })

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
