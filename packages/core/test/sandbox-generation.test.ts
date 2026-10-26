import { describe, expect, it as test } from "bun:test"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../src/database/database"
import { isCurrentSandbox, touchCurrentSandbox, resumeRetainedSandbox } from "../src/sandbox/lifecycle/generation"
import { SandboxTable } from "../src/sandbox/sql"
import { testEffect } from "./lib/effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "../src/location"
import { AbsolutePath } from "@opencode/schema/schema"

describe("sandbox generation admission", () => {
  test("rejects a healthy cached handle whose generation no longer owns the row", () => {
    expect(isCurrentSandbox({ id: "new", state: "running" }, "old")).toBe(false)
    expect(isCurrentSandbox({ id: "new", state: "running" }, "new")).toBe(true)
    expect(isCurrentSandbox(null, "old")).toBe(false)
    expect(isCurrentSandbox(undefined, "old")).toBe(false)
  })

  for (const state of ["creating", "snapshotting", "killed", "destroyed"] as const) {
    test(`rejects the same cached ID when its state is ${state}`, () => {
      expect(isCurrentSandbox({ id: "old", state }, "old")).toBe(false)
    })
  }
})

const it = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node]),
  [Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") }))],
))

describe("sandbox generation PG/SQLite CAS", () => {
  it.effect("only the retained snapshotting generation resumes without changing activity", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = `retained-${randomUUID()}`
      const sandboxID = randomUUID()
      try {
        yield* db.insert(SandboxTable).values({ id: sandboxID, session_id: sessionID, host: "test", state: "snapshotting", time_updated: 123 }).run()
        expect(yield* resumeRetainedSandbox(db, sessionID, "old")).toBe(false)
        expect(yield* resumeRetainedSandbox(db, sessionID, sandboxID)).toBe(true)
        const row = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).get()
        expect(row?.state).toBe("running")
        expect(row?.time_updated).toBe(123)
        expect(yield* resumeRetainedSandbox(db, sessionID, sandboxID)).toBe(false)
      } finally { yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).run() }
    }),
  )
  it.effect("old activity and command-session writes cannot mutate the replacement", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const sessionID = `generation-${randomUUID()}`
      const sandboxID = `sb-${randomUUID()}`
      try {
        yield* db.insert(SandboxTable).values({ id: sandboxID, session_id: sessionID, host: "test", state: "running", command_session_id: "new-command", time_updated: 123 }).run()
        expect(yield* touchCurrentSandbox(db, sessionID, "old")).toBe(false)
        expect(yield* touchCurrentSandbox(db, sessionID, "old", { id: "old-command" })).toBe(false)
        expect(yield* touchCurrentSandbox(db, sessionID, "old", { id: null })).toBe(false)
        const row = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).get()
        expect(row?.command_session_id).toBe("new-command")
        expect(row?.time_updated).toBe(123)
        expect(yield* touchCurrentSandbox(db, sessionID, sandboxID, { id: "current-command" })).toBe(true)
        const current = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).get()
        expect(current?.command_session_id).toBe("current-command")
        expect(current?.time_updated).toBeGreaterThan(123)
      } finally {
        yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).run()
      }
    }),
  )

  for (const state of ["creating", "snapshotting", "killed", "destroyed"] as const) {
    it.effect(`activity cannot reopen or update ${state}`, () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const sessionID = `generation-${randomUUID()}`
        const sandboxID = `sb-${randomUUID()}`
        try {
          yield* db.insert(SandboxTable).values({ id: sandboxID, session_id: sessionID, host: "test", state, time_updated: 123 }).run()
          expect(yield* touchCurrentSandbox(db, sessionID, sandboxID)).toBe(false)
          expect(yield* touchCurrentSandbox(db, sessionID, sandboxID, { id: "late-command" })).toBe(false)
          const row = yield* db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).get()
          expect(row?.state).toBe(state)
          expect(row?.time_updated).toBe(123)
          expect(row?.command_session_id).toBeNull()
        } finally {
          yield* db.delete(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).run()
        }
      }),
    )
  }
})
