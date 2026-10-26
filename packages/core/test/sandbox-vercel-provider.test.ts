import { expect, test } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { ProjectTable } from "../src/project/sql"
import { SessionTable, SessionExecutionGateTable, SandboxExecutionGateTable } from "../src/session/sql"
import { SandboxTable, SandboxCommandTable } from "../src/sandbox/sql"
import { SandboxConfig } from "../src/sandbox/config"
import { claimStop, make, resources } from "../src/sandbox/vercel/provider"
import { testEffect } from "./lib/effect"
import { command, credentials, error, fixture as responseFixture, logs, transport } from "./fixture/vercel"

const it = testEffect(AppNodeBuilder.build(Database.node))

const fixture = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const root = Session.ID.create()
  const child = Session.ID.create()
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] }).onConflictDoNothing().run()
  for (const id of [root, child]) yield* db.insert(SessionTable).values({
    id, project_id: Project.ID.global, slug: id, directory: "/workspace", version: "test",
    ...(id === child ? { parent_id: root } : {}),
  }).run()
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* db.delete(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).run()
    yield* db.delete(SessionExecutionGateTable).where(inArray(SessionExecutionGateTable.session_id, [root, child])).run()
    yield* db.delete(SandboxExecutionGateTable).where(eq(SandboxExecutionGateTable.root_session_id, root)).run()
    yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, root)).run()
    yield* db.delete(SessionTable).where(inArray(SessionTable.id, [root, child])).run()
  }).pipe(Effect.orDie))
  let status = "stopped"
  let generation = 0
  let name = ""
  let lost = false
  let unconfirmed = false
  let ports = [9911, 19911]
  const directories = new Map<string, string>()
  const payload = () => {
    const response = responseFixture(status, `vm-${root}-${generation}`)
    response.sandbox.name = name
    response.routes = ports.map((port) => ({ port, subdomain: `gate-${port}`, url: `https://gate-${port}.invalid` }))
    return response
  }
  const mock = transport(async (call) => {
    if (unconfirmed && (call.query.get("wait") || call.path.endsWith("/kill"))) return error(403, "cannot_confirm_command")
    if (call.method === "POST" && call.path.endsWith("/sandboxes")) {
      name = String(call.body.name); generation++; status = "running"
      return Response.json(payload())
    }
    if (Array.isArray(call.body.ports)) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      ports = call.body.ports.map(Number)
      return Response.json(payload())
    }
    if (call.path.endsWith("/stop")) {
      status = "stopped"
      return Response.json({ ...payload(), snapshot: {
        id: "snap-test", sourceSessionId: `vm-${root}-${generation}`, region: "iad1", status: "created", sizeBytes: 32,
        createdAt: 1, updatedAt: 1,
      } })
    }
    if (call.path.endsWith("/cmd") && call.body.wait) return new Response([
      JSON.stringify({ command: command() }),
      ...(call.body.command === "find" && Array.isArray(call.body.args)
        ? [JSON.stringify({ stream: "stdout", data: directories.get(String(call.body.args[0])) ?? "" })] : []),
      JSON.stringify({ command: command(0) }), "",
    ].join("\n"), { headers: { "content-type": "application/x-ndjson" } })
    if (call.path.endsWith("/cmd")) return Response.json({ command: { ...command(), sessionId: `vm-${root}-${generation}` } })
    if (call.path.endsWith("/logs")) return logs([{ stream: "stdout", data: "hello\n" }])
    if (call.path.includes("/cmd/")) return Response.json({ command: { ...command(call.query.get("wait") ? 0 : null), sessionId: `vm-${root}-${generation}` } })
    if (lost) return error(404, "not_found")
    if (call.query.get("resume") === "true" && status === "stopped") { generation++; status = "running" }
    return Response.json(payload())
  })
  const config = SandboxConfig.load()
  const settings = { ...config, enabled: true, provider: "vercel" as const, volumeType: "snapshot" as const, idleReapSeconds: 0,
    vercel: { ...credentials, image: "vercel/sandbox/node:24" },
  }
  const provider = yield* make(settings, mock.fetch)
  return { db, root, child, provider, mock, directories, replica: () => make(settings, mock.fetch), ports: () => ports,
    lose: () => { lost = true }, failCancellation: () => { unconfirmed = true } }
})

test("Vercel resources reject silent memory rounding", () => {
  expect(resources("2", "4Gi")).toEqual({ vcpus: 2 })
  expect(() => resources("2", "8Gi")).toThrow("exactly 2 GiB")
  expect(() => resources("1.5", "3Gi")).toThrow()
})

