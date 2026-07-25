import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database } from "../storage/db"
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
