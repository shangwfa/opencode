import { randomUUID } from "node:crypto"
import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { ConnectionConfig, SandboxManager } from "@alibaba-group/opensandbox"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { SessionTable } from "../src/session/sql"
import { SessionSchema } from "../src/session/schema"
import { ProjectTable } from "../src/project/sql"
import { ProjectSchema } from "../src/project/schema"
import { SandboxSnapshot } from "../src/sandbox/snapshot"
import { SessionSnapshotTable } from "../src/sandbox/snapshot.sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "../src/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), [
  Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
]))
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.live : it.live.skip

const fixture = <A>(run: (db: Database.Interface["db"], sessionID: string) => Effect.Effect<A, Error>) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const id = randomUUID()
    const projectID = ProjectSchema.ID.make(`snapshot-safety-${id}`)
    const sessionID = SessionSchema.ID.make(`ses_snapshot_safety_${id}`)
    yield* db.insert(ProjectTable).values({ id: projectID, worktree: AbsolutePath.make("/workspace"), sandboxes: [] }).run()
    try {
      yield* db.insert(SessionTable).values({
        id: sessionID, project_id: projectID, slug: id, directory: AbsolutePath.make("/workspace"), version: "test",
      }).run()
      return yield* run(db, sessionID)
    } finally {
      yield* db.delete(SessionSnapshotTable).where(eq(SessionSnapshotTable.session_id, sessionID)).run()
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      yield* db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run()
    }
  })

const snapshot = (db: Database.Interface["db"], manager: Pick<ReturnType<typeof SandboxManager.create>, "createSnapshot" | "getSnapshot" | "deleteSnapshot">, deleteEnabled = true) =>
  SandboxSnapshot.create({ db, manager, connectionConfig: new ConnectionConfig({ domain: "127.0.0.1:1", protocol: "http" }), ttlMs: 1, waitMs: 100, deleteEnabled })

pgTest("concurrent replicas acquire creation rights before making one remote snapshot", () => fixture((db, sessionID) =>
  Effect.gen(function* () {
    let creates = 0
    let preparations = 0
    const manager = {
      createSnapshot: async (sandboxId: string) => {
        creates++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return { id: randomUUID(), sandboxId, status: { state: "Creating" as const }, createdAt: new Date() }
      },
      deleteSnapshot: async () => {},
      getSnapshot: async () => { throw new Error("unexpected getSnapshot") },
    }
    const replicas = Array.from({ length: 6 }, () => snapshot(db, manager))
    const ids = yield* Effect.all(replicas.map((replica) => replica.startSnapshot("sandbox-original", sessionID, {
      prepare: () => Effect.sync(() => { preparations++; return { arch: "arm64" } }),
    })), { concurrency: "unbounded" })
    expect(creates).toBe(1)
    expect(preparations).toBe(1)
    expect(new Set(ids).size).toBe(1)
    const row = yield* db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, ids[0])).get()
    expect(row?.manifest_token).toMatch(/^[a-f0-9-]{36}$/)
    const changed = yield* replicas[0].startSnapshot("sandbox-replacement", sessionID).pipe(Effect.result)
    expect(changed._tag).toBe("Failure")
    expect(creates).toBe(1)
  }),
))

pgTest("GC retains the latest recovery point even past local retention", () => fixture((db, sessionID) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* db.insert(SessionSnapshotTable).values({ id, session_id: sessionID, state: "ready", scope: "session", time_created: Date.now() - 100_000, time_updated: Date.now() - 100_000 }).run()
    const deleted: string[] = []
    const manager = {
      createSnapshot: async () => { throw new Error("unexpected createSnapshot") },
      deleteSnapshot: async (snapshotID: string) => { deleted.push(snapshotID) },
      getSnapshot: async () => { throw new Error("unexpected getSnapshot") },
    }
    const service = snapshot(db, manager, true)
    yield* service.gc(sessionID)
    expect(deleted).toEqual([])
    expect((yield* service.resolveForCreate(sessionID))?.id).toBe(id)
  }),
))

pgTest("restore failure preserves the restorable snapshot for a retry", () => fixture((db, sessionID) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* db.insert(SessionSnapshotTable).values({ id, session_id: sessionID, state: "ready", scope: "session", time_created: Date.now(), time_updated: Date.now() }).run()
    const manager = {
      createSnapshot: async () => { throw new Error("unexpected createSnapshot") },
      deleteSnapshot: async () => {},
      getSnapshot: async () => { throw new Error("unexpected getSnapshot") },
    }
    const service = snapshot(db, manager)
    yield* service.markRestoreFailed(sessionID, id, "transport timeout")
    const restorable = yield* service.resolveForCreate(sessionID)
    expect(restorable?.id).toBe(id)
    const row = yield* db.select().from(SessionSnapshotTable).where(eq(SessionSnapshotTable.id, id)).get()
    expect(row?.state).toBe("ready")
    expect(row?.reason).toBe("transport timeout")
  }),
))

pgTest("an overlapping request joins a settled winner; a later explicit request creates anew", () => fixture((db, sessionID) =>
  Effect.gen(function* () {
    const id = randomUUID()
    const captured = Date.now() - 1000
    yield* db.insert(SessionSnapshotTable).values({ id, session_id: sessionID, state: "ready", scope: "session", source_sandbox_id: "original", time_created: captured, time_updated: captured }).run()
    let creates = 0
    const manager = {
      createSnapshot: async (sandboxId: string) => { creates++; return { id: randomUUID(), sandboxId, status: { state: "Creating" as const }, createdAt: new Date() } },
      deleteSnapshot: async () => {},
      getSnapshot: async () => { throw new Error("unexpected getSnapshot") },
    }
    const service = snapshot(db, manager)
    expect(yield* service.startSnapshot("original", sessionID, { requestedAt: captured - 100 })).toBe(id)
    expect(creates).toBe(0)
    expect(yield* service.startSnapshot("original", sessionID, { requestedAt: captured + 100 })).not.toBe(id)
    expect(creates).toBe(1)
  }),
))

pgTest("an insertion conflict never returns the rolled-back remote snapshot ID", () => fixture((db, sessionID) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* db.insert(SessionSnapshotTable).values({ id, session_id: sessionID, state: "ready", scope: "session", time_created: Date.now(), time_updated: Date.now() }).run()
    const deleted: string[] = []
    const manager = {
      createSnapshot: async (sandboxId: string) => ({ id, sandboxId, status: { state: "Creating" as const }, createdAt: new Date() }),
      deleteSnapshot: async (snapshotID: string) => { deleted.push(snapshotID) },
      getSnapshot: async () => { throw new Error("unexpected getSnapshot") },
    }
    for (const deleteEnabled of [false, true]) {
      const result = yield* snapshot(db, manager, deleteEnabled).startSnapshot("original", sessionID).pipe(Effect.result)
      expect(result._tag).toBe("Failure")
    }
    expect(deleted).toEqual([])
  }),
))
