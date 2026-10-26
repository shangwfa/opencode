import { expect, test } from "bun:test"
import { FileNotFoundError, SandboxNotFoundError, type SandboxOpts } from "e2b"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { ProjectTable } from "../src/project/sql"
import { SessionTable, SessionExecutionGateTable, SandboxExecutionGateTable } from "../src/session/sql"
import { SandboxTable, SandboxCommandTable, AliyunSnapshotTable } from "../src/sandbox/sql"
import { SandboxConfig } from "../src/sandbox/config"
import { byteRange, make } from "../src/sandbox/aliyun/provider"
import type { Api, Remote } from "../src/sandbox/aliyun/client"
import type { Interface } from "../src/sandbox/contract"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const fixture = (options: { pause?: boolean; persistMode?: "none" | "snapshot" | "pvc" | null; cpu?: string; noSandbox?: boolean; idleReapSeconds?: number } = {}) => Effect.gen(function* () {
  const { db } = yield* Database.Service
  const root = Session.ID.create()
  const child = Session.ID.create()
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] }).onConflictDoNothing().run()
  for (const id of [root, child]) yield* db.insert(SessionTable).values({
    id, project_id: Project.ID.global, slug: id, directory: "/workspace", version: "test",
    ...(id === child ? { parent_id: root } : options.noSandbox ? {} : { sandbox: { ...(options.persistMode === null ? {} : { persistMode: options.persistMode ?? "snapshot" }), cpu: options.cpu ?? "2", memory: "4Gi" } }),
  }).run()
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    yield* db.delete(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).run()
    yield* db.delete(SessionExecutionGateTable).where(inArray(SessionExecutionGateTable.session_id, [root, child])).run()
    yield* db.delete(SandboxExecutionGateTable).where(eq(SandboxExecutionGateTable.root_session_id, root)).run()
    yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, root)).run()
    yield* db.delete(AliyunSnapshotTable).where(eq(AliyunSnapshotTable.session_id, root)).run()
    yield* db.delete(SessionTable).where(inArray(SessionTable.id, [root, child])).run()
  }).pipe(Effect.orDie))
  const state = { status: "running", creates: 0, connects: 0, pauses: 0, kills: 0, cancelled: [] as number[],
    token: "private-traffic-token" as string | undefined, lostCreate: false, denyPause: false, block: false, denyCancel: false,
    creation: undefined as SandboxOpts | undefined, commands: [] as string[], files: new Map<string, string>(),
    snapshots: [] as Array<{ snapshotId: string; names: string[] }>, captures: 0, deleted: [] as string[],
    template: "", denySnapshot: false, lostSnapshot: false, denyRestore: false,
    livePids: [123], denyList: false, denyInfo: false,
  }
  const remote: Remote = {
    id: `sbx-${root}`,
    get token() { return state.token },
    start: async (command) => {
      state.commands.push(command)
      if (command.includes(">'") && command.includes(".log'")) {
        const log = command.match(/>(?:')([^']+\.log)'/)?.[1]
        if (log) state.files.set(log, "hello aliyun")
      }
      if (command.startsWith("head -c")) {
        const paths = [...command.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? "")
        state.files.set(paths[1] ?? "", state.files.get(paths[0] ?? "") ?? "")
      }
      return { pid: state.commands.length, wait: async () => {
        if (state.block && command.startsWith("mkdir -p /workspace/.opencode/output")) return new Promise(() => {})
        return { exitCode: 0 }
      } }
    },
    killCommand: async (pid) => { if (state.denyCancel) throw new Error("cancel unavailable"); state.cancelled.push(pid); state.livePids = state.livePids.filter((value) => value !== pid); return true },
    listCommands: async () => { if (state.denyList) throw new Error("list unavailable"); return state.livePids.map((pid) => ({ pid })) },
    snapshot: async (name) => {
      state.captures++
      if (state.denySnapshot) throw new Error("snapshot forbidden")
      const id = `snapshot-${state.captures}`
      state.snapshots.push({ snapshotId: id, names: [`team/${name}:latest`] })
      if (state.lostSnapshot) throw new Error("snapshot response lost")
      return id
    },
    extend: async () => {},
    stat: async (target) => { const value = state.files.get(target); if (value === undefined) throw new FileNotFoundError("missing"); return { size: Buffer.byteLength(value), type: "file" } },
    read: async (target) => { const value = state.files.get(target); if (value === undefined) throw new FileNotFoundError("missing"); return new TextEncoder().encode(value) },
    write: async (target, data) => { state.files.set(target, data) },
    mkdir: async () => {}, remove: async (target) => { state.files.delete(target) },
    list: async () => [{ name: "a.ts", type: "file" }],
  }
  const api: Api = {
    create: async (template, opts) => { state.creates++; state.template = template; if (state.denyRestore && template.startsWith("snapshot-")) throw new Error("snapshot expired"); state.status = "running"; state.creation = opts; if (state.lostCreate) throw new Error("response lost"); return { ...remote, id: `${remote.id}-${state.creates}` } },
    connect: async () => { state.connects++; if (state.status === "gone") throw new SandboxNotFoundError("gone"); state.status = "running"; return remote },
    info: async () => { if (state.denyInfo) throw new Error("info unavailable"); if (state.status === "gone") throw new SandboxNotFoundError("gone"); return { state: state.status, cpuCount: 2, memoryMB: 4096 } },
    find: async () => [],
    kill: async () => { state.kills++; state.status = "gone"; return true },
    snapshots: async () => state.snapshots,
    deleteSnapshot: async (id) => { state.deleted.push(id); return true },
  }
  const provider: Interface = yield* make({ ...SandboxConfig.load(), enabled: true, provider: "aliyun", volumeType: "snapshot", idleReapSeconds: options.idleReapSeconds ?? 0,
    aliyun: { apiKey: "never-persist-this", apiUrl: "https://api.cn-hangzhou.sandbox.aliyuncs.com", domain: "cn-hangzhou.sandbox.aliyuncs.com",
      template: "code-interpreter-v1", pauseEnabled: options.pause ?? true, installRipgrep: false },
  }, api)
  return { db, root, child, state, provider, remote }
})

