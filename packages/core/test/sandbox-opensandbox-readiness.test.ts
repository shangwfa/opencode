import { expect } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"
import { ProjectTable } from "../src/project/sql"
import { SessionTable } from "../src/session/sql"
import { SandboxTable, SandboxCommandTable } from "../src/sandbox/sql"
import { SandboxConfig } from "../src/sandbox/config"
import { make } from "../src/sandbox/opensandbox/provider"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node])))

it.live("readiness reconnects from PG on a fresh replica, checks health, and never creates", () => Effect.gen(function* () {
  const { db } = yield* Database.Service
  const root = Session.ID.create()
  const child = Session.ID.create()
  const requests: string[] = []
  const cancelled: string[] = []
  let healthy = true
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request): Response {
    const url = new URL(request.url)
    requests.push(`${request.method} ${url.pathname}`)
    if (request.method === "DELETE" && url.pathname === "/command") {
      cancelled.push(url.searchParams.get("id") ?? "")
      return new Response(null, { status: 204 })
    }
    if (url.pathname.includes("/endpoints/")) return Response.json({ endpoint: `${server.hostname}:${server.port}` })
    if (url.pathname === "/ping") return new Response("pong", { status: healthy ? 200 : 503 })
    return new Response("not found", { status: 404 })
  } })
  yield* Effect.addFinalizer(() => Effect.promise(async () => { await server.stop(true) }))
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] }).onConflictDoNothing().run()
  for (const id of [root, child]) yield* db.insert(SessionTable).values({ id, project_id: Project.ID.global,
    slug: id, directory: "/workspace", version: "test", ...(id === child ? { parent_id: root } : {}),
  }).run()
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* db.delete(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).run()
    yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, root)).run()
    yield* db.delete(SessionTable).where(inArray(SessionTable.id, [root, child])).run()
  }).pipe(Effect.orDie))
  const config = { ...SandboxConfig.load(), enabled: true, provider: "opensandbox" as const,
    domain: `${server.hostname}:${server.port}`, protocol: "http" as const, useServerProxy: true,
    idleReapSeconds: 0, snapshot: { ...SandboxConfig.load().snapshot, enabled: false },
    oomScan: { ...SandboxConfig.load().oomScan, enabled: false },
  }
  const first = yield* make(config)
  const second = yield* make(config)
  expect(yield* first.isReady(root)).toBe(false)
  expect(requests).toHaveLength(0)
  yield* db.insert(SandboxTable).values({ id: `sb-${root}`, session_id: root, host: config.domain, state: "running" }).run()
  expect(yield* first.isReady(root)).toBe(true)
  expect(yield* second.isReady(child)).toBe(true)
  expect(requests.some((request) => request.endsWith("/ping"))).toBe(true)
  for (const operation of ["one", "two"]) yield* db.insert(SandboxCommandTable).values({
    id: `${root}-${operation}`, session_id: root, sandbox_id: `sb-${root}`,
    command_id: `context-${operation}`, operation_id: operation,
  }).run()
  yield* second.interrupt(child, "one")
  expect(cancelled).toEqual(["context-one"])
  healthy = false
  const third = yield* make(config)
  expect(yield* third.isReady(root)).toBe(false)
  expect(requests.every((request) => !request.startsWith("POST "))).toBe(true)
}))
