// Permission 服务 PG 路径（PG-gated）：
//   reply once/always/reject 事务级联、always 持久化 session.permission、
//   reject message -> CorrectedError（本地与跨实例 poll 两条路径）、PG 原子限流。
// 需要本地测试库：
//   OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:15432/opencode_test bun test test/permission/hitl-pg.test.ts
import { afterEach, beforeAll, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import postgres from "postgres"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "../../src/permission"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionPluginRuntime } from "../../src/plugin/session-plugin-runtime"
import { SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.pg"
import { HitlRequestTable } from "../../src/hitl/request.pg"
import { Database } from "../../src/storage/db"
import { disposeAllInstances, provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()
const fixtureDb = DB_URL ? postgres(DB_URL as string) : undefined
const db = enabled ? Database.Client() : undefined

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
// The sandbox plugin runtime creates real sandboxes in PG mode and stalls the
// ask path; these tests target the HITL CAS/cascade semantics, not plugins.
const stubPluginRuntime = Layer.succeed(
  SessionPluginRuntime.Service,
  SessionPluginRuntime.Service.of({
    acquire: () =>
      Effect.succeed({
        trigger: <Output>(_name: string, _input: unknown, output: Output) => Effect.succeed(output),
        event: () => Effect.void,
        auth: () => Effect.succeed({}),
        tools: () => Effect.succeed({}),
        dispose: () => Effect.void,
      } satisfies SessionPluginRuntime.Runtime),
    invalidate: () => Effect.void,
    dispose: () => Effect.void,
  }),
)
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [
    [InstanceStore.bootstrapNode, noopBootstrap],
    [SessionPluginRuntime.node, stubPluginRuntime],
  ],
)
const it = testEffect(env).live

const askFork = (input: PermissionV1.AskInput) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    return yield* svc.ask(input).pipe(Effect.exit, Effect.forkScoped)
  })

const reply = (requestID: PermissionV1.ID, payload: PermissionV1.ReplyInput["reply"], message?: string) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    return yield* svc.reply({ requestID, reply: payload, ...(message === undefined ? {} : { message }) })
  })

const listPending = Effect.gen(function* () {
  return yield* Permission.Service.use((svc) => svc.list())
})

async function createSession(directory: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const sessionID = SessionID.make(`ses_hitlp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`)
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
    [sessionID, directory, directory, "hitl-permission-test", "HITL permission test", "test", now, now],
  )
  return sessionID
}

async function dropProject(directory: string) {
  if (!fixtureDb) return
  await fixtureDb.unsafe("DELETE FROM project WHERE id = $1", [directory]).catch(() => {})
}

// Simulates another instance deciding directly in PG.
async function remoteReject(rid: string, message?: string) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  await fixtureDb.unsafe(`UPDATE hitl_request SET status = 'rejected', result = $2, time_updated = $3 WHERE id = $1`, [
    rid,
    { reply: "reject", ...(message === undefined ? {} : { message }) },
    Date.now(),
  ])
}

async function insertForeignPending(input: { id: string; directory: string; sessionID: string }) {
  if (!fixtureDb) throw new Error("local PostgreSQL is required")
  const now = Date.now()
  await fixtureDb.unsafe(
    `INSERT INTO hitl_request (
       id, kind, directory, session_id, owner_id, status, payload, lease_until, time_created, time_updated
     ) VALUES ($1, 'permission', $2, $3, 'owner-remote', 'pending', $4, $5, $6, $7)`,
    [input.id, input.directory, input.sessionID, {}, now + 60_000, now, now],
  )
}

interface HitlRowView {
  id: string
  status: string
  result: Record<string, unknown> | null
}

async function hitlRows(directory: string): Promise<HitlRowView[]> {
  const rows = (await db!
    .select()
    .from(HitlRequestTable)
    .where(eq(HitlRequestTable.directory, directory))
    .all()) as unknown as Array<{
    id: string
    status: string
    result: unknown
  }>
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    result:
      typeof row.result === "string"
        ? (JSON.parse(row.result) as Record<string, unknown>)
        : (row.result as Record<string, unknown> | null),
  }))
}

async function sessionPermission(sessionID: string) {
  const rows = (await db!
    .select({ permission: SessionTable.permission })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID as never))
    .limit(1)) as unknown as Array<{ permission: unknown }>
  const raw = rows[0]?.permission
  if (raw === null || raw === undefined) return undefined
  return typeof raw === "string" ? (JSON.parse(raw) as PermissionV1.Rule[]) : (raw as PermissionV1.Rule[])
}

const askInput = (sessionID: SessionID, patterns: string[], always: string[], id?: PermissionV1.ID) =>
  ({
    sessionID,
    permission: "bash",
    patterns,
    metadata: {},
    always,
    ruleset: [],
    ...(id === undefined ? {} : { id }),
  }) as PermissionV1.AskInput

// askFork forks ask.pipe(Effect.exit); awaiting the fiber yields Exit<Exit>.
const innerExit = (
  fiber: Fiber.Fiber<Exit.Exit<void, PermissionV1.Error>, never>,
): Effect.Effect<Exit.Exit<void, PermissionV1.Error>> =>
  Effect.gen(function* () {
    const outer = yield* Fiber.await(fiber)
    if (Exit.isFailure(outer)) return yield* Effect.die(Cause.squash(outer.cause))
    return outer.value
  })

const failure = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const exit = yield* self.pipe(Effect.exit)
    if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
    throw new Error("expected the effect to fail")
  })

