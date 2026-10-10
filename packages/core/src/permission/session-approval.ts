export * as SessionPermissionApproval from "./session-approval.js"

import { and, eq } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { Permission } from "@opencode/schema/permission"
import { SessionPermissionApproval } from "@opencode/schema/session-permission-approval"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { SessionPermissionApprovalTable } from "./sql.js"

export { ID, Info } from "@opencode/schema/session-permission-approval"

export const AddInput = Schema.Struct({
  sessionID: Session.ID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  sourceRequestID: Permission.ID.pipe(Schema.optional),
}).annotate({ identifier: "SessionPermissionApproval.AddInput" })
export type AddInput = typeof AddInput.Type

export interface Interface {
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<SessionPermissionApproval.Info>>
  readonly add: (input: AddInput) => Effect.Effect<void>
  readonly remove: (sessionID: Session.ID, id: SessionPermissionApproval.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPermissionApproval") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const list = Effect.fn("SessionPermissionApproval.list")(function* (sessionID: Session.ID) {
      const rows = yield* db
        .select()
        .from(SessionPermissionApprovalTable)
        .where(eq(SessionPermissionApprovalTable.session_id, sessionID))
        .orderBy(SessionPermissionApprovalTable.id)
        .all()
        .pipe(Effect.orDie)
      return rows.map(
        (row): SessionPermissionApproval.Info => ({
          id: row.id,
          sessionID: row.session_id,
          action: row.action,
          resource: row.resource,
          ...(row.source_request_id ? { sourceRequestID: row.source_request_id } : {}),
          time: { created: DateTime.makeUnsafe(row.time_created), updated: DateTime.makeUnsafe(row.time_updated) },
        }),
      )
    })
    const add = Effect.fn("SessionPermissionApproval.add")(function* (input: AddInput) {
      if (!input.resources.length) return
      yield* db
        .insert(SessionPermissionApprovalTable)
        .values(
          input.resources.map((resource) => ({
            id: SessionPermissionApproval.ID.create(),
            session_id: input.sessionID,
            action: input.action,
            resource,
            source_request_id: input.sourceRequestID,
          })),
        )
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })
    const remove = Effect.fn("SessionPermissionApproval.remove")(function* (
      sessionID: Session.ID,
      id: SessionPermissionApproval.ID,
    ) {
      yield* db
        .delete(SessionPermissionApprovalTable)
        .where(and(eq(SessionPermissionApprovalTable.session_id, sessionID), eq(SessionPermissionApprovalTable.id, id)))
        .run()
        .pipe(Effect.orDie)
    })
    return Service.of({ list, add, remove })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
