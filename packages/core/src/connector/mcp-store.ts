export * as ConnectorMcpStore from "./mcp-store.js"

import { and, eq, ne } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { AppMcp } from "@opencode/connector/adapter/app-mcp"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { ConnectorMcpTable } from "./sql.js"

export const layer = Layer.effect(AppMcp.Store, Effect.gen(function* () {
  const database = yield* Database.Service
  const db = database.db
  return AppMcp.Store.of({
    get: (id) => db.select().from(ConnectorMcpTable).where(eq(ConnectorMcpTable.id, id)).get().pipe(Effect.orDie),
    list: (owner) => db.select().from(ConnectorMcpTable).where(eq(ConnectorMcpTable.session_id, owner)).all().pipe(Effect.orDie),
    insert: (row, maxDeployments) => db.transaction((tx) => Effect.gen(function* () {
      if (database.lockAggregate) yield* database.lockAggregate(`connector-mcp:${row.session_id}`)
      const existing = yield* tx.select({ id: ConnectorMcpTable.id }).from(ConnectorMcpTable)
        .where(and(eq(ConnectorMcpTable.session_id, row.session_id), ne(ConnectorMcpTable.status, "deleted"))).all()
      if (existing.length >= maxDeployments) return false
      yield* tx.insert(ConnectorMcpTable).values(row).run()
      return true
    })).pipe(Effect.orDie),
    replace: (row, expectedRevision) => db.update(ConnectorMcpTable).set({
      name: row.name, status: row.status, revision: row.revision, tools: row.tools,
      token_hash: row.token_hash, token_prefix: row.token_prefix, time_updated: row.time_updated,
    }).where(and(eq(ConnectorMcpTable.id, row.id), eq(ConnectorMcpTable.session_id, row.session_id),
      eq(ConnectorMcpTable.revision, expectedRevision), ne(ConnectorMcpTable.status, "deleted")))
      .returning({ id: ConnectorMcpTable.id }).get().pipe(Effect.map((result) => result !== undefined), Effect.orDie),
  })
}))

export const node = makeGlobalNode({ service: AppMcp.Store, layer, deps: [Database.node] })
