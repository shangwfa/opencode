import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionSkillTable } from "./skill.pg"
import type { SessionID } from "../session/schema"
import { SkillResource } from "./resource"

export namespace SessionSkill {
  export const Info = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    description: z.string(),
    content: z.string(),
    resources: z
      .array(
        z.object({
          path: z.string(),
          type: z.enum(["doc", "script", "template", "asset"]),
          content: z.string(),
          size: z.number(),
          digest: z.string(),
        }),
      )
      .default([]),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export type Input = {
    name: string
    description: string
    content: string
    resources?: SkillResource.Input[]
  }

  function id() {
    return `ssk_${randomBytes(12).toString("base64url")}`
  }

  const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never) => T) =>
    Effect.promise(() => Database.use(fn))

  export interface Interface {
    readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
    readonly get: (sessionID: SessionID, name: string) => Effect.Effect<Info | undefined>
    readonly upsert: (sessionID: SessionID, input: Input) => Effect.Effect<Info, Error>
    readonly remove: (sessionID: SessionID, name: string) => Effect.Effect<void>
    readonly removeAll: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSkill") {}

  export const noopLayer = Layer.succeed(
    Service,
    Service.of({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      upsert: (_sessionID, input) =>
        Effect.try({
          try: () => {
            const resources = SkillResource.validateBundle((input.resources ?? []).map(SkillResource.make))
            return {
              id: id(),
              session_id: _sessionID as string,
              name: input.name,
              description: input.description,
              content: input.content,
              resources,
              time_created: Date.now(),
              time_updated: Date.now(),
            }
          },
          catch: (error) => error as Error,
        }),
      remove: () => Effect.void,
      removeAll: () => Effect.void,
    }),
  )

  // PG returns jsonb as string and bigint as string; coerce them
  function parseRow(r: any): Info {
    return Info.parse({
      ...r,
      resources: (typeof r.resources === "string" ? JSON.parse(r.resources) : r.resources).map(
        SkillResource.fromStored,
      ),
      time_created: Number(r.time_created),
      time_updated: Number(r.time_updated),
    })
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        list: Effect.fn("SessionSkill.list")(function* (sessionID) {
          const rows = yield* db((d) =>
            d
              .select()
              .from(SessionSkillTable)
              .where(eq(SessionSkillTable.session_id, sessionID))
              .orderBy(asc(SessionSkillTable.name))
              .all(),
          )
          return (rows as any[]).map(parseRow)
        }),

        get: Effect.fn("SessionSkill.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d
              .select()
              .from(SessionSkillTable)
              .where(and(eq(SessionSkillTable.session_id, sessionID), eq(SessionSkillTable.name, name)))
              .get(),
          )
          if (!row) return undefined
          return parseRow(row)
        }),

        upsert: Effect.fn("SessionSkill.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const resources = yield* Effect.try({
            try: () => SkillResource.validateBundle((input.resources ?? []).map(SkillResource.make)),
            catch: (error) => error as Error,
          })
          const row = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            description: input.description,
            content: input.content,
            resources,
            time_created: now,
            time_updated: now,
          }
          const rows = yield* db((d: any) =>
            d
              .insert(SessionSkillTable)
              .values(row)
              .onConflictDoUpdate({
                target: [SessionSkillTable.session_id, SessionSkillTable.name],
                set: {
                  description: input.description,
                  content: input.content,
                  resources,
                  time_updated: now,
                } as any,
              })
              .returning(),
          )
          return parseRow((rows as any[])[0])
        }),

        remove: Effect.fn("SessionSkill.remove")(function* (sessionID, name) {
          yield* db((d) =>
            d
              .delete(SessionSkillTable)
              .where(and(eq(SessionSkillTable.session_id, sessionID), eq(SessionSkillTable.name, name)))
              .run(),
          )
        }),

        removeAll: Effect.fn("SessionSkill.removeAll")(function* (sessionID) {
          yield* db((d) => d.delete(SessionSkillTable).where(eq(SessionSkillTable.session_id, sessionID)).run())
        }),
      })
    }),
  )
}
