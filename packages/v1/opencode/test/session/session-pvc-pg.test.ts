import { beforeAll, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "../../src/storage/db"
import { Session as SessionNs } from "@/session/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"

const DB_URL = process.env.OPENCODE_DATABASE_URL
const enabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe.skipIf(!enabled)("Session PVC mode (PostgreSQL)", () => {
  beforeAll(async () => {
    await Database.initialize()
  })

  it.instance("rejects app mode without appId (T38.4)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const exit = yield* session.create({ pvcMode: "app" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rejects app mode with blank appId (T38.5)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const exit = yield* session.create({ pvcMode: "app", appId: "   " }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("rejects path-traversal appId (T38.7)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      for (const appId of ["../../sessions/xxx", "apps/../sessions/xxx", "a/b", "a;b", "a rm -rf", "a$HOME"]) {
        const exit = yield* session.create({ pvcMode: "app", appId }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
      }
    }),
  )

  it.instance("rejects overlong appId (T38.8)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const exit = yield* session.create({ pvcMode: "app", appId: "a".repeat(129) }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.instance("accepts valid appId boundary chars (T38.9)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      for (const appId of ["my-app", "my_app", "my.app", "app-123", "A.B.C-1_2", "a"]) {
        const created = yield* Effect.acquireRelease(session.create({ pvcMode: "app", appId }), (info) =>
          session.remove(info.id).pipe(Effect.ignore),
        )
        expect(created.pvcMode).toBe("app")
        expect(created.appId).toBe(appId)
      }
    }),
  )

  it.instance("fork inherits pvcMode and appId (T38.19)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ pvcMode: "app", appId: "fork-app" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      expect(fork.pvcMode).toBe("app")
      expect(fork.appId).toBe("fork-app")
      expect(fork.parentID).toBe(created.id)
    }),
  )

  it.instance("child session inherits pvcMode and appId via parentID (T38.20)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const parent = yield* Effect.acquireRelease(session.create({ pvcMode: "app", appId: "task-app" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const child = yield* Effect.acquireRelease(session.create({ parentID: parent.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      expect(child.pvcMode).toBe("app")
      expect(child.appId).toBe("task-app")
      expect(child.parentID).toBe(parent.id)
    }),
  )

  it.instance("session mode stays clean of app fields (T38.21)", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ pvcMode: "session" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      expect(created.pvcMode).toBe("session")
      expect(created.appId).toBeUndefined()
      expect(fork.pvcMode).toBeUndefined()
      expect(fork.appId).toBeUndefined()
    }),
  )
})