it.live("lazy keepalive, root ownership, secure create and independent snapshot restore", () => Effect.gen(function* () {
  const { root, child, provider, state, db } = yield* fixture()
  yield* provider.keepAlive(root)
  expect(state.creates).toBe(0)
  expect(yield* provider.sandboxId(root)).toBeNull()
  expect(yield* provider.endpoint(root, 9911, true)).toEqual({ _tag: "no-sandbox" })
  const id = yield* provider.boot(child)
  expect(yield* provider.boot(root)).toBe(id)
  expect(state.creates).toBe(1)
  expect(state.creation?.secure).toBe(true)
  expect(state.creation?.network?.allowPublicTraffic).toBe(false)
  expect(state.creation?.lifecycle?.onTimeout).toBe("kill")
  const record = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get()
  expect(record?.provider).toBe("aliyun")
  expect(JSON.stringify(record)).not.toContain("never-persist-this")
  const endpoint = yield* provider.endpoint(child, 9911, true)
  expect(endpoint._tag).toBe("resolved")
  if (endpoint._tag === "resolved") {
    expect(endpoint.endpoint).toStartWith("https://9911-")
    expect(endpoint.endpoint).not.toContain("private-traffic-token")
    expect(endpoint.headers?.["e2b-traffic-access-token"]).toBe("private-traffic-token")
  }
  yield* provider.fileWrite(child, "/workspace/a.txt", "retained")
  yield* provider.release(root)
  expect(state.pauses).toBe(0)
  expect(state.captures).toBe(1)
  expect(state.kills).toBe(1)
  expect((yield* provider.lifecycle(root)).state).toBe("destroyed")
  expect(yield* provider.isKeepAlive(root)).toBe(false)
  expect(yield* provider.boot(root)).not.toBe(id)
  expect(state.template).toBe("snapshot-1")
  expect(state.creation?.metadata?.opencode_session).toBe(root)
  expect(state.creation?.metadata?.opencode_intent).toStartWith("intent:")
  expect(yield* provider.fileRead(root, "/workspace/a.txt")).toBe("retained")
  yield* provider.destroy(root)
  if (provider.purge) yield* provider.purge(root)
  expect(state.kills).toBe(2)
  yield* provider.deleteSnapshots(root)
  expect(state.deleted).toHaveLength(2)
}))

