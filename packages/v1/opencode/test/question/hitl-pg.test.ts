// Question 服务 PG 路径（PG-gated）：
//   ask 落库、reply 权威结果消费、幂等重复、冲突 409 语义（ConflictError）、
//   跨实例 poll 消费、PG 原子限流。
// 需要本地测试库：
//   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode_test bun test test/question/hitl-pg.test.ts
import { afterEach, beforeAll, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Question } from "../../src/question"
import { QuestionID } from "../../src/question/schema"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionID } from "../../src/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { HitlRequestTable } from "../../src/hitl/request.pg"
import { Database } from "../../src/storage/db"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const fixtureDb = DB_URL ? postgres(DB_URL as string) : undefined
const db = enabled ? Database.Client() : undefined

const questionLayer = LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node]))
const lifecycle = testEffect(Layer.mergeAll(questionLayer, testInstanceStoreLayer))
const it = lifecycle.live

const question = (text: string) => ({
  question: text,
  header: text.slice(0, 20),
  options: [{ label: "yes", description: "" }],
})

const askFork = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    return yield* svc.ask({ sessionID, questions: [question(text)] }).pipe(Effect.exit, Effect.forkScoped)
  })

const reply = (requestID: QuestionID, answers: string[][]) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    return yield* svc.reply({ requestID, answers: answers as never })
  })

const reject = (requestID: QuestionID) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    return yield* svc.reject(requestID)
  })

const listPending = Effect.gen(function* () {
  return yield* Question.Service.use((svc) => svc.list())
})

const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the effect to fail")
  })

