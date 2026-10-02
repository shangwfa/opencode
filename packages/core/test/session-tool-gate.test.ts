import { expect } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Deferred, Effect, Fiber } from "effect"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { SessionToolGate } from "../src/session/tool-gate"
import { SessionTable, SessionExecutionGateTable, SandboxExecutionGateTable } from "../src/session/sql"
import { SandboxTable } from "../src/sandbox/sql"
import { ProjectTable } from "../src/project/sql"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "../src/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const fixture = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const root = Session.ID.create()
  const child = Session.ID.create()
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
  for (const id of [root, child])
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/workspace",
        title: "tool gate test",
        version: "test",
        ...(id === child ? { parent_id: root } : {}),
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
  const sandboxID = `sandbox-${root}`
  yield* db
    .insert(SandboxTable)
    .values({
      id: sandboxID,
      session_id: root,
      host: "test",
      state: "running",
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    .run()
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* db
        .delete(SessionExecutionGateTable)
        .where(inArray(SessionExecutionGateTable.session_id, [root, child]))
        .run()
      yield* db.delete(SandboxExecutionGateTable).where(eq(SandboxExecutionGateTable.root_session_id, root)).run()
      yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, root)).run()
      yield* db
        .delete(SessionTable)
        .where(inArray(SessionTable.id, [root, child]))
        .run()
    }).pipe(Effect.orDie),
  )
  const gate = SessionToolGate.make(db)
  yield* gate.booted(root, sandboxID)
  return { db, root, child, sandboxID, gate }
})

it.live("child closure preserves root admission and leaves a deletion tombstone", () =>
  Effect.gen(function* () {
    const { db, root, child, sandboxID, gate } = yield* fixture
    expect(yield* gate.admit(child, sandboxID, (epoch) => Effect.succeed(epoch))).toBeGreaterThan(0)
    yield* gate.close(child, false)
    expect(yield* gate.admit(child, sandboxID, () => Effect.succeed(true)).pipe(Effect.isFailure)).toBe(true)
    expect(yield* gate.admit(root, sandboxID, () => Effect.succeed(true))).toBe(true)
    yield* db.delete(SessionTable).where(eq(SessionTable.id, child)).run()
    const tombstone = yield* db
      .select()
      .from(SessionExecutionGateTable)
      .where(eq(SessionExecutionGateTable.session_id, child))
      .get()
    expect(tombstone?.state).toBe("closed")
    expect(yield* gate.admit(child, sandboxID, () => Effect.succeed(true)).pipe(Effect.isFailure)).toBe(true)
  }),
)

it.live("physical closure blocks every logical session and rejects reopening an old Sandbox", () =>
  Effect.gen(function* () {
    const { db, root, child, sandboxID, gate } = yield* fixture
    yield* gate.close(root, true)
    for (const id of [root, child])
      expect(yield* gate.admit(id, sandboxID, () => Effect.succeed(true)).pipe(Effect.isFailure)).toBe(true)
    expect(yield* gate.booted(root, sandboxID).pipe(Effect.isFailure)).toBe(true)
    yield* gate.destroyed(root)
    expect(yield* gate.booted(root, sandboxID).pipe(Effect.isFailure)).toBe(true)
    const replacement = `${sandboxID}-replacement`
    yield* db.update(SandboxTable).set({ id: replacement }).where(eq(SandboxTable.session_id, root)).run()
    yield* gate.booted(root, replacement)
    expect(yield* gate.admit(child, replacement, () => Effect.succeed(true))).toBe(true)
    expect(yield* gate.admit(root, sandboxID, () => Effect.succeed(true)).pipe(Effect.isFailure)).toBe(true)
  }),
)

// Multiple DB connections are needed to demonstrate PG row-lock ordering.
const pg = process.env.OPENCODE_DATABASE_URL ? it.live : it.live.skip
pg("PG admission and destroy serialize until dispatch acknowledgement, then reject late admission", () =>
  Effect.gen(function* () {
    const { root, sandboxID, gate } = yield* fixture
    const entered = yield* Deferred.make<void>()
    const accepted = yield* Deferred.make<void>()
    const order: string[] = []
    const admission = yield* gate
      .admit(root, sandboxID, () =>
        Effect.gen(function* () {
          order.push("dispatch")
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(accepted)
          order.push("accepted")
        }),
      )
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    const closing = yield* gate.close(root, true).pipe(
      Effect.tap(() => Effect.sync(() => order.push("closed"))),
      Effect.forkScoped,
    )
    yield* Deferred.succeed(accepted, undefined)
    yield* Fiber.join(admission)
    yield* Fiber.join(closing)
    expect(order).toEqual(["dispatch", "accepted", "closed"])
    expect(yield* gate.admit(root, sandboxID, () => Effect.void).pipe(Effect.isFailure)).toBe(true)
  }),
)
