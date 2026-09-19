import { randomBytes } from "crypto"
import z from "zod"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Context, Layer } from "effect"
import { Database, eq } from "../storage/db"
import { SessionAgentsMdTable } from "./agents-md.pg"
import type { SessionID } from "./schema"

export namespace SessionAgentsMd {
  export const Row = z.object({
    id: z.string(),
    session_id: z.string(),
    content: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Row = z.infer<typeof Row>

  export type Input = { content: string }

  function id() {
    return `sam_${randomBytes(12).toString("base64url")}`
  }

  export interface Interface {
    readonly get: (sessionID: SessionID) => Effect.Effect<Row | undefined>
    readonly upsert: (sessionID: SessionID, input: Input) => Effect.Effect<Row>
    readonly remove: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAgentsMd") {}

  export const noopLayer = Layer.succeed(
    Service,
    Service.of({
      get: () => Effect.succeed(undefined),
      upsert: (sessionID, input) => Effect.succeed({
        id: id(),
        session_id: sessionID as string,
        content: input.content,
        time_created: Date.now(),
        time_updated: Date.now(),
      }),
      remove: () => Effect.void,
    }),
  )

  const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never) => T) =>
    Effect.promise(() => Database.use(fn) as Promise<T>)

  function parseRow(row: Record<string, unknown>): Row {
    return Row.parse({
      id: String(row.id),
      session_id: String(row.session_id),
      content: String(row.content),
      time_created: Number(row.time_created),
      time_updated: Number(row.time_updated),
    })
  }

  export const layer = Layer.effect(
    Service,
    Effect.succeed(
      Service.of({
        get: Effect.fn("SessionAgentsMd.get")(function* (sessionID) {
          const row = yield* db((d) => d.select().from(SessionAgentsMdTable).where(eq(SessionAgentsMdTable.session_id, sessionID)).get())
          return row ? parseRow(row as Record<string, unknown>) : undefined
        }),
        upsert: Effect.fn("SessionAgentsMd.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const rows = yield* db((d) => d.insert(SessionAgentsMdTable).values({
            id: id(),
            session_id: sessionID,
            content: input.content,
            time_created: now,
            time_updated: now,
          }).onConflictDoUpdate({
            target: SessionAgentsMdTable.session_id,
            set: { content: input.content, time_updated: now },
          }).returning())
          if (!rows[0]) throw new Error("Session AGENTS.md upsert returned no rows")
          return parseRow(rows[0] as Record<string, unknown>)
        }),
        remove: Effect.fn("SessionAgentsMd.remove")(function* (sessionID) {
          yield* db((d) => d.delete(SessionAgentsMdTable).where(eq(SessionAgentsMdTable.session_id, sessionID)).run())
        }),
      }),
    ),
  )

  export const pgLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const sql = (Database.Client() as any).$client
      const query = (strings: TemplateStringsArray, ...values: any[]) =>
        Effect.promise(() => sql(strings, ...values) as Promise<any[]>)

      return Service.of({
        get: Effect.fn("SessionAgentsMd.get")(function* (sessionID) {
          const rows = yield* query`SELECT * FROM session_agents_md WHERE session_id = ${sessionID}`
          return rows[0] ? parseRow(rows[0]) : undefined
        }),
        upsert: Effect.fn("SessionAgentsMd.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const rows = yield* query`
            INSERT INTO session_agents_md (id, session_id, content, time_created, time_updated)
            VALUES (${id()}, ${sessionID}, ${input.content}, ${now}, ${now})
            ON CONFLICT (session_id) DO UPDATE SET
              content = EXCLUDED.content,
              time_updated = EXCLUDED.time_updated
            RETURNING *
          `
          if (!rows[0]) throw new Error("Session AGENTS.md upsert returned no rows")
          return parseRow(rows[0])
        }),
        remove: Effect.fn("SessionAgentsMd.remove")(function* (sessionID) {
          yield* query`DELETE FROM session_agents_md WHERE session_id = ${sessionID}`
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
