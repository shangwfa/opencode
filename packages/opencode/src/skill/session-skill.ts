import z from "zod"
import { randomBytes } from "crypto"
import { Effect, Context, Layer } from "effect"
import { Database, and, asc, eq } from "../storage/db"
import { SessionSkillTable } from "./skill.pg"
import type { SessionID } from "../session/schema"

export namespace SessionSkill {
  export const Info = z.object({
    id: z.string(),
    session_id: z.string(),
    name: z.string(),
    description: z.string(),
    content: z.string(),
    resources: z.array(z.object({
      path: z.string(),
      type: z.enum(["doc", "script", "template", "asset"]),
      content: z.string(),
    })).default([]),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Info = z.infer<typeof Info>

  export type Input = {
    name: string
    description: string
    content: string
    resources?: Info["resources"]
  }

  function id() {
    return `ssk_${randomBytes(12).toString("base64url")}`
  }

  const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => unknown ? D : never) => T) =>
    Effect.promise(() => Database.use(fn))

  export interface Interface {
    readonly list: (sessionID: SessionID) => Effect.Effect<Info[]>
    readonly get: (sessionID: SessionID, name: string) => Effect.Effect<Info | undefined>
    readonly upsert: (sessionID: SessionID, input: Input) => Effect.Effect<Info>
    readonly remove: (sessionID: SessionID, name: string) => Effect.Effect<void>
    readonly removeAll: (sessionID: SessionID) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSkill") {}

  export const noopLayer = Layer.succeed(
    Service,
    Service.of({
      list: () => Effect.succeed([]),
      get: () => Effect.succeed(undefined),
      upsert: (_sessionID, input) => Effect.succeed({
        id: id(),
        session_id: _sessionID as string,
        name: input.name,
        description: input.description,
        content: input.content,
        resources: input.resources ?? [],
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
        list: Effect.fn("SessionSkill.list")(function* (sessionID) {
          return yield* db((d) =>
            d
              .select()
              .from(SessionSkillTable)
              .where(eq(SessionSkillTable.session_id, sessionID))
              .orderBy(asc(SessionSkillTable.name))
              .all(),
          )
        }),

        get: Effect.fn("SessionSkill.get")(function* (sessionID, name) {
          const row = yield* db((d) =>
            d
              .select()
              .from(SessionSkillTable)
              .where(and(eq(SessionSkillTable.session_id, sessionID), eq(SessionSkillTable.name, name)))
              .get(),
          )
          return row ?? undefined
        }),

        upsert: Effect.fn("SessionSkill.upsert")(function* (sessionID, input) {
          const now = Date.now()
          const row: Info = {
            id: id(),
            session_id: sessionID,
            name: input.name,
            description: input.description,
            content: input.content,
            resources: input.resources ?? [],
            time_created: now,
            time_updated: now,
          }
          const rows = yield* db((d) =>
            d
              .insert(SessionSkillTable)
              .values(row)
              .onConflictDoUpdate({
                target: [SessionSkillTable.session_id, SessionSkillTable.name],
                set: {
                  description: input.description,
                  content: input.content,
                  resources: input.resources ?? [],
                  time_updated: now,
                },
              })
              .returning(),
          )
          return rows[0] as Info
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
          yield* db((d) =>
            d.delete(SessionSkillTable).where(eq(SessionSkillTable.session_id, sessionID)).run(),
          )
        }),
      })
    }),
  )
}