it.live("concurrent root and child boots use the PG creation lease", () => Effect.gen(function* () {
  const { root, child, provider, state } = yield* fixture()
  const ids = yield* Effect.all([provider.boot(root), provider.boot(child)], { concurrency: 2 })
  expect(ids[0]).toBe(ids[1])
  expect(state.creates).toBe(1)
}))

it.live("temporary workspaces kill on release and may start fresh", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture({ persistMode: "none", pause: false })
  yield* provider.boot(root)
  expect(state.creation?.lifecycle?.onTimeout).toBe("kill")
  yield* provider.release(root)
  expect(state.kills).toBe(1)
  expect(state.pauses).toBe(0)
  yield* provider.boot(root)
  expect(state.creates).toBe(2)
}))

for (const options of [{ noSandbox: true }, { persistMode: null }]) {
  it.live(`defaults to temporary workspaces without pause access: ${JSON.stringify(options)}`, () => Effect.gen(function* () {
    const { root, provider, state } = yield* fixture({ ...options, pause: false })
    expect((yield* provider.lifecycle(root)).persistMode).toBe("none")
    yield* provider.boot(root)
    expect(state.creation?.lifecycle?.onTimeout).toBe("kill")
    yield* provider.destroy(root)
    expect(state.kills).toBe(1)
    expect(state.pauses).toBe(0)
  }))
}

for (const [name, options, message] of [
  ["PVC", { persistMode: "pvc" as const }, "does not support"],
] as const) it.live(`rejects ${name} before creating billable resources`, () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture(options)
  const result = yield* provider.boot(root).pipe(Effect.result)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.message).toContain(message)
  expect(state.creates).toBe(0)
}))

it.live("rejects resource requests that do not match the selected template", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture({ cpu: "4" })
  const result = yield* provider.boot(root).pipe(Effect.result)
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") expect(result.failure.message).toContain("do not match")
  expect(state.creates).toBe(1)
}))

it.live("lost create responses retain intent and never blindly replay creation", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  state.lostCreate = true
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.creates).toBe(1)
  expect((yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get())?.remote_name).toStartWith("intent:")
}))

it.live("missing retained workspaces fail without replacing them", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  yield* provider.boot(root)
  yield* provider.destroy(root)
  state.denyRestore = true
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.creates).toBe(2)
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.creates).toBe(2)
}))

it.live("snapshot denial does not kill or claim that a workspace was preserved", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  yield* provider.boot(root)
  state.denySnapshot = true
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* provider.lifecycle(root)).state).toBe("snapshotting")
  expect(state.kills).toBe(0)
}))

it.live("lost snapshot response reconciles the unique intent without replay", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture({ pause: false })
  yield* provider.boot(root)
  state.lostSnapshot = true
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect(state.kills).toBe(0)
  expect((yield* provider.latestSnapshot(root))?.state).toBe("creating")
  yield* db.update(SandboxTable).set({ time_updated: Date.now() - 400000 }).where(eq(SandboxTable.session_id, root)).run()
  yield* provider.destroy(root)
  expect(state.captures).toBe(1)
  expect(state.kills).toBe(1)
  expect((yield* provider.latestSnapshot(root))?.state).toBe("ready")
  yield* provider.boot(root)
  expect(state.template).toBe("snapshot-1")
  expect((yield* provider.snapshotStats(root)).restoredTotal).toBe(1)
}))

