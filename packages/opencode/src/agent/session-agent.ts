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
  type Insert = typeof SessionAgentTable.$inferInsert

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
  ) => Effect.promise(() => Database.use(fn))

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
          description: input.description,
          mode: input.mode ?? "all",
          prompt: input.prompt,
          permission: input.permission ?? [],
          model: input.model,
          temperature: input.temperature,
          top_p: input.topP,
          steps: input.steps,
          color: input.color,
          variant: input.variant,
          options: input.options ?? {},
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
          const row: Insert = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            description: input.description ?? null,
            mode: input.mode ?? "all",
            prompt: input.prompt ?? null,
            permission: input.permission ?? [],
            model: input.model ?? null,
            temperature: input.temperature ?? null,
            top_p: input.topP ?? null,
            steps: input.steps ?? null,
            color: input.color ?? null,
            variant: input.variant ?? null,
            options: input.options ?? {},
            time_created: now,
            time_updated: now,
          }
          const rows = yield* db((d) =>
            d
              .insert(SessionAgentTable)
              .values(row)
              .onConflictDoUpdate({
                target: [SessionAgentTable.session_id, SessionAgentTable.name],
                set: {
                  description: input.description ?? null,
                  mode: input.mode ?? "all",
                  prompt: input.prompt ?? null,
                  permission: input.permission ?? [],
                  model: input.model ?? null,
                  temperature: input.temperature ?? null,
                  top_p: input.topP ?? null,
                  steps: input.steps ?? null,
                  color: input.color ?? null,
                  variant: input.variant ?? null,
                  options: input.options ?? {},
                  time_updated: now,
                },
              })
              .returning(),
          )
          const result = rows[0]
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
}
