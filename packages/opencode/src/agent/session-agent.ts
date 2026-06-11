import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionAgentTable } from "./agent.pg"
import type { SessionID } from "../session/schema"
import type { Permission } from "@/permission"
import type { ModelID, ProviderID } from "@/provider/schema"

export namespace SessionAgent {
  export const Row = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    mode: z.enum(["subagent", "primary", "all"]).default("all"),
    prompt: z.string().nullish(),
    permission: z
      .array(
        z.object({
          permission: z.string(),
          pattern: z.string(),
          action: z.enum(["allow", "deny", "ask"]),
        }),
      )
      .default([]),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .nullish(),
    temperature: z.number().nullish(),
    top_p: z.number().nullish(),
    steps: z.number().int().positive().nullish(),
    color: z.string().nullish(),
    variant: z.string().nullish(),
    options: z.record(z.string(), z.any()).default({}),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Row = z.infer<typeof Row>

  export type Input = {
    name: string
    description?: string
    mode?: "subagent" | "primary" | "all"
    prompt?: string
    permission?: Permission.Ruleset
    model?: { providerID: ProviderID; modelID: ModelID }
    temperature?: number
    topP?: number
    steps?: number
    color?: string
    variant?: string
    options?: Record<string, unknown>
  }

  function id() {
    return `sag_${randomBytes(12).toString("base64url")}`
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

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAgent") {}

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
          mode: input.mode ?? "all",
          prompt: input.prompt ?? null,
          permission: [...(input.permission ?? [])],
          model: input.model ?? null,
          temperature: input.temperature ?? null,
          top_p: input.topP ?? null,
          steps: input.steps ?? null,
          color: input.color ?? null,
          variant: input.variant ?? null,
          options: input.options ? { ...input.options } : {},
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
        list: Effect.fn("SessionAgent.list")(function* (sessionID) {
          const rows = yield* db((d) =>
            d
              .select()
              .from(SessionAgentTable)
              .where(eq(SessionAgentTable.session_id, sessionID))
              .orderBy(asc(SessionAgentTable.name))
              .all(),
          )
          return rows.map((row: unknown) => Row.parse(row))
        }),

        get: Effect.fn("SessionAgent.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d
              .select()
              .from(SessionAgentTable)
              .where(
                and(eq(SessionAgentTable.session_id, sessionID), eq(SessionAgentTable.name, name)),
              )
              .get(),
          )
          if (!row) return undefined
          return Row.parse(row)
        }),

        upsert: Effect.fn("SessionAgent.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const row = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            description: input.description ?? null,
            mode: input.mode ?? "all",
            prompt: input.prompt ?? null,
            permission: [...(input.permission ?? [])] as any,
            model: input.model ?? null,
            temperature: input.temperature ?? null,
            top_p: input.topP ?? null,
            steps: input.steps ?? null,
            color: input.color ?? null,
            variant: input.variant ?? null,
            options: input.options ? { ...input.options } : {},
            time_created: now,
            time_updated: now,
          } as any
          const rows = yield* db((d: any) =>
            d
              .insert(SessionAgentTable)
              .values(row)
              .onConflictDoUpdate({
                target: [SessionAgentTable.session_id, SessionAgentTable.name],
                set: {
                  description: input.description ?? null,
                  mode: input.mode ?? "all",
                  prompt: input.prompt ?? null,
                  permission: [...(input.permission ?? [])] as any,
                  model: input.model ?? null,
                  temperature: input.temperature ?? null,
                  top_p: input.topP ?? null,
                  steps: input.steps ?? null,
                  color: input.color ?? null,
                  variant: input.variant ?? null,
                  options: input.options ? { ...input.options } : {},
                  time_updated: now,
                } as any,
              })
              .returning(),
          )
          const result = (rows as any[])[0]
          if (!result) throw new Error("Session agent upsert returned no rows")
          return Row.parse(result)
        }),

        remove: Effect.fn("SessionAgent.remove")(function* (sessionID, name) {
          yield* db((d) =>
            d
              .delete(SessionAgentTable)
              .where(
                and(eq(SessionAgentTable.session_id, sessionID), eq(SessionAgentTable.name, name)),
              )
              .run(),
          )
        }),

        removeAll: Effect.fn("SessionAgent.removeAll")(function* (sessionID) {
          yield* db((d) =>
            d.delete(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).run(),
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
      permission: parseJson(r.permission),
      model: r.model != null ? parseJson(r.model) : null,
      options: parseJson(r.options),
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
        list: Effect.fn("SessionAgent.list")(function* (sessionID) {
          const rows = yield* query`SELECT * FROM session_agents WHERE session_id = ${sessionID} ORDER BY name ASC`
          return rows.map(parsePgRow)
        }),

        get: Effect.fn("SessionAgent.get")(function* (sessionID, name) {
          const rows = yield* query`SELECT * FROM session_agents WHERE session_id = ${sessionID} AND name = ${name}`
          if (rows.length === 0) return undefined
          return parsePgRow(rows[0])
        }),

        upsert: Effect.fn("SessionAgent.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const newId = id()
          const perm = JSON.stringify([...(input.permission ?? [])])
          const mdl = input.model ? JSON.stringify(input.model) : null
          const opts = JSON.stringify(input.options ?? {})
          const rows = yield* query`
            INSERT INTO session_agents (id, session_id, name, description, mode, prompt, permission, model, temperature, top_p, steps, color, variant, options, time_created, time_updated)
            VALUES (${newId}, ${sessionID}, ${input.name}, ${input.description ?? null}, ${input.mode ?? "all"}, ${input.prompt ?? null}, ${perm}::jsonb, ${mdl}::jsonb, ${input.temperature ?? null}, ${input.topP ?? null}, ${input.steps ?? null}, ${input.color ?? null}, ${input.variant ?? null}, ${opts}::jsonb, ${now}, ${now})
            ON CONFLICT (session_id, name) DO UPDATE SET
              description = EXCLUDED.description, mode = EXCLUDED.mode, prompt = EXCLUDED.prompt,
              permission = EXCLUDED.permission, model = EXCLUDED.model, temperature = EXCLUDED.temperature,
              top_p = EXCLUDED.top_p, steps = EXCLUDED.steps, color = EXCLUDED.color,
              variant = EXCLUDED.variant, options = EXCLUDED.options, time_updated = EXCLUDED.time_updated
            RETURNING *
          `
          if (!rows[0]) throw new Error("Session agent upsert returned no rows")
          return parsePgRow(rows[0])
        }),

        remove: Effect.fn("SessionAgent.remove")(function* (sessionID, name) {
          yield* query`DELETE FROM session_agents WHERE session_id = ${sessionID} AND name = ${name}`
        }),

        removeAll: Effect.fn("SessionAgent.removeAll")(function* (sessionID) {
          yield* query`DELETE FROM session_agents WHERE session_id = ${sessionID}`
        }),
      })
    }),
  )
}
