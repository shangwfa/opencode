import z from "zod"
import { Effect, Context, Layer } from "effect"
import { Database, eq, and } from "../storage/db"
import { UserSkillTable } from "./skill.sql"
import * as Log from "@opencode-ai/core/util/log"
import { randomBytes } from "crypto"

export namespace UserSkill {
  const log = Log.create({ service: "user-skill" })

  export const Info = z.object({
    id: z.string(),
    user_id: z.string(),
    name: z.string(),
    description: z.string(),
    content: z.string(),
    time_created: z.number(),
    time_updated: z.number(),
  })
  export type Info = z.infer<typeof Info>

  function id() {
    return `usk_${randomBytes(12).toString("base64url")}`
  }

  const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
    Effect.promise(() => Database.use(fn))

  export interface Interface {
    readonly list: (userId: string) => Effect.Effect<Info[]>
    readonly get: (userId: string, name: string) => Effect.Effect<Info | undefined>
    readonly create: (userId: string, input: { name: string; description: string; content: string }) => Effect.Effect<Info>
    readonly update: (userId: string, name: string, input: { description?: string; content?: string }) => Effect.Effect<Info | undefined>
    readonly remove: (userId: string, name: string) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/UserSkill") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      return Service.of({
        list: Effect.fn("UserSkill.list")(function* (userId: string) {
          const rows = yield* db((d) =>
            d.select().from(UserSkillTable).where(eq(UserSkillTable.user_id, userId)).all(),
          )
          return rows
        }),

        get: Effect.fn("UserSkill.get")(function* (userId: string, name: string) {
          const row = yield* db((d) =>
            d
              .select()
              .from(UserSkillTable)
              .where(and(eq(UserSkillTable.user_id, userId), eq(UserSkillTable.name, name)))
              .get(),
          )
          return row ?? undefined
        }),

        create: Effect.fn("UserSkill.create")(function* (userId: string, input: { name: string; description: string; content: string }) {
          const now = Date.now()
          const row: Info = {
            id: id(),
            user_id: userId,
            name: input.name,
            description: input.description,
            content: input.content,
            time_created: now,
            time_updated: now,
          }
          yield* db((d) =>
            d
              .insert(UserSkillTable)
              .values(row)
              .onConflictDoUpdate({
                target: [UserSkillTable.user_id, UserSkillTable.name],
                set: {
                  description: input.description,
                  content: input.content,
                  time_updated: now,
                },
              })
              .run(),
          )
          log.info("user skill created", { userId, name: input.name })
          return row
        }),

        update: Effect.fn("UserSkill.update")(function* (userId: string, name: string, input: { description?: string; content?: string }) {
          const existing = yield* db((d) =>
            d
              .select()
              .from(UserSkillTable)
              .where(and(eq(UserSkillTable.user_id, userId), eq(UserSkillTable.name, name)))
              .get(),
          )
          if (!existing) return undefined
          const now = Date.now()
          const patch: Record<string, unknown> = { time_updated: now }
          if (input.description !== undefined) patch.description = input.description
          if (input.content !== undefined) patch.content = input.content
          yield* db((d) =>
            d
              .update(UserSkillTable)
              .set(patch)
              .where(and(eq(UserSkillTable.user_id, userId), eq(UserSkillTable.name, name)))
              .run(),
          )
          return { ...existing, ...patch } as Info
        }),

        remove: Effect.fn("UserSkill.remove")(function* (userId: string, name: string) {
          yield* db((d) =>
            d
              .delete(UserSkillTable)
              .where(and(eq(UserSkillTable.user_id, userId), eq(UserSkillTable.name, name)))
              .run(),
          )
          log.info("user skill removed", { userId, name })
        }),
      })
    }),
  )
}
