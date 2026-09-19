import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionPluginTable } from "./session-plugin.pg"
import type { SessionID } from "../session/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"

export namespace SessionPlugin {
  export const Row = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    source: z.enum(["code", "npm"]).default("code"),
    spec: z.string().nullish(),
    code: z.string(),
    enabled: z.boolean().default(true),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Row = z.infer<typeof Row>

  export type Input = {
    name: string
    description?: string
    code?: string
    source?: "code" | "npm"
    spec?: string
    enabled?: boolean
  }

  function id() {
    return `spl_${randomBytes(12).toString("base64url")}`
  }

  const db = <T>(
    fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never) => T,
  ) => Effect.promise(() => Database.use(fn) as Promise<T>)

  export interface Interface {
    readonly list: (sessionID: SessionID) => Effect.Effect<Row[]>
    readonly get: (sessionID: SessionID, name: string) => Effect.Effect<Row | undefined>
    readonly upsert: (sessionID: SessionID, input: Input) => Effect.Effect<Row>
    readonly remove: (sessionID: SessionID, name: string) => Effect.Effect<void>
    readonly removeAll: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPlugin") {}

  export const noopLayer = Layer.succeed(
    Service,
    Service.of({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      upsert: (sessionID, input) =>
        Effect.succeed({
          id: id(),
          session_id: sessionID as string,
          name: input.name,
           description: input.description ?? null,
           source: input.source ?? "code",
           spec: input.spec ?? null,
           code: input.code ?? "",
          enabled: input.enabled ?? true,
          time_created: Date.now(),
          time_updated: Date.now(),
        }),
      remove: () => Effect.void,
      removeAll: () => Effect.void,
    }),
  )

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        list: Effect.fn("SessionPlugin.list")(function* (sessionID) {
          const rows = yield* db((d) =>
            d
              .select()
              .from(SessionPluginTable)
              .where(eq(SessionPluginTable.session_id, sessionID))
              .orderBy(asc(SessionPluginTable.name))
              .all(),
          )
          return rows.map((row: unknown) => Row.parse(row))
        }),
        get: Effect.fn("SessionPlugin.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d
              .select()
              .from(SessionPluginTable)
              .where(and(eq(SessionPluginTable.session_id, sessionID), eq(SessionPluginTable.name, name)))
              .get(),
          )
          return row ? Row.parse(row) : undefined
        }),
        upsert: Effect.fn("SessionPlugin.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const rows = yield* db((d) =>
            d
              .insert(SessionPluginTable)
              .values({
                id: id(),
                session_id: sessionID,
                name: input.name,
                   description: input.description,
                   source: input.source ?? "code",
                   spec: input.spec ?? null,
                   code: input.code ?? "",
                enabled: input.enabled ?? true,
                time_created: now,
                time_updated: now,
              })
              .onConflictDoUpdate({
                target: [SessionPluginTable.session_id, SessionPluginTable.name],
                set: {
                  description: input.description,
                  code: input.code,
                  enabled: input.enabled ?? true,
                  time_updated: now,
                },
              })
              .returning(),
          )
          if (!rows[0]) throw new Error("SessionPlugin upsert returned no rows")
          return Row.parse(rows[0])
        }),
        remove: Effect.fn("SessionPlugin.remove")(function* (sessionID, name) {
          yield* db((d) =>
            d.delete(SessionPluginTable).where(and(eq(SessionPluginTable.session_id, sessionID), eq(SessionPluginTable.name, name))).run(),
          )
        }),
        removeAll: Effect.fn("SessionPlugin.removeAll")(function* (sessionID) {
          yield* db((d) => d.delete(SessionPluginTable).where(eq(SessionPluginTable.session_id, sessionID)).run())
        }),
      })
    }),
  )

  function parsePgRow(row: any): Row {
    return Row.parse({
      ...row,
      source: row.source ?? "code",
      spec: row.spec ?? null,
      code: row.code ?? "",
      enabled: row.enabled ?? true,
      time_created: Number(row.time_created),
      time_updated: Number(row.time_updated),
    })
  }

  export const pgLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const sql = (Database.Client() as any).$client
      const query = (strings: TemplateStringsArray, ...values: any[]) =>
        Effect.promise(() => sql(strings, ...values) as Promise<any[]>)

      return Service.of({
        list: Effect.fn("SessionPlugin.list")(function* (sessionID) {
          return (yield* query`SELECT * FROM session_plugins WHERE session_id = ${sessionID} ORDER BY name ASC`).map(parsePgRow)
        }),
        get: Effect.fn("SessionPlugin.get")(function* (sessionID, name) {
          const rows = yield* query`SELECT * FROM session_plugins WHERE session_id = ${sessionID} AND name = ${name}`
          return rows[0] ? parsePgRow(rows[0]) : undefined
        }),
        upsert: Effect.fn("SessionPlugin.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const rows = yield* query`
           INSERT INTO session_plugins (id, session_id, name, description, source, spec, code, enabled, time_created, time_updated)
           VALUES (${id()}, ${sessionID}, ${input.name}, ${input.description ?? null}, ${input.source ?? "code"}, ${input.spec ?? null}, ${input.code ?? ""}, ${input.enabled ?? true}, ${now}, ${now})
           ON CONFLICT (session_id, name) DO UPDATE SET
              description = EXCLUDED.description, source = EXCLUDED.source,
              spec = EXCLUDED.spec, code = EXCLUDED.code,
              enabled = EXCLUDED.enabled, time_updated = EXCLUDED.time_updated
            RETURNING *
          `
          if (!rows[0]) throw new Error("SessionPlugin upsert returned no rows")
          return parsePgRow(rows[0])
        }),
        remove: Effect.fn("SessionPlugin.remove")(function* (sessionID, name) {
          yield* query`DELETE FROM session_plugins WHERE session_id = ${sessionID} AND name = ${name}`
        }),
        removeAll: Effect.fn("SessionPlugin.removeAll")(function* (sessionID) {
          yield* query`DELETE FROM session_plugins WHERE session_id = ${sessionID}`
        }),
      })
    }),
  )

  export const node = LayerNode.make({
    service: Service,
    layer: Flag.OPENCODE_DATABASE_URL ? pgLayer : noopLayer,
    deps: [],
  })
}
