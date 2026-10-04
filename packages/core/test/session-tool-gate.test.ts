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
    const closure = yield* gate.close(root, true, sandboxID)
    if (!closure) return yield* Effect.die(new Error("missing closure"))
    for (const id of [root, child])
      expect(yield* gate.admit(id, sandboxID, () => Effect.succeed(true)).pipe(Effect.isFailure)).toBe(true)
    expect(yield* gate.booted(root, sandboxID).pipe(Effect.isFailure)).toBe(true)
    yield* gate.destroyed(root, closure)
    expect(yield* gate.booted(root, sandboxID).pipe(Effect.isFailure)).toBe(true)
    const replacement = `${sandboxID}-replacement`
    yield* db.update(SandboxTable).set({ id: replacement }).where(eq(SandboxTable.session_id, root)).run()
    yield* gate.booted(root, replacement)
    expect(yield* gate.admit(child, replacement, () => Effect.succeed(true))).toBe(true)
    expect(yield* gate.admit(root, sandboxID, () => Effect.succeed(true)).pipe(Effect.isFailure)).toBe(true)
  }),
)

// Multiple DB connections are needed to demonstrate PG row-lock ordering.
it.live("stale generation completion cannot close a replacement Sandbox admission", () =>
  Effect.gen(function* () {
    const { db, root, sandboxID, gate } = yield* fixture
    const closure = yield* gate.close(root, true, sandboxID)
    if (!closure) return yield* Effect.die(new Error("missing closure"))
    yield* gate.destroyed(root, closure)
    const replacement = `${sandboxID}-replacement`
    yield* db.update(SandboxTable).set({ id: replacement }).where(eq(SandboxTable.session_id, root)).run()
    yield* gate.booted(root, replacement)
    yield* gate.destroyed(root, closure)
    expect(yield* gate.admit(root, replacement, () => Effect.succeed(true))).toBe(true)
  }),
)

const pg = process.env.OPENCODE_DATABASE_URL ? it.live : it.live.skip
for (const state of ["snapshotting", "killed", "destroyed"] as const) {
  it.live(`tool admission rejects a PG ${state} source even when its gate is open`, () =>
    Effect.gen(function* () {
      const { db, root, sandboxID, gate } = yield* fixture
      yield* db.update(SandboxTable).set({ state }).where(eq(SandboxTable.session_id, root)).run()
      let executed = false
      expect(
        yield* gate
          .admit(root, sandboxID, () =>
            Effect.sync(() => {
              executed = true
            }),
          )
          .pipe(Effect.isFailure),
      ).toBe(true)
      expect(executed).toBe(false)
    }),
  )
}

it.live("a stale physical close cannot change replacement admission", () =>
  Effect.gen(function* () {
    const { db, root, sandboxID, gate } = yield* fixture
    const replacement = `${sandboxID}-replacement`
    yield* db.update(SandboxTable).set({ id: replacement }).where(eq(SandboxTable.session_id, root)).run()
    yield* gate.booted(root, replacement)
    expect(yield* gate.close(root, true, sandboxID)).toBeNull()
    expect(yield* gate.admit(root, replacement, () => Effect.succeed(true))).toBe(true)
  }),
)

it.live("an older logical closure cannot reopen a newer closure", () =>
  Effect.gen(function* () {
    const { root, sandboxID, gate } = yield* fixture
    const first = yield* gate.close(root, false)
    const second = yield* gate.close(root, false)
    if (!first || !second) return yield* Effect.die(new Error("closure tokens were not returned"))
    expect(yield* gate.reopen(root, first)).toBe(false)
    expect(yield* gate.admit(root, sandboxID, () => Effect.void).pipe(Effect.isFailure)).toBe(true)
    expect(yield* gate.reopen(root, second)).toBe(true)
    expect(yield* gate.admit(root, sandboxID, () => Effect.succeed(true))).toBe(true)
  }),
)

it.live("an older physical closure cannot reopen a newer physical closure", () =>
  Effect.gen(function* () {
    const { root, sandboxID, gate } = yield* fixture
    const first = yield* gate.close(root, true, sandboxID)
    const second = yield* gate.close(root, true, sandboxID)
    if (!first || !second) return yield* Effect.die(new Error("closure tokens were not returned"))
    expect(yield* gate.destroyed(root, first)).toBe(false)
    expect(yield* gate.retained(root, first)).toBe(false)
    expect(yield* gate.admit(root, sandboxID, () => Effect.void).pipe(Effect.isFailure)).toBe(true)
    expect(yield* gate.retained(root, second)).toBe(true)
  }),
)

pg("an independent PG lifecycle writer waits for tool dispatch acknowledgement", () =>
  Effect.gen(function* () {
    const url = process.env.OPENCODE_DATABASE_URL
    if (!url) return yield* Effect.die(new Error("PG test requires a dedicated database"))
    const remote = new Bun.SQL(url)
    yield* Effect.addFinalizer(() => Effect.promise(() => remote.close()))
    yield* Effect.promise(() => remote`select 1`)
    const { root, sandboxID, gate } = yield* fixture
    const entered = yield* Deferred.make<void>()
    const accepted = yield* Deferred.make<void>()
    const admission = yield* gate
      .admit(root, sandboxID, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))))
      .pipe(Effect.forkScoped)
    yield* Deferred.await(entered)
    let transitioned = false
    const update = yield* Effect.promise(
      () => remote`update sandbox set state='snapshotting' where session_id=${root} and id=${sandboxID}`,
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          transitioned = true
        }),
      ),
      Effect.forkScoped,
    )
    yield* Effect.sleep("50 millis")
    expect(transitioned).toBe(false)
    yield* Deferred.succeed(accepted, undefined)
    yield* Fiber.join(admission)
    yield* Fiber.join(update)
    expect(transitioned).toBe(true)
    expect(yield* gate.admit(root, sandboxID, () => Effect.void).pipe(Effect.isFailure)).toBe(true)
  }),
)

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
    const closing = yield* gate.close(root, true, sandboxID).pipe(
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
