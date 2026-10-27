import { expect } from "bun:test"
import { SandboxNotFoundError, type SandboxOpts } from "e2b"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { ProjectTable } from "../src/project/sql"
import { SessionTable, SessionExecutionGateTable, SandboxExecutionGateTable } from "../src/session/sql"
import { SandboxTable, SandboxCommandTable, E2BSnapshotTable, AliyunSnapshotTable } from "../src/sandbox/sql"
import { SandboxConfig } from "../src/sandbox/config"
import { make } from "../src/sandbox/e2b/provider"
import type { Api, Remote } from "../src/sandbox/e2b-shared/client"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const fixture = (persist = true) => Effect.gen(function* () {
  const { db } = yield* Database.Service
  const root = Session.ID.create(), child = Session.ID.create()
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] }).onConflictDoNothing().run()
  for (const id of [root, child]) yield* db.insert(SessionTable).values({
    id, project_id: Project.ID.global, slug: id, directory: "/workspace", version: "test",
    ...(id === child ? { parent_id: root } : { sandbox: { persistMode: persist ? "snapshot" : "none", cpu: "2", memory: "512Mi" } }),
  }).run()
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* db.delete(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).run()
    yield* db.delete(SessionExecutionGateTable).where(inArray(SessionExecutionGateTable.session_id, [root, child])).run()
    yield* db.delete(SandboxExecutionGateTable).where(eq(SandboxExecutionGateTable.root_session_id, root)).run()
    yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, root)).run()
    yield* db.delete(E2BSnapshotTable).where(eq(E2BSnapshotTable.session_id, root)).run()
    yield* db.delete(SessionTable).where(inArray(SessionTable.id, [root, child])).run()
  }).pipe(Effect.orDie))
  const state = { creates: 0, kills: 0, captures: 0, connects: 0, gone: false, paused: false, denySnapshot: false,
    lostCreate: false, template: "", options: undefined as SandboxOpts | undefined, token: "e2b-private-token" as string | undefined,
    writes: [] as string[] }
  const api: Api = {
    create: async (template, options) => { state.creates++; state.template = template; state.options = options; state.gone = false; if (state.lostCreate) throw new Error("response lost"); return remote() },
    connect: async () => { state.connects++; if (state.gone) throw new SandboxNotFoundError("gone"); return remote() },
    info: async () => { if (state.gone) throw new SandboxNotFoundError("gone"); return { state: state.paused ? "paused" : "running", cpuCount: 2, memoryMB: 512 } },
    find: async () => [], kill: async () => { state.kills++; state.gone = true; return true },
    snapshots: async () => [], deleteSnapshot: async () => true,
  }
  function remote(): Remote {
    const id = `e2b-${root}-${state.creates}`
    return { id, get token() { return state.token }, host: (port) => `${port}-${id}.region.e2b.app`,
      start: async () => ({ pid: 1, wait: async () => ({ exitCode: 0 }) }), killCommand: async () => true,
      listCommands: async () => [], snapshot: async () => { state.captures++; if (state.denySnapshot) throw new Error("snapshot unavailable"); return `snapshot-${root}-${state.captures}` },
      extend: async () => {}, stat: async () => ({ size: 0 }), read: async () => new Uint8Array(),
      write: async (target) => { state.writes.push(target) }, mkdir: async () => {}, remove: async () => {}, list: async () => [],
    }
  }
  const e2b = { apiKey: "e2b-unit-secret-not-for-pg", apiUrl: "https://api.e2b.app", domain: "e2b.app", template: "base", installRipgrep: false }
  const config: SandboxConfig.Config = { ...SandboxConfig.load(), enabled: true, provider: "e2b", idleReapSeconds: 0, e2b }
  const provider = yield* make(config, api)
  return { db, root, child, state, provider, replica: (key?: string) => make({ ...config, e2b: { ...e2b, apiKey: key ?? e2b.apiKey } }, api) }
})