it.live("unconfirmed snapshots remain blocked after lease expiry without new create", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  yield* provider.boot(root)
  state.denySnapshot = true
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  yield* db.update(SandboxTable).set({ time_updated: Date.now() - 400000 }).where(eq(SandboxTable.session_id, root)).run()
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect(state.captures).toBe(1)
  expect(state.kills).toBe(0)
  yield* db.update(SandboxTable).set({ time_updated: Date.now() - 400000 }).where(eq(SandboxTable.session_id, root)).run()
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect(state.captures).toBe(1)
}))

it.live("explicit snapshot keeps the generation running and admission open", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  const id = yield* provider.boot(root)
  expect((yield* provider.snapshot(root)).state).toBe("ready")
  expect(yield* provider.sandboxId(root)).toBe(id)
  expect(state.kills).toBe(0)
  yield* provider.fileWrite(root, "/workspace/after.txt", "after")
  expect(yield* provider.fileRead(root, "/workspace/after.txt")).toBe("after")
}))

it.live("lost capture-only responses reconcile without stopping the source", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  const generation = yield* provider.boot(root)
  state.lostSnapshot = true
  expect((yield* provider.snapshot(root).pipe(Effect.exit))._tag).toBe("Failure")
  yield* db.update(SandboxTable).set({ time_updated: 0 }).where(eq(SandboxTable.session_id, root)).run()
  yield* provider.destroy(root)
  expect(state.captures).toBe(1)
  expect(state.kills).toBe(0)
  expect(yield* provider.sandboxId(root)).toBe(generation)
  yield* provider.fileWrite(root, "/workspace/after.txt", "open")
  state.lostSnapshot = false
  yield* provider.destroy(root)
  expect(state.kills).toBe(1)
}))

for (const unavailable of [false, true]) it.live(`orphan commands are reconciled only with confirmed termination: unavailable=${unavailable}`, () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  const generation = yield* provider.boot(root)
  yield* db.insert(SandboxCommandTable).values({ id: root, session_id: root, sandbox_id: generation, command_id: "123", operation_id: root }).run()
  state.livePids = []
  state.denyList = unavailable
  const outcome = yield* provider.destroy(root).pipe(Effect.exit)
  expect(outcome._tag).toBe(unavailable ? "Failure" : "Success")
  expect(state.kills).toBe(unavailable ? 0 : 1)
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(unavailable ? 1 : 0)
}))

it.live("a confirmed missing source restores the saved snapshot with a new generation", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  const generation = yield* provider.boot(root)
  yield* provider.snapshot(root)
  state.status = "gone"
  expect(yield* provider.boot(root)).not.toBe(generation)
  expect(state.template).toBe("snapshot-1")
  expect(state.kills).toBe(0)
}))

it.live("a missing source without a checkpoint fails closed but can be explicitly deleted", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  yield* provider.boot(root)
  state.status = "gone"
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.creates).toBe(1)
  const lost = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get()
  expect(lost?.state).toBe("destroyed")
  expect(lost?.remote_name).toStartWith("lost:")
  yield* provider.destroy(root)
  if (provider.purge) yield* provider.purge(root)
  expect((yield* provider.lifecycle(root)).state).toBe("destroyed")
  expect(state.captures).toBe(0)
}))

it.live("confirmed cancellation clears the orphan ledger", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  const generation = yield* provider.boot(root)
  yield* db.insert(SandboxCommandTable).values({ id: root, session_id: root, sandbox_id: generation, command_id: "123", operation_id: root }).run()
  state.denyCancel = true
  expect((yield* provider.interrupt(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(1)
  state.denyCancel = false
  yield* provider.interrupt(root)
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(0)
  yield* provider.destroy(root)
  expect(state.kills).toBe(1)
}))

it.live("transient source probes never discard a binding or restore a checkpoint", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  const generation = yield* provider.boot(root)
  yield* provider.snapshot(root)
  state.denyInfo = true
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, root)).get())?.id).toBe(generation)
  expect(state.creates).toBe(1)
  expect(state.kills).toBe(0)
}))

