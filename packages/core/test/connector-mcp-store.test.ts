import { expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Connector } from "@opencode/connector/adapter/connector"
import { ConnectorConnection } from "@opencode/schema/connector-connection"
import { Global } from "@opencode/util/global"
import { AppMcp } from "@opencode/connector/adapter/app-mcp"
import { Database } from "../src/database/database.js"
import { ConnectorMcpStore } from "../src/connector/mcp-store.js"
import { ConnectorMcpTable, ConnectorConnectionTable } from "../src/connector/sql.js"
import { ConnectorStore } from "../src/connector/store.js"
import { testEffect } from "./lib/effect.js"

const url = process.env.OPENCODE_DATABASE_URL
if (url && !new URL(url).pathname.endsWith("-test")) throw new Error("Connector MCP tests require a dedicated *-test database")
const databaseLayer = Database.layer().pipe(Layer.provide(Layer.succeed(Global.Service, Global.make({ data: process.cwd() }))))
const tests = testEffect(ConnectorMcpStore.layer.pipe(Layer.provideMerge(databaseLayer)))
const fixture = Effect.gen(function* () {
  const store = yield* AppMcp.Store
  const database = yield* Database.Service
  const owner = `mcp_test_${crypto.randomUUID()}`
  yield* Effect.addFinalizer(() => database.db.delete(ConnectorMcpTable).where(eq(ConnectorMcpTable.session_id, owner)).run().pipe(Effect.orDie))
  const row = (id: string): AppMcp.Row => ({
    id, session_id: owner, service: "example", connection_id: null, name: "Test", status: "active", revision: 1,
    tools: "[]", token_hash: "hash-only", token_prefix: "ocm_test", time_created: Date.now(), time_updated: Date.now(),
  })
  return { store, database, owner, row }
})

tests.live("connector MCP store persists bindings and hash-only credentials", () => Effect.gen(function* () {
  const { store, owner, row } = yield* fixture
  const data = row(crypto.randomUUID())
  expect(yield* store.insert(data, 2)).toBe(true)
  expect(yield* store.get(data.id)).toEqual(data)
  expect(yield* store.list("other")).toEqual([])
  expect((yield* store.list(owner)).length).toBe(1)
}))

tests.live("connector MCP revision CAS prevents stale rotation or binding changes", () => Effect.gen(function* () {
  const { store, row } = yield* fixture
  const data = row(crypto.randomUUID())
  yield* store.insert(data, 2)
  expect(yield* store.replace({ ...data, revision: 2, token_hash: "rotated", connection_id: "attempted-rebind" }, 1)).toBe(true)
  expect(yield* store.replace({ ...data, revision: 2, token_hash: "stale" }, 1)).toBe(false)
  const saved = yield* store.get(data.id)
  expect(saved?.token_hash).toBe("rotated")
  expect(saved?.connection_id).toBe(null)
}))

tests.live("connector MCP owner quota holds under concurrent inserts", () => Effect.gen(function* () {
  const { store, row } = yield* fixture
  const results = yield* Effect.forEach(Array.from({ length: 6 }, () => row(crypto.randomUUID())), (data) => store.insert(data, 2), { concurrency: "unbounded" })
  expect(results.filter(Boolean)).toHaveLength(2)
}))

tests.live("deleted MCP cannot be resurrected by an old update", () => Effect.gen(function* () {
  const { store, database, owner, row } = yield* fixture
  const data = row(crypto.randomUUID())
  yield* store.insert(data, 1)
  expect(yield* store.replace({ ...data, status: "deleted", revision: 2, token_hash: "" }, 1)).toBe(true)
  expect(yield* store.replace({ ...data, revision: 3 }, 2)).toBe(false)
  expect(yield* store.insert(row(crypto.randomUUID()), 1)).toBe(true)
  const deleted = yield* database.db.select().from(ConnectorMcpTable).where(and(eq(ConnectorMcpTable.session_id, owner), eq(ConnectorMcpTable.status, "deleted"))).all()
  expect(deleted).toHaveLength(1)
}))

tests.live("deleting a bound account disables its MCP and invalidates concurrent updates", () => Effect.gen(function* () {
  const { store, database, owner, row } = yield* fixture
  const id = Schema.decodeUnknownSync(ConnectorConnection.ID)(`ccon_${crypto.randomUUID().replaceAll("-", "")}`)
  yield* Effect.addFinalizer(() => database.db.delete(ConnectorConnectionTable).where(eq(ConnectorConnectionTable.id, id)).run().pipe(Effect.orDie))
  yield* database.db.insert(ConnectorConnectionTable).values({
    id, session_id: owner, engine_connection_id: crypto.randomUUID(), engine_connection_name: crypto.randomUUID(),
    service: "example", alias: "Test", auth_type: "api_key", status: "active", time_created: Date.now(), time_updated: Date.now(),
  }).run()
  const data = { ...row(crypto.randomUUID()), connection_id: id }
  yield* store.insert(data, 2)
  yield* Effect.flatMap(Connector.Store, (connections) => connections.delete(id)).pipe(Effect.provide(ConnectorStore.layer))
  const saved = yield* store.get(data.id)
  expect(saved?.status).toBe("disabled")
  expect(saved?.token_hash).toBe("")
  expect(saved?.revision).toBe(2)
  expect(yield* store.replace({ ...data, revision: 2, status: "active" }, 1)).toBe(false)
}))
