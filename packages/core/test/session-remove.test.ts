import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, RcMap, Scope } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { KV } from "@opencode/core/kv"
import { Bus } from "@opencode/core/bus"
import { Instance } from "@opencode/core/instance/service"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionEnvironment } from "@opencode/core/session/environment"
import { LocationServiceMap } from "@opencode/core/location-services"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { SandboxProvider } from "../src/sandbox/provider"
import { SessionExecutionGateTable } from "../src/session/sql"
import { SessionToolGate } from "../src/session/tool-gate"
import { eq } from "drizzle-orm"

const closed: Session.ID[] = []
const transportScopes = new Set<Scope.Scope>()
let retainedSessionID: string | undefined
let retainedDatabase: Database.Interface["db"] | undefined
let purges = 0
let newerClosure: SessionToolGate.Closure | undefined
let closeAgain = false
let stopFailure: { sessionID: string; mode: "defect" | "interrupt" } | undefined
const execution = Layer.succeed(SessionExecution.Service, SessionExecution.Service.of({
  active: Effect.succeed(new Set()), isActive: () => Effect.succeed(false), resume: () => Effect.void, wake: () => Effect.void,
  interrupt: (sessionID) => stopFailure?.sessionID === sessionID
    ? stopFailure.mode === "defect" ? Effect.die(new Error("injected stop failure")) : Effect.interrupt
    : Effect.succeed(false),
  awaitIdle: () => Effect.void,
}))
const retainedProvider = Layer.effect(SandboxProvider.Service, Effect.gen(function* () {
  const unused = () => Effect.die(new Error("not under test"))
  return SandboxProvider.Service.of({
    get enabled() { return retainedSessionID !== undefined },
    run: unused, interrupt: () => Effect.void, keepAlive: () => Effect.void,
    activity: () => Effect.void, release: () => Effect.void,
    isKeepAlive: () => Effect.succeed(true), sandboxId: () => Effect.succeed(null), boot: unused,
    lifecycle: () => Effect.succeed({ sandboxID: "retained-source", state: "running", persistMode: "snapshot" }),
    destroy: () => Effect.gen(function* () {
      const rootID = retainedSessionID
      const db = retainedDatabase
      if (!rootID || !db) return yield* Effect.die(new Error("unexpected destroy"))
      const gates = yield* db.select().from(SessionExecutionGateTable).where(eq(SessionExecutionGateTable.root_session_id, rootID)).all()
      expect(gates).toHaveLength(3)
      expect(gates.every((gate) => gate.state === "closed")).toBe(true)
      if (closeAgain) newerClosure = yield* SessionToolGate.make(db).close(rootID, false).pipe(Effect.map((closure) => closure ?? undefined))
    }).pipe(Effect.orDie),
    deleteSnapshots: () => Effect.sync(() => { purges++ }), snapshot: unused,
    latestSnapshot: () => Effect.succeed(null),
    snapshotStats: () => Effect.succeed({ snapshots: {}, total: 0, restoredTotal: 0, operations: { destroy: { byState: {}, total: 0 }, refresh: { byState: {}, total: 0 } } }),
    fileStat: unused, fileRead: unused, fileReadBytes: unused, fileWrite: unused,
    fileDelete: unused, fileList: unused, fileFind: unused, isReady: () => Effect.succeed(false),
    endpoint: () => Effect.succeed({ _tag: "no-sandbox" }),
  })
}))
const transport = Layer.effect(
  SessionModelTransport.Service,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope
    transportScopes.add(scope)
    yield* Effect.addFinalizer(() => Effect.sync(() => transportScopes.delete(scope)))
    return SessionModelTransport.Service.of({
      bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
      close: (sessionID) => Effect.sync(() => closed.push(sessionID)),
      closeAll: Effect.void,
    })
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      KV.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionEnvironment.node,
      Session.node,
      Instance.node,
      LocationServiceMap.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(execution),
      SessionModelTransport.node.replace(transport),
      offlineModels,
      SandboxProvider.node.replace(retainedProvider),
    ],
  ),
)