it.live("E2B creates lazily, shares the root generation, and exposes only authenticated SDK hosts", () => Effect.gen(function* () {
  const { root, child, provider, state, db } = yield* fixture()
  yield* provider.keepAlive(root)
  expect(state.creates).toBe(0)
  expect(yield* provider.endpoint(root, 9911)).toEqual({ _tag: "no-sandbox" })
  const ids = yield* Effect.all([provider.boot(root), provider.boot(child)], { concurrency: 2 })
  expect(ids[0]).toBe(ids[1])
  expect(state.creates).toBe(1)
  expect(state.options?.network?.allowPublicTraffic).toBe(false)
  expect(state.options?.secure).toBe(true)
  expect(state.options?.lifecycle).toEqual({ onTimeout: "kill", autoResume: false })
  expect(state.writes).toContain("/workspace/.opencode/sandbox-plugin-agent.ts.b64")
  expect(state.writes).toContain("/workspace/.opencode/sandbox-plugin-npm.ts.b64")
  const endpoint = yield* provider.endpoint(child, 9911)
  if (endpoint._tag !== "resolved") throw new Error("endpoint missing")
  expect(endpoint.endpoint).toEndWith(".region.e2b.app")
  expect(endpoint.endpoint).not.toContain("e2b-private-token")
  expect(endpoint.headers?.["e2b-traffic-access-token"]).toBe("e2b-private-token")
  const row = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get()
  expect(row?.provider).toBe("e2b")
  expect(JSON.stringify(row)).not.toContain("e2b-unit-secret-not-for-pg")
}))

it.live("E2B checkpoints are independent and a fresh Pod restores the saved generation", () => Effect.gen(function* () {
  const { root, child, provider, state, db, replica } = yield* fixture()
  const first = yield* provider.boot(root)
  const other = yield* replica()
  expect(yield* other.boot(child)).toBe(first)
  yield* other.snapshot(root)
  expect(state.kills).toBe(0)
  expect(yield* db.select().from(E2BSnapshotTable).where(eq(E2BSnapshotTable.session_id, root)).all()).toHaveLength(1)
  expect(yield* db.select().from(AliyunSnapshotTable).where(eq(AliyunSnapshotTable.session_id, root)).all()).toHaveLength(0)
  yield* other.destroy(root)
  expect(state.kills).toBe(1)
  expect(yield* provider.boot(root)).not.toBe(first)
  expect(state.template).toBe(`snapshot-${root}-2`)
  expect((yield* provider.snapshotStats(root)).restoredTotal).toBe(1)
}))

it.live("E2B temporary workspaces never snapshot on stop", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture(false)
  yield* provider.boot(root)
  yield* provider.destroy(root)
  expect(state.captures).toBe(0)
  expect(state.kills).toBe(1)
}))

it.live("E2B rejects another account or provider binding without cloud mutation", () => Effect.gen(function* () {
  const { root, provider, state, replica, db } = yield* fixture()
  yield* provider.boot(root)
  const other = yield* replica("different-account")
  expect((yield* other.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  yield* db.update(SandboxTable).set({ provider: "aliyun" }).where(eq(SandboxTable.session_id, root)).run()
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.creates).toBe(1)
  expect(state.kills).toBe(0)
}))

it.live("E2B snapshot failure retains the source and command admission stays closed", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  yield* provider.boot(root)
  state.denySnapshot = true
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* provider.lifecycle(root)).state).toBe("snapshotting")
  expect(state.kills).toBe(0)
}))

it.live("E2B ambiguous create is not replayed", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  state.lostCreate = true
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.creates).toBe(1)
}))

it.live("E2B readiness and endpoints never resume a paused instance", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  yield* provider.boot(root)
  state.paused = true
  const connects = state.connects
  expect(yield* provider.isReady(root)).toBe(false)
  expect(yield* provider.endpoint(root, 9911)).toEqual({ _tag: "no-sandbox" })
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.connects).toBe(connects)
}))

it.live("E2B confirmed loss restores only a ready checkpoint", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  const first = yield* provider.boot(root)
  yield* provider.snapshot(root)
  state.gone = true
  expect(yield* provider.boot(root)).not.toBe(first)
  expect(state.kills).toBe(0)
}))