describe.skipIf(!enabled)("permission HITL persistence (PG)", () => {
  beforeAll(async () => {
    await Database.initialize()
  })

  afterEach(async () => {
    await disposeAllInstances()
  })

  it("reply once resolves the deferred and records the PG result", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      const fiber = yield* askFork(askInput(sessionID, ["ls"], [])).pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const probe = yield* Fiber.await(fiber).pipe(
        Effect.timeoutOrElse({
          duration: "50 millis",
          orElse: () => Effect.succeed("still-running" as const),
        }),
      )
      const rid = (yield* listPending.pipe(provideInstance(dir)))[0]!.id

      yield* reply(rid, "once").pipe(provideInstance(dir))
      const inner = yield* innerExit(fiber)
      expect(Exit.isSuccess(inner)).toBe(true)

      const rows = yield* Effect.promise(() => hitlRows(dir))
      expect(rows[0]?.status).toBe("replied")
      expect(rows[0]?.result).toEqual({ reply: "once" })
    }))

  it("reply always persists session.permission and cascades same-session pendings", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      // Explicit ids pin the reply target — listPending order is not deterministic.
      const firstID = PermissionV1.ID.ascending()
      const first = yield* askFork(askInput(sessionID, ["ls"], ["ls"], firstID)).pipe(provideInstance(dir))
      // Same pattern as the always rule so the cascade evaluation covers it.
      const second = yield* askFork(askInput(sessionID, ["ls"], [])).pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const list = yield* listPending.pipe(provideInstance(dir))
      expect(list).toHaveLength(2)
      const rid = firstID

      yield* reply(rid, "always").pipe(provideInstance(dir))

      const innerFirst = yield* innerExit(first)
      expect(Exit.isSuccess(innerFirst)).toBe(true)
      const innerSecond = yield* innerExit(second)
      expect(Exit.isSuccess(innerSecond)).toBe(true)

      const rules = yield* Effect.promise(() => sessionPermission(sessionID as string))
      expect(rules).toEqual([{ permission: "bash", pattern: "ls", action: "allow" }])

      const rows = yield* Effect.promise(() => hitlRows(dir))
      const byId = new Map(rows.map((row) => [row.id, row]))
      expect(byId.get(rid as string)?.result).toEqual({ reply: "always" })
      const cascaded = rows.find((row) => row.id !== rid)
      expect(cascaded?.status).toBe("replied")
      expect(cascaded?.result?.["reply"]).toBe("always")
      expect(cascaded?.result?.["causedBy"]).toBe(rid)
    }))

  it("reply reject with message fails with CorrectedError and cascades plain rejections", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      // Explicit ids pin the reply target — listPending order is not deterministic.
      const firstID = PermissionV1.ID.ascending()
      const first = yield* askFork(askInput(sessionID, ["rm -rf /"], [], firstID)).pipe(provideInstance(dir))
      const second = yield* askFork(askInput(sessionID, ["rm -rf /tmp"], [])).pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const list = yield* listPending.pipe(provideInstance(dir))
      expect(list).toHaveLength(2)
      const rid = firstID

      yield* reply(rid, "reject", "use a safer command").pipe(provideInstance(dir))

      const innerFirst = yield* innerExit(first)
      if (!Exit.isFailure(innerFirst)) throw new Error("expected first ask to fail")
      const error = Cause.squash(innerFirst.cause)
      expect(error).toBeInstanceOf(PermissionV1.CorrectedError)
      if (error instanceof PermissionV1.CorrectedError) expect(error.feedback).toBe("use a safer command")

      // Cascaded rejections never copy the feedback message.
      const innerSecond = yield* innerExit(second)
      if (!Exit.isFailure(innerSecond)) throw new Error("expected second ask to fail")
      expect(Cause.squash(innerSecond.cause)).toBeInstanceOf(PermissionV1.RejectedError)

      const rows = yield* Effect.promise(() => hitlRows(dir))
      expect(rows.every((row) => row.status === "rejected")).toBe(true)
      const target = rows.find((row) => row.id === rid)
      expect(target?.result).toEqual({ reply: "reject", message: "use a safer command" })
      const cascaded = rows.find((row) => row.id !== rid)
      expect(cascaded?.result?.["message"]).toBeUndefined()
      expect(cascaded?.result?.["causedBy"]).toBe(rid)
    }))

  it("a remote rejection with feedback is consumed by the polling fiber as CorrectedError", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))

      const fiber = yield* askFork(askInput(sessionID, ["ls"], [])).pipe(provideInstance(dir))
      yield* Effect.sleep("150 millis").pipe(provideInstance(dir))
      const rid = (yield* listPending.pipe(provideInstance(dir)))[0]!.id as string

      yield* Effect.promise(() => remoteReject(rid, "ask again later"))

      const inner = yield* innerExit(fiber).pipe(
        Effect.timeoutOrElse({
          duration: "8 seconds",
          orElse: () => Effect.die(new Error("polling fiber never consumed the remote rejection")),
        }),
      )
      if (!Exit.isFailure(inner)) throw new Error("expected the ask to fail after remote rejection")
      const error = Cause.squash(inner.cause)
      expect(error).toBeInstanceOf(PermissionV1.CorrectedError)
      if (error instanceof PermissionV1.CorrectedError) expect(error.feedback).toBe("ask again later")
    }))

  it("the PG pending limit rejects asks even when this process holds nothing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dropProject(dir)))
      const sessionID = yield* Effect.promise(() => createSession(dir))
      for (let i = 0; i < 10; i++) {
        yield* Effect.promise(() =>
          insertForeignPending({ id: `prm_foreign_${Date.now()}_${i}`, directory: dir, sessionID }),
        )
      }

      const defect = yield* failure(
        Effect.gen(function* () {
          const svc = yield* Permission.Service
          return yield* svc.ask(askInput(sessionID, ["ls"], []))
        }).pipe(provideInstance(dir)),
      )
      expect(String(defect)).toContain("Too many pending permission requests")
      expect((yield* listPending.pipe(provideInstance(dir))).length).toBe(10)
    }))
})
