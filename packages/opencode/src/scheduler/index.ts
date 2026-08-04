export * as Scheduler from "."

import postgres from "postgres"
import { Context, Effect, Layer, Schema, Exit } from "effect"
import { Cron } from "croner"
import { Identifier } from "@/id/id"
import { Database } from "@/storage/db"

export const ID = Schema.String.check(Schema.isPattern(/^sch_[0-9A-Za-z]+$/)).pipe(Schema.brand("Scheduler.ID"))
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  ownerType: Schema.String,
  ownerId: Schema.String,
  cron: Schema.String,
  enabled: Schema.Boolean,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  lastRunAt: Schema.optional(Schema.Number),
  nextRunAt: Schema.optional(Schema.Number),
  runCount: Schema.Number,
  lastError: Schema.optional(Schema.String),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type Info = typeof Info.Type

export const CreateInput = Schema.Struct({
  ownerType: Schema.String,
  ownerId: Schema.String,
  cron: Schema.String,
  payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type CreateInput = typeof CreateInput.Type

export const UpdateInput = Schema.Struct({
  cron: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type UpdateInput = typeof UpdateInput.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Scheduler.NotFound", {
  scheduleID: ID,
}) {}

export class InvalidCronError extends Schema.TaggedErrorClass<InvalidCronError>()("Scheduler.InvalidCron", {
  cron: Schema.String,
}) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("Scheduler.StorageError", {
  message: Schema.String,
}) {}

type ScheduleHandler = (ownerId: string, payload: unknown) => Effect.Effect<void, unknown>

export interface Interface {
  readonly register: (ownerType: string, handler: ScheduleHandler) => void
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidCronError | StorageError>
  readonly update: (id: ID, input: UpdateInput) => Effect.Effect<Info, NotFoundError | InvalidCronError | StorageError>
  readonly remove: (id: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly list: (ownerType: string, ownerId: string) => Effect.Effect<Info[], StorageError>
  readonly tick: () => Effect.Effect<void, StorageError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Scheduler") {}

type Sql = ReturnType<typeof postgres>
type Row = Record<string, unknown>

const client = () => (Database.Client() as unknown as { $client: Sql }).$client
const asRows = (value: unknown) => value as Row[]
const json = <A>(value: unknown, fallback: A): A => {
  if (value === null || value === undefined) return fallback
  return (typeof value === "string" ? JSON.parse(value) : value) as A
}
const optional = <A>(value: A | null | undefined) => value ?? undefined
const pgJson = (value: unknown) => JSON.stringify(value)

function scheduleID() {
  return ID.make(Identifier.create("sch", "ascending"))
}

function nextRunFromCron(cron: string): number | null {
  try {
    const next = new Cron(cron).nextRun()
    return next ? next.getTime() : null
  } catch {
    return null
  }
}

function fromRow(row: Row): Info {
  return Info.make({
    id: ID.make(String(row.id)),
    ownerType: String(row.owner_type),
    ownerId: String(row.owner_id),
    cron: String(row.cron),
    enabled: Boolean(row.enabled),
    payload: json(row.payload, {}),
    lastRunAt: optional(row.last_run_at === null ? undefined : Number(row.last_run_at)),
    nextRunAt: optional(row.next_run_at === null ? undefined : Number(row.next_run_at)),
    runCount: Number(row.run_count),
    lastError: optional(row.last_error as string | null),
    time: { created: Number(row.time_created), updated: Number(row.time_updated) },
  })
}

function storage<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: () => new StorageError({ message: "Scheduler storage operation failed" }),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const handlers = new Map<string, ScheduleHandler>()

    const register = (ownerType: string, handler: ScheduleHandler) => {
      handlers.set(ownerType, handler)
    }

    const find = Effect.fn("Scheduler.find")(function* (id: ID) {
      const rows = yield* storage(() => client()`SELECT * FROM schedule WHERE id = ${id}`)
      return asRows(rows)[0]
    })

    const get = Effect.fn("Scheduler.get")(function* (id: ID) {
      const row = yield* find(id)
      if (!row) return yield* new NotFoundError({ scheduleID: id })
      return fromRow(row)
    })

    const create = Effect.fn("Scheduler.create")(function* (input: CreateInput) {
      const next = nextRunFromCron(input.cron)
      if (next === null) return yield* new InvalidCronError({ cron: input.cron })
      const id = scheduleID()
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        INSERT INTO schedule (id, owner_type, owner_id, cron, enabled, payload, next_run_at, run_count, time_created, time_updated)
        VALUES (${id}, ${input.ownerType}, ${input.ownerId}, ${input.cron}, true,
          ${pgJson(input.payload ?? {})}::jsonb, ${next}, 0, ${now}, ${now})
        RETURNING *
      `,
      )
      return fromRow(asRows(rows)[0])
    })

    const update = Effect.fn("Scheduler.update")(function* (id: ID, input: UpdateInput) {
      const current = yield* get(id)
      const cron = input.cron ?? current.cron
      const next = input.cron ? nextRunFromCron(cron) : (current.nextRunAt ?? null)
      if (input.cron && next === null) return yield* new InvalidCronError({ cron })
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        UPDATE schedule SET
          cron = ${cron},
          enabled = ${input.enabled ?? current.enabled},
          payload = ${pgJson(input.payload ?? current.payload)}::jsonb,
          next_run_at = ${next},
          time_updated = ${now}
        WHERE id = ${id}
        RETURNING *
      `,
      )
      return fromRow(asRows(rows)[0])
    })

    const remove = Effect.fn("Scheduler.remove")(function* (id: ID) {
      yield* get(id)
      yield* storage(() => client()`DELETE FROM schedule WHERE id = ${id}`)
    })

    const list = Effect.fn("Scheduler.list")(function* (ownerType: string, ownerId: string) {
      const rows = yield* storage(
        () =>
          client()`SELECT * FROM schedule WHERE owner_type = ${ownerType} AND owner_id = ${ownerId} ORDER BY time_created DESC`,
      )
      return asRows(rows).map(fromRow)
    })

    const tick = Effect.fn("Scheduler.tick")(function* () {
      const now = Date.now()
      const rows = yield* storage(
        () =>
          client()`SELECT * FROM schedule WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= ${now} ORDER BY next_run_at`,
      )
      const schedules = asRows(rows)
      for (const row of schedules) {
        const schedule = fromRow(row)
        const handler = handlers.get(schedule.ownerType)
        if (!handler) {
          yield* storage(
            () => client()`
            UPDATE schedule SET last_error = ${"No handler registered for owner_type: " + schedule.ownerType},
              time_updated = ${Date.now()}
            WHERE id = ${schedule.id}
          `,
          )
          continue
        }
        const exit = yield* Effect.exit(handler(schedule.ownerId, schedule.payload))
        const next = nextRunFromCron(schedule.cron)
        const now2 = Date.now()
        if (Exit.isFailure(exit)) {
          const errorMsg = "Execution failed"
          yield* storage(
            () => client()`
            UPDATE schedule SET last_run_at = ${now2}, next_run_at = ${next},
              run_count = run_count + 1, last_error = ${errorMsg}, time_updated = ${now2}
            WHERE id = ${schedule.id}
          `,
          )
        } else {
          yield* storage(
            () => client()`
            UPDATE schedule SET last_run_at = ${now2}, next_run_at = ${next},
              run_count = run_count + 1, last_error = NULL, time_updated = ${now2}
            WHERE id = ${schedule.id}
          `,
          )
        }
      }
    })

    return Service.of({ register, create, update, remove, get, list, tick })
  }),
)

export const live = layer