for (const change of ["activity", "generation", "unchanged"] as const) {
  it.live(`stop claim fences the scanned candidate: ${change}`, () => Effect.gen(function* () {
    const { root, provider, db, mock } = yield* fixture
    yield* provider.boot(root)
    const candidate = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get()
    if (!candidate) throw new Error("missing candidate")
    if (change !== "unchanged") yield* db.update(SandboxTable).set(change === "activity"
      ? { time_updated: candidate.time_updated + 1 }
      : { id: `${candidate.id}-replacement` }).where(eq(SandboxTable.session_id, root)).run()
    const latest = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get()
    if (!latest) throw new Error("missing latest binding")
    const claimed = yield* claimStop(db, latest, Date.now(), candidate)
    expect(claimed).toHaveLength(change === "unchanged" ? 1 : 0)
    expect(mock.calls.filter((call) => call.path.endsWith("/stop"))).toHaveLength(0)
    expect((yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get())?.state)
      .toBe(change === "unchanged" ? "snapshotting" : "running")
  }))
}

it.live("lazy preference, boot, root sharing and generation-changing resume are persisted", () => Effect.gen(function* () {
  const { db, root, child, provider, mock } = yield* fixture
  yield* provider.keepAlive(root)
  expect(yield* provider.sandboxId(root)).toBeNull()
  expect(mock.calls).toHaveLength(0)
  const booted = yield* provider.boot(root)
  expect(yield* provider.boot(child)).toBe(booted)
  expect(mock.calls.filter((call) => call.method === "POST" && call.path.endsWith("/sandboxes"))).toHaveLength(1)
  const bound = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get()
  expect(bound?.provider).toBe("vercel")
  expect(bound?.provider_scope).toBe("team_test/prj_test")
  expect(bound?.keep_alive).toBe(true)
  yield* provider.release(root)
  expect((yield* provider.lifecycle(root)).state).toBe("destroyed")
  expect(yield* provider.isKeepAlive(root)).toBe(false)
  yield* provider.keepAlive(root)
  const restored = yield* provider.boot(root)
  expect(restored).not.toBe(booted)
  yield* provider.destroy(root)
  expect(yield* provider.isKeepAlive(root)).toBe(true)
  expect(mock.calls.some((call) => call.method === "DELETE")).toBe(false)
  if (!provider.purge) throw new Error("Vercel permanent removal is missing")
  yield* provider.purge(root)
  const removed = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get()
  expect(removed?.remote_name).toBeNull()
  expect(removed?.keep_alive).toBe(true)
  expect(mock.calls.filter((call) => call.method === "DELETE")).toHaveLength(1)
}))

it.live("concurrent boots share one remote creation", () => Effect.gen(function* () {
  const { root, child, provider, mock } = yield* fixture
  const ids = yield* Effect.all([provider.boot(root), provider.boot(child)], { concurrency: 2 })
  expect(ids[0]).toBe(ids[1])
  expect(mock.calls.filter((call) => call.method === "POST" && call.path.endsWith("/sandboxes"))).toHaveLength(1)
}))

it.live("a saved missing workspace fails without cold creation", () => Effect.gen(function* () {
  const { root, provider, mock, lose } = yield* fixture
  yield* provider.boot(root)
  yield* provider.destroy(root)
  const before = mock.calls.filter((call) => call.method === "POST" && call.path.endsWith("/sandboxes")).length
  lose()
  expect(yield* provider.boot(root).pipe(Effect.isFailure)).toBe(true)
  expect(mock.calls.filter((call) => call.method === "POST" && call.path.endsWith("/sandboxes"))).toHaveLength(before)
}))

it.live("shell waits for command completion and clears the active PG record", () => Effect.gen(function* () {
  const { db, root, provider } = yield* fixture
  const result = yield* provider.run({ sessionID: root, command: "echo hello", hostWorkdir: "/workspace" })
  expect(result.exitCode).toBe(0)
  expect(result.output).toBe("hello\n")
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(0)
}))

it.live("port resolution never boots and rejects undeclared ports", () => Effect.gen(function* () {
  const { root, provider, mock } = yield* fixture
  expect((yield* provider.endpoint(root, 9911, true))._tag).toBe("no-sandbox")
  expect(mock.calls).toHaveLength(0)
  expect(yield* provider.snapshot(root).pipe(Effect.isFailure)).toBe(true)
  expect(yield* provider.snapshotStats(root).pipe(Effect.isFailure)).toBe(true)
}))

