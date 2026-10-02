export * as SessionResourceOwner from "./resource-owner.js"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Session } from "@opencode/schema/session"
import type { Database } from "../database/database.js"
import { SessionTable } from "./sql.js"

export interface Relation {
  readonly id: Session.ID
  readonly parentID?: Session.ID | null
  readonly forkSessionID?: Session.ID | null
  readonly projectID: string
  readonly appId?: string | null
  readonly directory: string
  readonly workspaceID?: string | null
}

/** Internal children share definitions; an explicit history fork starts its own resource domain. */
export const resolve = Effect.fn("SessionResourceOwner.resolve")(function* (
  sessionID: Session.ID,
  lookup: (id: Session.ID) => Effect.Effect<Relation | undefined>,
) {
  const visited = new Set<Session.ID>()
  let current = sessionID
  let previous: Relation | undefined
  while (true) {
    if (visited.has(current) || visited.size >= 64)
      return yield* Effect.die(new Error(`Invalid session resource owner chain: ${sessionID}`))
    visited.add(current)
    const row = yield* lookup(current)
    // CRUD handlers validate existence. A read after root deletion must still observe
    // empty durable rows; a missing ancestor of a live child is a broken relation.
    if (!row) {
      if (!previous) return sessionID
      return yield* Effect.die(new Error(`Session resource owner not found: ${current}`))
    }
    if (
      previous &&
      (previous.projectID !== row.projectID ||
        (previous.appId ?? null) !== (row.appId ?? null) ||
        previous.directory !== row.directory ||
        (previous.workspaceID ?? null) !== (row.workspaceID ?? null))
    )
      return yield* Effect.die(new Error(`Session resource owner crosses a resource domain: ${sessionID}`))
    if (!row.parentID || row.forkSessionID) return row.id
    previous = row
    current = row.parentID
  }
})

export const id = (db: Database.Interface["db"], sessionID: Session.ID) =>
  resolve(sessionID, (id) =>
    db
      .select({
        id: SessionTable.id,
        parentID: SessionTable.parent_id,
        forkSessionID: SessionTable.fork_session_id,
        projectID: SessionTable.project_id,
        appId: SessionTable.app_id,
        directory: SessionTable.directory,
        workspaceID: SessionTable.workspace_id,
      })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(Effect.orDie),
  )