async function createSession(directory: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const sessionID = SessionID.make(`ses_hitlq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
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
    [sessionID, directory, directory, "hitl-question-test", "HITL question test", "test", now, now],
  )
  return sessionID
}

// Deleting the project cascades to sessions and (via the hitl FK) to rows.
async function dropProject(directory: string) {
  if (!fixtureDb) return
  await fixtureDb.unsafe("DELETE FROM project WHERE id = $1", [directory]).catch(() => {})
}

// Simulates another instance replying directly in PG (bypasses this process).
async function remoteReply(rid: string, answers: string[][]) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  await fixtureDb.unsafe(`UPDATE hitl_request SET status = 'replied', result = $2, time_updated = $3 WHERE id = $1`, [
    rid,
    { answers },
    Date.now(),
  ])
}

async function insertForeignPending(input: { id: string; directory: string; sessionID: string }) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const now = Date.now()
  await fixtureDb.unsafe(
    `INSERT INTO hitl_request (
       id, kind, directory, session_id, owner_id, status, payload, lease_until, time_created, time_updated
     ) VALUES ($1, 'question', $2, $3, 'owner-remote', 'pending', $4, $5, $6, $7)`,
    [input.id, input.directory, input.sessionID, {}, now + 60_000, now, now],
  )
}

async function hitlStatus(rid: string) {
  const rows = await db!.select().from(HitlRequestTable).where(eq(HitlRequestTable.id, rid)).limit(1).all()
  const row = rows[0]
  if (!row) throw new Error(`hitl row not found: ${rid}`)
  const result = typeof row.result === "string" ? (JSON.parse(row.result) as Record<string, unknown>) : row.result
  return { status: row.status, result }
}

describe.skipIf(!enabled)("question HITL persistence (PG)", () => {
  beforeAll(async () => {
    await Database.initialize()
  })

  afterEach(async () => {
    await disposeAllInstances()
  })

  it("ask inserts a pending row scoped to this directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      yield* askFork(sessionID, "persisted?").pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))

      const list = yield* listPending.pipe(provideInstance(dir))
      expect(list).toHaveLength(1)
      const rid = list[0]!.id
      expect((yield* Effect.promise(() => hitlStatus(rid as string))).status).toBe("pending")

      yield* reject(rid).pipe(provideInstance(dir), Effect.ignore)
    }))

  it("reply consumes the PG result and archives the row", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      const fiber = yield* askFork(sessionID, "answer me").pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const rid = (yield* listPending.pipe(provideInstance(dir)))[0]!.id

      yield* reply(rid, [["yes"]]).pipe(provideInstance(dir))
      // askFork forks ask.pipe(Effect.exit), so Fiber.await yields Exit<Exit>.
      const outer = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(outer)).toBe(true)
      if (Exit.isSuccess(outer)) {
        expect(Exit.isSuccess(outer.value)).toBe(true)
        if (Exit.isSuccess(outer.value)) expect(outer.value.value).toEqual([["yes"]])
      }
      const row = yield* Effect.promise(() => hitlStatus(rid as string))
      expect(row.status).toBe("replied")
      expect(row.result).toEqual({ answers: [["yes"]] })
    }))

  it("repeating the same reply is idempotent", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      const fiber = yield* askFork(sessionID, "twice").pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const rid = (yield* listPending.pipe(provideInstance(dir)))[0]!.id

      yield* reply(rid, [["yes"]]).pipe(provideInstance(dir))
      yield* Fiber.await(fiber)
      const repeat = yield* reply(rid, [["yes"]]).pipe(provideInstance(dir), Effect.exit)
      expect(Exit.isSuccess(repeat)).toBe(true)
      expect((yield* Effect.promise(() => hitlStatus(rid as string))).status).toBe("replied")
    }))

  it("a late divergent reply conflicts and never overrides the rejection", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      const fiber = yield* askFork(sessionID, "reject then late reply").pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const rid = (yield* listPending.pipe(provideInstance(dir)))[0]!.id

      yield* reject(rid).pipe(provideInstance(dir))
      const outer = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(outer)).toBe(true)
      if (Exit.isSuccess(outer)) expect(Exit.isFailure(outer.value)).toBe(true)

      const error = yield* failure(reply(rid, [["yes"]]).pipe(provideInstance(dir)))
      expect(error).toBeInstanceOf(Question.ConflictError)
      if (error instanceof Question.ConflictError) expect(error.status).toBe("rejected")

      const row = yield* Effect.promise(() => hitlStatus(rid as string))
      expect(row.status).toBe("rejected")
      expect(row.result).toBeNull()
    }))

  it("a remote reply is consumed by the polling fiber with the PG answer", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      const fiber = yield* askFork(sessionID, "remote reply").pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const rid = (yield* listPending.pipe(provideInstance(dir)))[0]!.id as string

      yield* Effect.promise(() => remoteReply(rid, [["from-instance-b"]]))

      const outer = yield* Fiber.await(fiber).pipe(
        Effect.timeoutOrElse({
          duration: "8 seconds",
          orElse: () => Effect.die(new Error("polling fiber never consumed the remote reply")),
        }),
      )
      expect(Exit.isSuccess(outer)).toBe(true)
      if (Exit.isSuccess(outer)) {
        expect(Exit.isSuccess(outer.value)).toBe(true)
        if (Exit.isSuccess(outer.value)) expect(outer.value.value).toEqual([["from-instance-b"]])
      }
      expect((yield* listPending.pipe(provideInstance(dir))).length).toBe(0)
    }))

  it("the PG pending limit rejects asks even when this process holds nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))
      for (let i = 0; i < 10; i++) {
        yield* Effect.promise(() =>
          insertForeignPending({ id: `que_foreign_${Date.now()}_${i}`, directory: dir, sessionID }),
        )
      }

      const defect = yield* failure(
        Effect.gen(function* () {
          const svc = yield* Question.Service
          return yield* svc.ask({ sessionID, questions: [question("over the limit")] })
        }).pipe(provideInstance(dir)),
      )
      expect(String(defect)).toContain("Too many pending questions")
      expect((yield* listPending.pipe(provideInstance(dir))).length).toBe(10)
    }))
})
