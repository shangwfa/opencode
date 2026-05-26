/**
 * End-to-end business logic tests for PG mode.
 *
 * Validates the complete business layer (Project, Session, Message) actually
 * works against a real PG backend. Exercises the full stack:
 * Database.use → SyncEvent.run → Projectors → PG queries.
 *
 * Requires OPENCODE_DATABASE_URL. Auto-skips otherwise.
 *
 * Run with:
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *     bun test test/storage/pg-business.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import postgres from "postgres"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Project } from "../../src/project/project"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { Database } from "../../src/storage/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const url = process.env["OPENCODE_DATABASE_URL"]
const enabled = !!url && Database.dialect === "pg"

async function reset() {
  const client = postgres(url!)
  try {
    await client.unsafe(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `)
  } finally {
    await client.end()
  }
}

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
  ),
)

describe.skipIf(!enabled)("PG business logic e2e", () => {
  beforeAll(async () => {
    await reset()
    await Database.close().catch(() => undefined)
    await Database.initialize()
  })

  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  afterAll(async () => {
    await Database.close().catch(() => undefined)
  })

  it.live("creates a session and reads it back", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "PG Test Session" })

        expect(session.id).toBeDefined()
        expect(session.title).toBe("PG Test Session")
        expect(session.directory).toBe(dir)

        const read = yield* svc.get(session.id)
        expect(read.id).toBe(session.id)
        expect(read.title).toBe("PG Test Session")
      }),
    ),
  )

  it.live("updates session title via SyncEvent + projector", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "Original" })

        yield* svc.setTitle({ sessionID: session.id, title: "Updated" })

        const read = yield* svc.get(session.id)
        expect(read.title).toBe("Updated")
      }),
    ),
  )

  it.live("stores and retrieves messages with parts (jsonb)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "Msg Test" })

        const user = yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        expect(user.role).toBe("user")

        const assistant: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          cost: 0.00125,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        }
        yield* svc.updateMessage(assistant)

        const msgs = yield* svc.messages({ sessionID: session.id })
        expect(msgs).toHaveLength(2)

        const asst = msgs.find((m) => m.info.role === "assistant")
        expect(asst).toBeDefined()
        const asstInfo = asst!.info as MessageV2.Assistant
        expect(asstInfo.cost).toBe(0.00125)
        expect(asstInfo.tokens.input).toBe(100)
        expect(asstInfo.path.cwd).toBe("/tmp")
      }),
    ),
  )

  it.live("CASCADE delete: removing session removes its messages", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "Cascade Test" })

        yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })

        const before = yield* svc.messages({ sessionID: session.id })
        expect(before.length).toBeGreaterThan(0)

        yield* svc.remove(session.id)

        const exit = yield* Effect.exit(svc.get(session.id))
        expect(Exit.isFailure(exit)).toBe(true)

        // Querying messages for a deleted session surfaces NotFoundError
        const msgExit = yield* Effect.exit(svc.messages({ sessionID: session.id }))
        expect(Exit.isFailure(msgExit)).toBe(true)
      }),
    ),
  )

  it.live("parent-child session relationships", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const parent = yield* svc.create({ title: "Parent" })
        const c1 = yield* svc.create({ parentID: parent.id, title: "Child 1" })
        const c2 = yield* svc.create({ parentID: parent.id, title: "Child 2" })

        const kids = yield* svc.children(parent.id)
        expect(kids).toHaveLength(2)
        const titles = kids.map((k) => k.title).sort()
        expect(titles).toEqual(["Child 1", "Child 2"])

        yield* svc.remove(parent.id)
        const e1 = yield* Effect.exit(svc.get(c1.id))
        const e2 = yield* Effect.exit(svc.get(c2.id))
        expect(Exit.isFailure(e1)).toBe(true)
        expect(Exit.isFailure(e2)).toBe(true)
      }),
    ),
  )

  it.live("Project.get works against PG", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Project.Service
          const { project } = yield* svc.fromDirectory(dir)
          expect(project.id).toBeDefined()

          const fetched = yield* Effect.promise(() => Project.get(project.id))
          expect(fetched).toBeDefined()
          expect(fetched!.id).toBe(project.id)
          expect(fetched!.worktree).toBe(dir)
        }),
      { git: true },
    ),
  )

  it.live("Project.list returns all projects", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* Project.Service
          yield* svc.fromDirectory(dir)

          const all = yield* Effect.promise(() => Project.list())
          expect(all.length).toBeGreaterThan(0)
          expect(all.some((p: any) => p.worktree === dir)).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live("setArchived persists correctly", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "Archive Test" })

        const archiveTime = Date.now()
        yield* svc.setArchived({ sessionID: session.id, time: archiveTime })

        const read = yield* svc.get(session.id)
        expect(read.time.archived).toBe(archiveTime)
      }),
    ),
  )

  it.live("setPermission persists ruleset array", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "Perm Test" })

        const ruleset = [
          { permission: "edit", pattern: "**/*.ts", action: "allow" as const },
          { permission: "bash", pattern: "*", action: "ask" as const },
        ]

        yield* svc.setPermission({
          sessionID: session.id,
          permission: ruleset as any,
        })

        const read = yield* svc.get(session.id)
        expect(read.permission).toHaveLength(2)
        expect(read.permission![0].permission).toBe("edit")
        expect(read.permission![0].action).toBe("allow")
        expect(read.permission![1].permission).toBe("bash")
      }),
    ),
  )

  it.live("multiple sessions in same project are isolated", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const s1 = yield* svc.create({ title: "Session 1" })
        const s2 = yield* svc.create({ title: "Session 2" })
        const s3 = yield* svc.create({ title: "Session 3" })

        yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: s1.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })

        const s1msgs = yield* svc.messages({ sessionID: s1.id })
        const s2msgs = yield* svc.messages({ sessionID: s2.id })
        const s3msgs = yield* svc.messages({ sessionID: s3.id })

        expect(s1msgs).toHaveLength(1)
        expect(s2msgs).toHaveLength(0)
        expect(s3msgs).toHaveLength(0)

        yield* svc.remove(s1.id)
        const s2read = yield* svc.get(s2.id)
        const s3read = yield* svc.get(s3.id)
        expect(s2read.title).toBe("Session 2")
        expect(s3read.title).toBe("Session 3")
      }),
    ),
  )

  it.live("large jsonb payload round-trips correctly", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Session.Service
        const session = yield* svc.create({ title: "Large JSON" })

        const largeText = "x".repeat(10_000)
        const parentMsg = yield* svc.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        const msg: MessageV2.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: parentMsg.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          cost: 0,
          path: { cwd: largeText.slice(0, 100), root: "/" },
          tokens: { input: 1_000_000, output: 1_000_000, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now() },
        }

        yield* svc.updateMessage(msg)

        const msgs = yield* svc.messages({ sessionID: session.id })
        const asst = msgs.find((m) => m.info.role === "assistant")
        expect(asst).toBeDefined()
        const info = asst!.info as MessageV2.Assistant
        expect(info.tokens.input).toBe(1_000_000)
        expect(info.path.cwd).toHaveLength(100)
      }),
    ),
  )
})
