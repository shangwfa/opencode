// SessionGoal PG 回读（PG-gated）：
//   实例内存 miss（重启/路由切换）时从 session_goal 表恢复 active 行；
//   非 active 行不恢复；恢复后 bumpReact 持久化到同一行。
// 需要本地测试库：
//   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode_test bun test test/session/goal-restore-pg.test.ts
import { afterEach, beforeAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { Goal } from "../../src/session/goal"
import { Provider } from "@/provider/provider"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionID } from "../../src/session/schema"
import { SessionGoalTable } from "../../src/session/goal.pg"
import { SessionTable } from "../../src/session/session.pg"
import { Database } from "../../src/storage/db"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const fixtureDb = DB_URL ? postgres(DB_URL as string) : undefined
const db = enabled ? Database.Client() : undefined

const mockProvider = Layer.mock(Provider.Service, {})
const mockAuth = Layer.mock(Auth.Service, {})
const mockConfig = Layer.mock(Config.Service, {
  get: () => Effect.succeed({ experimental: {} }) as never,
})

const testLayer = Layer.mergeAll(
  Goal.layer.pipe(Layer.provide(mockProvider), Layer.provide(mockAuth), Layer.provide(mockConfig)),
  LayerNode.compile(CrossSpawnSpawner.node),
  testInstanceStoreLayer,
)
const it = testEffect(testLayer).live

const sessions: string[] = []

async function createSession(directory: string, sessionID: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const now = Date.now()
  await fixtureDb.unsafe(
    `INSERT INTO project (id, worktree, time_created, time_updated, sandboxes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [directory, directory, now, now, []],
  )
  await fixtureDb.unsafe(
    `INSERT INTO session (
       id, project_id, directory, slug, title, version, time_created, time_updated,
       cost, tokens_input, tokens_output, tokens_reasoning
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 0)`,
    [sessionID, directory, directory, "goal-restore-test", "Goal restore test", "test", now, now],
  )
  sessions.push(sessionID)
}

// Simulates another instance (or a pre-restart world) having persisted a goal.
async function insertGoalRow(sessionID: string, condition: string, react: number, status: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  await fixtureDb.unsafe(
    `INSERT INTO session_goal (session_id, condition, react, status, time_created, time_updated)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [sessionID, condition, react, status, Date.now(), Date.now()],
  )
}

async function goalRow(sessionID: string) {
  const rows = (await db!
    .select()
    .from(SessionGoalTable)
    .where(eq(SessionGoalTable.session_id, sessionID as never))
    .limit(1)) as unknown as Array<{ condition: string; react: number; status: string }>
  return rows[0]
}

describe.skipIf(!enabled)("SessionGoal restore from PG", () => {
  beforeAll(async () => {
    await Database.initialize()
  })

  afterEach(async () => {
    for (const sid of sessions)
      await db!
        .delete(SessionGoalTable)
        .where(eq(SessionGoalTable.session_id, sid as never))
        .run()
    for (const sid of sessions)
      await db!
        .delete(SessionTable)
        .where(eq(SessionTable.id, sid as never))
        .run()
    sessions.length = 0
    await disposeAllInstances()
  })

  it("recovers an active goal written by another instance", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = SessionID.make(`ses_goalr_${Date.now()}`)
      yield* Effect.promise(async () => {
        await createSession(dir, sessionID)
        await insertGoalRow(sessionID, "all tests green", 3, "active")
      })

      const goal = yield* Goal.Service
      const restored = yield* goal.get(sessionID).pipe(provideInstance(dir))
      expect(restored).toEqual({ condition: "all tests green", react: 3 })

      const bumped = yield* goal.bumpReact(sessionID).pipe(provideInstance(dir))
      expect(bumped).toBe(4)
      const row = yield* Effect.promise(() => goalRow(sessionID))
      expect(row?.react).toBe(4)
    }))

  it("does not recover terminal rows", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = SessionID.make(`ses_goalt_${Date.now()}`)
      yield* Effect.promise(async () => {
        await createSession(dir, sessionID)
        await insertGoalRow(sessionID, "obsolete condition", 1, "completed")
      })

      const goal = yield* Goal.Service
      const got = yield* goal.get(sessionID).pipe(provideInstance(dir))
      expect(got).toBeUndefined()
    }))

  it("clear after restore removes the PG row", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const sessionID = SessionID.make(`ses_goalc_${Date.now()}`)
      yield* Effect.promise(async () => {
        await createSession(dir, sessionID)
        await insertGoalRow(sessionID, "temporary goal", 0, "active")
      })

      const goal = yield* Goal.Service
      yield* goal.get(sessionID).pipe(provideInstance(dir))
      yield* goal.clear(sessionID).pipe(provideInstance(dir))
      const got = yield* goal.get(sessionID).pipe(provideInstance(dir))
      expect(got).toBeUndefined()
      const row = yield* Effect.promise(() => goalRow(sessionID))
      expect(row).toBeUndefined()
    }))
})
