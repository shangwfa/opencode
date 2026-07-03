import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionToolTable } from "./session-tool.pg"
import type { SessionID } from "../session/schema"
import path from "path"
import { pathToFileURL } from "url"

const codeCache = new Map<string, Promise<any>>()

export async function importToolCode(code: string): Promise<any> {
  const cached = codeCache.get(code)
  if (cached) return cached

  const promise = (async () => {
    const fs = await import("fs/promises")
    const file = path.join(
      import.meta.dir,
      `.opencode-stl-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
    )
    await fs.writeFile(file, code)
    try {
      return await import(pathToFileURL(file).href)
    } finally {
      await fs.unlink(file).catch(() => {})
    }
  })()

  codeCache.set(code, promise)
  return promise
}

export namespace SessionTool {
  export const Row = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    description: z.string(),
    code: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Row = z.infer<typeof Row>

  export type Input = {
    name: string
    description: string
    code: string
  }

  function id() {
    return `stl_${randomBytes(12).toString("base64url")}`
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

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTool") {}

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
          description: input.description,
          code: input.code,
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
        list: Effect.fn("SessionTool.list")(function* (sessionID) {
          const rows = yield* db((d) =>
            d
              .select()
              .from(SessionToolTable)
              .where(eq(SessionToolTable.session_id, sessionID))
              .orderBy(asc(SessionToolTable.name))
              .all(),
          )
          return rows.map((row: unknown) => Row.parse(row))
        }),

        get: Effect.fn("SessionTool.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d
              .select()
              .from(SessionToolTable)
              .where(
                and(eq(SessionToolTable.session_id, sessionID), eq(SessionToolTable.name, name)),
              )
              .get(),
          )
          if (!row) return undefined
          return Row.parse(row)
        }),

        upsert: Effect.fn("SessionTool.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const row = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            description: input.description,
            code: input.code,
            time_created: now,
            time_updated: now,
          } as any
          const rows = yield* db((d: any) =>
            d
              .insert(SessionToolTable)
              .values(row)
              .onConflictDoUpdate({
                target: [SessionToolTable.session_id, SessionToolTable.name],
                set: {
                  description: input.description,
                  code: input.code,
                  time_updated: now,
                } as any,
              })
              .returning(),
          )
          const result = (rows as any[])[0]
          if (!result) throw new Error("SessionTool upsert returned no rows")
          return Row.parse(result)
        }),

        remove: Effect.fn("SessionTool.remove")(function* (sessionID, name) {
          yield* db((d) =>
            d
              .delete(SessionToolTable)
              .where(
                and(eq(SessionToolTable.session_id, sessionID), eq(SessionToolTable.name, name)),
              )
              .run(),
          )
        }),

        removeAll: Effect.fn("SessionTool.removeAll")(function* (sessionID) {
          yield* db((d) =>
            d.delete(SessionToolTable).where(eq(SessionToolTable.session_id, sessionID)).run(),
          )
        }),
      })
    }),
  )

  function parsePgRow(r: any): Row {
    return Row.parse({
      ...r,
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
        list: Effect.fn("SessionTool.list")(function* (sessionID) {
          const rows = yield* query`SELECT * FROM session_tools WHERE session_id = ${sessionID} ORDER BY name ASC`
          return rows.map(parsePgRow)
        }),

        get: Effect.fn("SessionTool.get")(function* (sessionID, name) {
          const rows = yield* query`SELECT * FROM session_tools WHERE session_id = ${sessionID} AND name = ${name}`
          if (rows.length === 0) return undefined
          return parsePgRow(rows[0])
        }),

        upsert: Effect.fn("SessionTool.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const newId = id()
          const rows = yield* query`
            INSERT INTO session_tools (id, session_id, name, description, code, time_created, time_updated)
            VALUES (${newId}, ${sessionID}, ${input.name}, ${input.description}, ${input.code}, ${now}, ${now})
            ON CONFLICT (session_id, name) DO UPDATE SET
              description = EXCLUDED.description, code = EXCLUDED.code, time_updated = EXCLUDED.time_updated
            RETURNING *
          `
          if (!rows[0]) throw new Error("SessionTool upsert returned no rows")
          return parsePgRow(rows[0])
        }),

        remove: Effect.fn("SessionTool.remove")(function* (sessionID, name) {
          yield* query`DELETE FROM session_tools WHERE session_id = ${sessionID} AND name = ${name}`
        }),

        removeAll: Effect.fn("SessionTool.removeAll")(function* (sessionID) {
          yield* query`DELETE FROM session_tools WHERE session_id = ${sessionID}`
        }),
      })
    }),
  )
}
