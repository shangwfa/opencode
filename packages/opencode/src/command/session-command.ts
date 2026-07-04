import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionCommandTable } from "./session-command.pg"
import type { SessionID } from "../session/schema"

export namespace SessionCommand {
  export const Row = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    template: z.string(),
    agent: z.string().nullish(),
    model: z.string().nullish(),
    subtask: z.boolean().nullish(),
    hints: z.array(z.string()).default([]),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Row = z.infer<typeof Row>

  export type Input = {
    name: string
    description?: string
    template: string
    agent?: string
    model?: string
    subtask?: boolean
    hints?: readonly string[]
  }

  function id() {
    return `scmd_${randomBytes(12).toString("base64url")}`
  }

  const db = <T>(
    fn: (
      d: Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never,
    ) => T,
  ) => Effect.promise(() => Database.use(fn) as Promise<T>)

  export interface Interface {
    readonly list: (sessionID: SessionID) => Effect.Effect<Row[]>
    readonly get: (sessionID: SessionID, name: string) => Effect.Effect<Row | undefined>
    readonly upsert: (sessionID: SessionID, input: Input) => Effect.Effect<Row>
    readonly remove: (sessionID: SessionID, name: string) => Effect.Effect<void>
    readonly removeAll: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCommand") {}

  export const noopLayer = Layer.succeed(
    Service,
    Service.of({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      upsert: (_sessionID, input) =>
        Effect.succeed({
          id: id(),
          session_id: _sessionID as string,
          name: input.name,
          description: input.description ?? null,
          template: input.template,
          agent: input.agent ?? null,
          model: input.model ?? null,
          subtask: input.subtask ?? null,
          hints: [...(input.hints ?? [])],
          time_created: Date.now(),
          time_updated: Date.now(),
        } as Row),
      remove: () => Effect.void,
      removeAll: () => Effect.void,
    }),
  )

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        list: Effect.fn("SessionCommand.list")(function* (sessionID) {
          const rows = yield* db((d) =>
            d
              .select()
              .from(SessionCommandTable)
              .where(eq(SessionCommandTable.session_id, sessionID))
              .orderBy(asc(SessionCommandTable.name))
              .all(),
          )
          return rows.map((row: unknown) => Row.parse(row))
        }),

        get: Effect.fn("SessionCommand.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d
              .select()
              .from(SessionCommandTable)
              .where(
                and(eq(SessionCommandTable.session_id, sessionID), eq(SessionCommandTable.name, name)),
              )
              .get(),
          )
          if (!row) return undefined
          return Row.parse(row)
        }),

        upsert: Effect.fn("SessionCommand.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const row = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            description: input.description ?? null,
            template: input.template,
            agent: input.agent ?? null,
            model: input.model ?? null,
            subtask: input.subtask ?? null,
            hints: [...(input.hints ?? [])] as any,
            time_created: now,
            time_updated: now,
          } as any
          const rows = yield* db((d: any) =>
            d
              .insert(SessionCommandTable)
              .values(row)
              .onConflictDoUpdate({
                target: [SessionCommandTable.session_id, SessionCommandTable.name],
                set: {
                  description: input.description ?? null,
                  template: input.template,
                  agent: input.agent ?? null,
                  model: input.model ?? null,
                  subtask: input.subtask ?? null,
                  hints: [...(input.hints ?? [])] as any,
                  time_updated: now,
                } as any,
              })
              .returning(),
          )
          const result = (rows as any[])[0]
          if (!result) throw new Error("SessionCommand upsert returned no rows")
          return Row.parse(result)
        }),

        remove: Effect.fn("SessionCommand.remove")(function* (sessionID, name) {
          yield* db((d) =>
            d
              .delete(SessionCommandTable)
              .where(
                and(eq(SessionCommandTable.session_id, sessionID), eq(SessionCommandTable.name, name)),
              )
              .run(),
          )
        }),

        removeAll: Effect.fn("SessionCommand.removeAll")(function* (sessionID) {
          yield* db((d) =>
            d.delete(SessionCommandTable).where(eq(SessionCommandTable.session_id, sessionID)).run(),
          )
        }),
      })
    }),
  )

  // PG row → Row: postgres returns bigint as string and jsonb as string
  function parsePgRow(r: any): Row {
    const parseJson = (v: any) => (typeof v === "string" ? JSON.parse(v) : v)
    return Row.parse({
      ...r,
      hints: parseJson(r.hints),
      time_created: Number(r.time_created),
      time_updated: Number(r.time_updated),
    })
  }

  export const pgLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const sql = (Database.Client() as any).$client

      const query = (strings: TemplateStringsArray, ...values: any[]) =>
        Effect.promise(() => sql(strings, ...values) as Promise<any[]>)

      return Service.of({
        list: Effect.fn("SessionCommand.list")(function* (sessionID) {
          const rows = yield* query`SELECT * FROM session_commands WHERE session_id = ${sessionID} ORDER BY name ASC`
          return rows.map(parsePgRow)
        }),

        get: Effect.fn("SessionCommand.get")(function* (sessionID, name) {
          const rows = yield* query`SELECT * FROM session_commands WHERE session_id = ${sessionID} AND name = ${name}`
          if (rows.length === 0) return undefined
          return parsePgRow(rows[0])
        }),

        upsert: Effect.fn("SessionCommand.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const newId = id()
          const hnts = JSON.stringify([...(input.hints ?? [])])
          const rows = yield* query`
            INSERT INTO session_commands (id, session_id, name, description, template, agent, model, subtask, hints, time_created, time_updated)
            VALUES (${newId}, ${sessionID}, ${input.name}, ${input.description ?? null}, ${input.template}, ${input.agent ?? null}, ${input.model ?? null}, ${input.subtask ?? null}, ${hnts}::jsonb, ${now}, ${now})
            ON CONFLICT (session_id, name) DO UPDATE SET
              description = EXCLUDED.description, template = EXCLUDED.template, agent = EXCLUDED.agent,
              model = EXCLUDED.model, subtask = EXCLUDED.subtask, hints = EXCLUDED.hints, time_updated = EXCLUDED.time_updated
            RETURNING *
          `
          if (!rows[0]) throw new Error("SessionCommand upsert returned no rows")
          return parsePgRow(rows[0])
        }),

        remove: Effect.fn("SessionCommand.remove")(function* (sessionID, name) {
          yield* query`DELETE FROM session_commands WHERE session_id = ${sessionID} AND name = ${name}`
        }),

        removeAll: Effect.fn("SessionCommand.removeAll")(function* (sessionID) {
          yield* query`DELETE FROM session_commands WHERE session_id = ${sessionID}`
        }),
      })
    }),
  )
}
