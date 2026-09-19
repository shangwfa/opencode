import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionMcpTable } from "./session-mcp.pg"
import type { SessionID } from "../session/schema"

export namespace SessionMcp {
  export const Row = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    type: z.enum(["local", "remote"]),
    command: z.array(z.string()).nullish(),
    url: z.string().nullish(),
    environment: z.record(z.string(), z.string()).default({}),
    headers: z.record(z.string(), z.string()).default({}),
    enabled: z.boolean().default(true),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Row = z.infer<typeof Row>

  export type Input = {
    name: string
    type: "local" | "remote"
    command?: string[]
    url?: string
    environment?: Record<string, string>
    headers?: Record<string, string>
    enabled?: boolean
  }

  function id() {
    return `smc_${randomBytes(12).toString("base64url")}`
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

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMcp") {}

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
          type: input.type,
          command: input.command ?? null,
          url: input.url ?? null,
          environment: input.environment ?? {},
          headers: input.headers ?? {},
          enabled: input.enabled ?? true,
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
        list: Effect.fn("SessionMcp.list")(function* (sessionID) {
          const rows = yield* db((d) =>
            d
              .select()
              .from(SessionMcpTable)
              .where(eq(SessionMcpTable.session_id, sessionID))
              .orderBy(asc(SessionMcpTable.name))
              .all(),
          )
          return rows.map((row: unknown) => Row.parse(row))
        }),

        get: Effect.fn("SessionMcp.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d
              .select()
              .from(SessionMcpTable)
              .where(
                and(eq(SessionMcpTable.session_id, sessionID), eq(SessionMcpTable.name, name)),
              )
              .get(),
          )
          if (!row) return undefined
          return Row.parse(row)
        }),

        upsert: Effect.fn("SessionMcp.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const row = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            type: input.type,
            command: input.command ?? null,
            url: input.url ?? null,
            environment: input.environment ?? {},
            headers: input.headers ?? {},
            enabled: input.enabled ?? true,
            time_created: now,
            time_updated: now,
          } as any
          const rows = yield* db((d: any) =>
            d
              .insert(SessionMcpTable)
              .values(row)
              .onConflictDoUpdate({
                target: [SessionMcpTable.session_id, SessionMcpTable.name],
                set: {
                  type: input.type,
                  command: input.command ?? null,
                  url: input.url ?? null,
                  environment: input.environment ?? {},
                  headers: input.headers ?? {},
                  enabled: input.enabled ?? true,
                  time_updated: now,
                } as any,
              })
              .returning(),
          )
          const result = (rows as any[])[0]
          if (!result) throw new Error("SessionMcp upsert returned no rows")
          return Row.parse(result)
        }),

        remove: Effect.fn("SessionMcp.remove")(function* (sessionID, name) {
          yield* db((d) =>
            d
              .delete(SessionMcpTable)
              .where(
                and(eq(SessionMcpTable.session_id, sessionID), eq(SessionMcpTable.name, name)),
              )
              .run(),
          )
        }),

        removeAll: Effect.fn("SessionMcp.removeAll")(function* (sessionID) {
          yield* db((d) =>
            d.delete(SessionMcpTable).where(eq(SessionMcpTable.session_id, sessionID)).run(),
          )
        }),
      })
    }),
  )

  function parsePgRow(r: any): Row {
    const parseJson = (v: any) => (typeof v === "string" ? JSON.parse(v) : v)
    return Row.parse({
      ...r,
      command: r.command != null ? parseJson(r.command) : null,
      environment: parseJson(r.environment),
      headers: parseJson(r.headers),
      enabled: parseJson(r.enabled),
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
        list: Effect.fn("SessionMcp.list")(function* (sessionID) {
          const rows = yield* query`SELECT * FROM session_mcps WHERE session_id = ${sessionID} ORDER BY name ASC`
          return rows.map(parsePgRow)
        }),

        get: Effect.fn("SessionMcp.get")(function* (sessionID, name) {
          const rows = yield* query`SELECT * FROM session_mcps WHERE session_id = ${sessionID} AND name = ${name}`
          if (rows.length === 0) return undefined
          return parsePgRow(rows[0])
        }),

        upsert: Effect.fn("SessionMcp.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const newId = id()
          const cmd = input.command ? JSON.stringify(input.command) : null
          const env = JSON.stringify(input.environment ?? {})
          const hdrs = JSON.stringify(input.headers ?? {})
          const en = JSON.stringify(input.enabled ?? true)
          const rows = yield* query`
            INSERT INTO session_mcps (id, session_id, name, type, command, url, environment, headers, enabled, time_created, time_updated)
            VALUES (${newId}, ${sessionID}, ${input.name}, ${input.type}, ${cmd}::jsonb, ${input.url ?? null}, ${env}::jsonb, ${hdrs}::jsonb, ${en}::jsonb, ${now}, ${now})
            ON CONFLICT (session_id, name) DO UPDATE SET
              type = EXCLUDED.type, command = EXCLUDED.command, url = EXCLUDED.url,
              environment = EXCLUDED.environment, headers = EXCLUDED.headers,
              enabled = EXCLUDED.enabled, time_updated = EXCLUDED.time_updated
            RETURNING *
          `
          if (!rows[0]) throw new Error("SessionMcp upsert returned no rows")
          return parsePgRow(rows[0])
        }),

        remove: Effect.fn("SessionMcp.remove")(function* (sessionID, name) {
          yield* query`DELETE FROM session_mcps WHERE session_id = ${sessionID} AND name = ${name}`
        }),

        removeAll: Effect.fn("SessionMcp.removeAll")(function* (sessionID) {
          yield* query`DELETE FROM session_mcps WHERE session_id = ${sessionID}`
        }),
      })
    }),
  )
}