it.live("endpoint resolves through the token gate without leaking an unauthenticated URL", () => Effect.gen(function* () {
  const { db, root, provider, mock } = yield* fixture
  yield* provider.boot(root)
  expect((yield* provider.endpoint(root, 65535, true))._tag).toBe("resolve-failed")
  const resolved = yield* provider.endpoint(root, 9911, true)
  if (resolved._tag !== "resolved") throw new Error(`expected resolved, got ${resolved._tag}`)
  const currentId = yield* provider.sandboxId(root)
  if (!currentId) throw new Error("running sandbox id missing")
  expect(resolved.sandboxId).toBe(currentId)
  expect(resolved.endpoint.startsWith("https://")).toBe(true)
  expect(resolved.endpoint).toContain("/t/")
  const token = resolved.endpoint.split("/t/")[1]
  expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/)
  const gate = mock.calls.find((call) => call.body?.command === "sh" && String((call.body as { args?: string[] }).args ?? []).includes("--port 19911 --target 9911"))
  expect(gate).toBeDefined()
  expect(JSON.stringify(gate?.body)).toContain(`--token '${token}'`)
  expect(JSON.stringify(gate?.body)).toContain("--port 19911 --target 9911")
  const again = yield* provider.endpoint(root, 9911, true)
  expect(again).toEqual(resolved)
  yield* provider.destroy(root)
  if (!provider.purge) throw new Error("Vercel permanent removal is missing")
  yield* provider.purge(root)
  expect((yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get())?.endpoint_token).toBeNull()
}))

it.live("independent provider replicas merge concurrent port registrations", () => Effect.gen(function* () {
  const { root, provider, replica, ports } = yield* fixture
  yield* provider.boot(root)
  const second = yield* replica()
  const results = yield* Effect.all([provider.endpoint(root, 1234, true), second.endpoint(root, 3000, true)], { concurrency: 2 })
  expect(results.map((result) => result._tag)).toEqual(["resolved", "resolved"])
  expect(ports().sort((a, b) => a - b)).toEqual([9911, 11234, 13000, 19911])
}))

it.live("unconfirmed cancellation retains the PG command until the VM is stopped", () => Effect.gen(function* () {
  const { db, root, provider, failCancellation } = yield* fixture
  yield* provider.boot(root)
  failCancellation()
  expect(yield* provider.run({ sessionID: root, command: "echo hello", hostWorkdir: "/workspace" }).pipe(Effect.isFailure)).toBe(true)
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(1)
  yield* provider.destroy(root)
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(0)
}))

it.live("a different project cannot mutate a persisted binding", () => Effect.gen(function* () {
  const { db, root, provider, mock } = yield* fixture
  yield* provider.keepAlive(root)
  yield* db.update(SandboxTable).set({ provider_scope: "another/project" }).where(eq(SandboxTable.session_id, root)).run()
  const result = yield* provider.keepAlive(root).pipe(Effect.exit)
  expect(result._tag).toBe("Failure")
  expect(mock.calls).toHaveLength(0)
}))

it.live("file search matches filename globs, not substrings, across nested and hidden entries", () => Effect.gen(function* () {
  const { root, provider, directories } = yield* fixture
  directories.set("/workspace", "nested|d\n.hidden.txt|f\nnotes.txt|f\nliteral'quote.txt|f\ndata.bin|f\n.git|d\nnode_modules|d\n")
  directories.set("/workspace/nested", "readme.txt|f\n")
  directories.set("/workspace/.git", "excluded.txt|f\n")
  directories.set("/workspace/node_modules", "excluded.txt|f\n")
  const find = (query: string) => provider.fileFind(root, "/workspace", query)
  const files = yield* find("*.txt")
  expect(files.map((entry) => entry.path).sort()).toEqual([
    "/workspace/.hidden.txt", "/workspace/literal'quote.txt", "/workspace/nested/readme.txt", "/workspace/notes.txt",
  ])
  expect(yield* find("readme")).toEqual([])
  expect(yield* find("r?adme.[t]xt")).toEqual([{ path: "/workspace/nested/readme.txt", isDirectory: false }])
  expect(yield* find("literal'quote.txt")).toEqual([{ path: "/workspace/literal'quote.txt", isDirectory: false }])
  expect(yield* find("nest*")).toEqual([{ path: "/workspace/nested", isDirectory: true }])
  expect(yield* find("no-such-*")).toEqual([])
}))