describe("Session.remove", () => {
  for (const mode of ["defect", "interrupt"] as const) {
    it.effect(`a pre-cleanup ${mode} restores only its own logical admission`, () => Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }) })
      stopFailure = { sessionID: parent.id, mode }
      try {
        const removal = yield* sessions.remove(parent.id).pipe(Effect.forkChild)
        expect((yield* Fiber.await(removal))._tag).toBe("Failure")
        expect((yield* sessions.get(parent.id)).id).toBe(parent.id)
        expect((yield* db.select().from(SessionExecutionGateTable).where(eq(SessionExecutionGateTable.session_id, parent.id)).get())?.state).toBe("open")
      } finally {
        stopFailure = undefined
        yield* sessions.remove(parent.id)
      }
    }))
  }
  it.effect("a failed older DELETE cannot reopen a newer DELETE closure", () => Effect.gen(function* () {
    const temporary = yield* tmpdirScoped()
    const sessions = yield* Session.Service
    const { db } = yield* Database.Service
    retainedDatabase = db
    const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }) })
    const child = yield* sessions.create({ parentID: parent.id })
    const grandchild = yield* sessions.create({ parentID: child.id })
    retainedSessionID = parent.id
    closeAgain = true
    try {
      expect((yield* sessions.remove(parent.id).pipe(Effect.result))._tag).toBe("Failure")
      expect(newerClosure).toBeDefined()
      expect((yield* db.select().from(SessionExecutionGateTable).where(eq(SessionExecutionGateTable.session_id, parent.id)).get())?.state).toBe("closed")
      for (const info of [child, grandchild])
        expect((yield* db.select().from(SessionExecutionGateTable).where(eq(SessionExecutionGateTable.session_id, info.id)).get())?.state).toBe("open")
      expect((yield* sessions.get(parent.id)).id).toBe(parent.id)
    } finally {
      closeAgain = false
      retainedSessionID = undefined
      if (newerClosure) yield* SessionToolGate.make(db).reopen(parent.id, newerClosure)
      newerClosure = undefined
      yield* sessions.remove(parent.id)
      retainedDatabase = undefined
    }
  }))
  it.effect("retained source blocks metadata deletion after stopping all descendants", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const { db } = yield* Database.Service
      retainedDatabase = db
      const parent = yield* sessions.create({ location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }) })
      const child = yield* sessions.create({ parentID: parent.id })
      const grandchild = yield* sessions.create({ parentID: child.id })
      retainedSessionID = parent.id
      purges = 0
      try {
        const result = yield* sessions.remove(parent.id).pipe(Effect.result)
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure._tag).toBe("Session.SandboxRetainedError")
        for (const info of [parent, child, grandchild]) {
          expect((yield* sessions.get(info.id)).id).toBe(info.id)
          expect((yield* db.select().from(SessionExecutionGateTable).where(eq(SessionExecutionGateTable.session_id, info.id)).get())?.state).toBe("open")
        }
        expect(purges).toBe(0)
      } finally { retainedSessionID = undefined; yield* sessions.remove(parent.id); retainedDatabase = undefined }
    }),
  )
  it.effect("removes a session and its children", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(temporary.path) })
      const session = yield* Session.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ parentID: parent.id })
      yield* session.environment({ sessionID: parent.id, variables: { SESSION_ENV: "parent" } })
      yield* session.environment({ sessionID: child.id, variables: { SESSION_ENV: "child" } })
      const locations = yield* LocationServiceMap.Service
      yield* Effect.acquireRelease(locations.contextEffect(location), () => locations.invalidate(location))
      closed.length = 0

      const environments = yield* SessionEnvironment.Service
      const kv = yield* KV.Service
      yield* kv.set(`plugin/ccr/${parent.id}/parent-hash`, { original: "parent" })
      yield* kv.set(`plugin/ccr/${child.id}/child-hash`, { original: "child" })
      // Entries created before deletion must be removed with the session family.
      yield* session.remove(parent.id)
      expect((yield* session.list()).data).toEqual([])
      expect(closed).toEqual([parent.id, child.id])
      expect(yield* kv.get(`plugin/ccr/${parent.id}/parent-hash`)).toBeUndefined()
      expect(yield* kv.get(`plugin/ccr/${child.id}/child-hash`)).toBeUndefined()
      expect(yield* environments.get(parent.id)).toBeUndefined()
      expect(yield* environments.get(child.id)).toBeUndefined()
      expect(yield* Effect.result(session.get(parent.id))).toMatchObject({ _tag: "Failure" })
      expect(yield* Effect.result(session.get(child.id))).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.live("removes unloaded sessions and children without initializing an instance", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const sessions = yield* Session.Service
      const locations = yield* LocationServiceMap.Service
      const parent = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(temporary.path) }),
      })
      const child = yield* sessions.create({ parentID: parent.id })
      closed.length = 0
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])

      yield* sessions.remove(parent.id)

      expect(closed).toEqual([parent.id, child.id])
      expect(transportScopes.size).toBe(1)
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
      expect((yield* sessions.list()).data).toEqual([])
    }),
  )

  it.effect("fails when the session does not exist", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing")

      expect(yield* Effect.result(session.remove(sessionID))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "Session.NotFoundError", sessionID },
      })
    }),
  )
})