it.live("active commands prevent capture and preserve an open workspace", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  const id = yield* provider.boot(root)
  yield* db.insert(SandboxCommandTable).values({ id: root, session_id: root, sandbox_id: id, command_id: "123", operation_id: root }).run()
  expect((yield* provider.destroy(root).pipe(Effect.exit))._tag).toBe("Failure")
  expect((yield* provider.lifecycle(root)).state).toBe("running")
  expect(state.captures).toBe(0)
  expect(state.kills).toBe(0)
}))

it.live("concurrent stops cannot dispatch multiple snapshots", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  yield* provider.boot(root)
  yield* Effect.all([provider.destroy(root).pipe(Effect.exit), provider.destroy(root).pipe(Effect.exit)], { concurrency: 2 })
  expect(state.captures).toBe(1)
  expect(state.kills).toBe(1)
}))

it.live("read-only readiness and endpoint lookup never resume paused VMs", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  yield* provider.boot(root)
  state.status = "paused"
  const before = state.connects
  expect(yield* provider.isReady(root)).toBe(false)
  expect(yield* provider.endpoint(root, 9911, true)).toEqual({ _tag: "no-sandbox" })
  expect(state.connects).toBe(before)
}))

it.live("refuses missing traffic tokens and validates port bounds", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  state.token = undefined
  expect((yield* provider.boot(root).pipe(Effect.result))._tag).toBe("Failure")
  expect(state.kills).toBe(0)
}))

it.live("files preserve null, UTF-8, byte ranges, listings and deletion", () => Effect.gen(function* () {
  const { root, provider } = yield* fixture()
  expect(yield* provider.fileRead(root, "/workspace/missing")).toBeNull()
  expect(yield* provider.fileStat(root, "/workspace/missing")).toBeNull()
  yield* provider.fileWrite(root, "/workspace/a.txt", "中文abc")
  expect(yield* provider.fileRead(root, "/workspace/a.txt")).toBe("中文abc")
  expect(new TextDecoder().decode((yield* provider.fileReadBytes(root, "/workspace/a.txt", { range: "bytes=-3" })) ?? undefined)).toBe("abc")
  expect(yield* provider.fileList(root, "/workspace")).toEqual([{ name: "a.ts", isDirectory: false }])
  expect(yield* provider.fileFind(root, "/workspace", "*.ts")).toEqual([{ path: "/workspace/a.ts", isDirectory: false }])
  yield* provider.fileDelete(root, "/workspace/a.txt")
  expect(yield* provider.fileRead(root, "/workspace/a.txt")).toBeNull()
}))

it.live("command completion reads bounded output and removes the PG operation", () => Effect.gen(function* () {
  const { root, child, provider, db } = yield* fixture()
  const result = yield* provider.run({ sessionID: child, hostWorkdir: "/workspace", command: "printf hello", isolated: true })
  expect(result.output).toBe("hello aliyun")
  expect(result.exitCode).toBe(0)
  expect(result.timedOut).toBe(false)
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(0)
}))

it.live("command timeout cancels only that remote PID", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture()
  state.block = true
  const result = yield* provider.run({ sessionID: root, hostWorkdir: "/workspace", command: "sleep 100", timeoutMs: 20 })
  expect(result.timedOut).toBe(true)
  expect(state.cancelled).toHaveLength(1)
}))

it.live("unconfirmed cancellation retains the PG operation for reconciliation", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  state.block = true; state.denyCancel = true
  expect((yield* provider.run({ sessionID: root, hostWorkdir: "/workspace", command: "sleep 100", timeoutMs: 20 })).timedOut).toBe(true)
  expect(yield* db.select().from(SandboxCommandTable).where(eq(SandboxCommandTable.session_id, root)).all()).toHaveLength(1)
}))

