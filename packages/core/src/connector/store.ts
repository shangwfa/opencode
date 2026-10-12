export * as ConnectorStore from "./store.js"

import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Connector } from "@opencode/connector/adapter"
import { ConnectorConnectionTable, ConnectorOAuthRequestTable } from "./sql.js"
import { Session } from "@opencode/schema/session"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { SessionResourceOwner } from "../session/resource-owner.js"

const layer = Layer.effect(
  Connector.Store,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const hydrate = (row: typeof ConnectorConnectionTable.$inferSelect): Connector.Row =>
      ({
        ...row,
        id: row.id as Connector.Row["id"],
        auth_type: row.auth_type as Connector.Row["auth_type"],
        status: row.status as Connector.Row["status"],
      }) as Connector.Row
    return Connector.Store.of({
      resolveOwner: (sessionID) => SessionResourceOwner.id(db, sessionID as Session.ID),
      insert: (row) => db.insert(ConnectorConnectionTable).values(row).run().pipe(Effect.orDie),
      listBySession: (sessionID) =>
        db
          .select()
          .from(ConnectorConnectionTable)
          .where(eq(ConnectorConnectionTable.session_id, sessionID))
          .all()
          .pipe(Effect.map((rows) => rows.map(hydrate)), Effect.orDie),
      delete: (id) => db.delete(ConnectorConnectionTable).where(eq(ConnectorConnectionTable.id, id)).run().pipe(Effect.orDie),
      deleteBySession: (sessionID) =>
        db.delete(ConnectorConnectionTable).where(eq(ConnectorConnectionTable.session_id, sessionID)).run().pipe(Effect.orDie),
      listAllEngineConnectionIds: () =>
        db
          .select({ engine_connection_id: ConnectorConnectionTable.engine_connection_id })
          .from(ConnectorConnectionTable)
          .all()
          .pipe(Effect.map((rows) => rows.map((row) => row.engine_connection_id)), Effect.orDie),
      insertOAuthRequest: (row) =>
        db
          .insert(ConnectorOAuthRequestTable)
          .values(row)
          .onConflictDoNothing({ target: ConnectorOAuthRequestTable.connection_request_id })
          .returning({ connection_request_id: ConnectorOAuthRequestTable.connection_request_id })
          .get()
          .pipe(Effect.map((inserted) => inserted !== undefined), Effect.orDie),
      updateOAuthRequestState: (connectionRequestId, state) =>
        db
          .update(ConnectorOAuthRequestTable)
          .set({ state })
          .where(eq(ConnectorOAuthRequestTable.connection_request_id, connectionRequestId))
          .run()
          .pipe(Effect.orDie),
      listOAuthRequestsBySession: (sessionID) =>
        db
          .select()
          .from(ConnectorOAuthRequestTable)
          .where(eq(ConnectorOAuthRequestTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
    })
  }),
)

export const node = makeGlobalNode({ service: Connector.Store, layer, deps: [Database.node] })
