export * as SessionAgentsMd from "./agents-md.js"

import { eq, sql } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { SessionAgentsMd as SessionAgentsMdSchema } from "@opencode/schema/session-agents-md"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { Instructions } from "../instructions/index.js"
import { SessionAgentsMdTable } from "./sql.js"
import { SessionSchema } from "./schema.js"

export const ID = SessionAgentsMdSchema.ID
export type ID = SessionAgentsMdSchema.ID
export const Info = SessionAgentsMdSchema.Info
export type Info = SessionAgentsMdSchema.Info
export const MaxContentBytes = SessionAgentsMdSchema.MaxContentBytes
export const ContentTooLargeError = SessionAgentsMdSchema.ContentTooLargeError
export const Key = Instructions.Key.make("session/agents-md")

export interface Interface {
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<Info | null>
  readonly put: (
    sessionID: SessionSchema.ID,
    content: string,
  ) => Effect.Effect<Info, SessionAgentsMdSchema.ContentTooLargeError>
  readonly remove: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** A stable source allows InstructionState to observe insertion, updates, and removal. */
  readonly load: (sessionID: SessionSchema.ID) => Instructions.List
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAgentsMd") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("SessionAgentsMd.get")(function* (sessionID: SessionSchema.ID) {
      const row = yield* db
        .select()
        .from(SessionAgentsMdTable)
        .where(eq(SessionAgentsMdTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      return row ? fromRow(row) : null
    })

    const put = Effect.fn("SessionAgentsMd.put")(function* (sessionID: SessionSchema.ID, content: string) {
      // The content renders into every later provider request, so cap it like the
      // sibling instruction entries surface; the limit is a UTF-8 byte count.
      const actualBytes = Buffer.byteLength(content, "utf8")
      if (actualBytes > MaxContentBytes)
        yield* new ContentTooLargeError({
          actualBytes,
          maxBytes: MaxContentBytes,
          message: `Session AGENTS.md content is ${actualBytes} bytes; the limit is ${MaxContentBytes} bytes`,
        })
      // Monotonic update time: the replacement stamp is computed against the stored row's
      // current value inside the conflict branch, so it advances past a same-millisecond
      // write and concurrent upserts cannot leave an equal or older stamp behind.
      const now = Date.now()
      const [row] = yield* db
        .insert(SessionAgentsMdTable)
        .values({ id: ID.create(), session_id: sessionID, content, time_created: now, time_updated: now })
        .onConflictDoUpdate({
          target: SessionAgentsMdTable.session_id,
          set: { content, time_updated: sql`max(${now}, ${SessionAgentsMdTable.time_updated} + 1)` },
        })
        .returning()
        .pipe(Effect.orDie)
      return fromRow(row)
    })

    const remove = Effect.fn("SessionAgentsMd.remove")(function* (sessionID: SessionSchema.ID) {
      yield* db.delete(SessionAgentsMdTable).where(eq(SessionAgentsMdTable.session_id, sessionID)).run().pipe(Effect.orDie)
    })

    const load = (sessionID: SessionSchema.ID): Instructions.List =>
      Instructions.make<string>({
        key: Key,
        codec: Schema.toCodecJson(Schema.String),
        read: db
          .select({ content: SessionAgentsMdTable.content })
          .from(SessionAgentsMdTable)
          .where(eq(SessionAgentsMdTable.session_id, sessionID))
          .get()
          .pipe(Effect.map((row) => (row ? row.content : Instructions.removed)), Effect.orDie),
        render: {
          initial: (content) => `Session AGENTS.md:\n${content}`,
          changed: (_previous, content) => `Session AGENTS.md was updated:\n${content}`,
          removed: () => "Session AGENTS.md was removed. Its instructions no longer apply.",
        },
      })

    return Service.of({ get, put, remove, load })
  }),
)

export function fromRow(row: typeof SessionAgentsMdTable.$inferSelect): Info {
  return Info.make({
    id: ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    content: row.content,
    time: {
      created: DateTime.makeUnsafe(row.time_created),
      updated: DateTime.makeUnsafe(row.time_updated),
    },
  })
}

/** Session AGENTS.md is intentionally session-local and is not inherited by forks. */
export function fork(values: Instructions.Values | undefined): Instructions.Values | undefined {
  if (!values) return values
  return Object.fromEntries(Object.entries(values).filter(([key]) => key !== Key))
}

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node] })