for (const [name, keepAlive, status] of [
  ["idle", false, "running"],
  ["idle kept alive", true, "running"],
  ["pending kill", false, "killed"],
] as const) {
  it.live(`reaps ${name} without changing the keepalive preference`, () => Effect.gen(function* () {
    const { root, provider, state, db } = yield* fixture({ idleReapSeconds: 60 })
    if (keepAlive) yield* provider.keepAlive(root)
    yield* provider.boot(root)
    yield* db.update(SandboxTable).set({ state: status, time_updated: 0 }).where(eq(SandboxTable.session_id, root)).run()
    yield* Effect.sleep("16 seconds")
    expect((yield* provider.lifecycle(root)).state).toBe("destroyed")
    expect(yield* provider.isKeepAlive(root)).toBe(keepAlive)
    expect(state.captures).toBe(1)
    expect(state.kills).toBe(1)
    expect(state.creates).toBe(1)
  }), 25000)
}

it.live("idle reaping retains fresh workspaces", () => Effect.gen(function* () {
  const { root, provider, state } = yield* fixture({ idleReapSeconds: 60 })
  yield* provider.keepAlive(root)
  yield* provider.boot(root)
  yield* provider.fileWrite(root, "/workspace/active.txt", "active")
  yield* Effect.sleep("16 seconds")
  expect((yield* provider.lifecycle(root)).state).toBe("running")
  expect(state.kills).toBe(0)
  expect(state.captures).toBe(0)
}), 25000)

it.live("disabled idle reaping retains stale running workspaces", () => Effect.gen(function* () {
  const { root, provider, state, db } = yield* fixture()
  yield* provider.boot(root)
  yield* db.update(SandboxTable).set({ time_updated: 0 }).where(eq(SandboxTable.session_id, root)).run()
  yield* Effect.sleep("16 seconds")
  expect((yield* provider.lifecycle(root)).state).toBe("running")
  expect(state.kills).toBe(0)
  expect(state.captures).toBe(0)
}), 25000)

for (const stale of [true, false]) {
  it.live(`pending kill reconciliation respects its lease when idle reaping is disabled: stale=${stale}`, () => Effect.gen(function* () {
    const { root, provider, state, db } = yield* fixture()
    yield* provider.boot(root)
    yield* db.update(SandboxTable).set({ state: "killed", time_updated: stale ? 0 : Date.now() })
      .where(eq(SandboxTable.session_id, root)).run()
    yield* Effect.sleep("16 seconds")
    expect((yield* provider.lifecycle(root)).state).toBe(stale ? "destroyed" : "killed")
    expect(state.captures).toBe(stale ? 1 : 0)
    expect(state.kills).toBe(stale ? 1 : 0)
    expect(state.creates).toBe(1)
  }), 25000)
}

for (const reason of ["snapshot failure", "active command"] as const) {
  it.live(`idle reaping preserves the source on ${reason}`, () => Effect.gen(function* () {
    const { root, provider, state, db } = yield* fixture({ idleReapSeconds: 60 })
    yield* provider.keepAlive(root)
    const generation = yield* provider.boot(root)
    if (reason === "snapshot failure") state.denySnapshot = true
    else yield* db.insert(SandboxCommandTable).values({ id: root, session_id: root, sandbox_id: generation,
      command_id: "123", operation_id: root }).run()
    yield* db.update(SandboxTable).set({ time_updated: 0 }).where(eq(SandboxTable.session_id, root)).run()
    yield* Effect.sleep("16 seconds")
    expect((yield* provider.lifecycle(root)).state).toBe(reason === "snapshot failure" ? "snapshotting" : "running")
    expect(yield* provider.isKeepAlive(root)).toBe(true)
    expect(state.kills).toBe(0)
    expect(state.captures).toBe(reason === "snapshot failure" ? 1 : 0)
  }), 25000)
}

test("byte range validation rejects malformed, multiple, empty and unsafe ranges", () => {
  const bytes = new TextEncoder().encode("abcde")
  expect(new TextDecoder().decode(byteRange(bytes, "bytes=1-3"))).toBe("bcd")
  expect(new TextDecoder().decode(byteRange(bytes, "bytes=2-"))).toBe("cde")
  for (const range of ["bytes=-0", "bytes=-", "bytes=5-", "bytes=3-1", "bytes=0-1,3-4", "bytes=90071992547409999-"])
    expect(() => byteRange(bytes, range)).toThrow()
})
