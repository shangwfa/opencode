import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import postgres from "postgres"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { Session } from "../../src/session/session"
import { SessionSkill } from "../../src/skill/session-skill"
import { Skill } from "../../src/skill"
import { Database } from "../../src/storage/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Project } from "../../src/project/project"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"

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

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Skill.defaultLayer,
    SessionSkill.layer,
  ),
)

describe.skipIf(!enabled)("PG Session.remove() session_skill cleanup", () => {
  beforeAll(async () => {
    await reset()
    await Database.close().catch(() => undefined)
    await Database.initialize()
  })

  afterAll(async () => {
    await Database.close().catch(() => undefined)
  })

  it.live("removing session cleans up all session skills via cascade", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const ssSvc = yield* SessionSkill.Service

        const session = yield* sessionSvc.create({ title: "multi-skill" })

        yield* skillSvc.sessionCreate(session.id, {
          name: "skill-a",
          description: "A",
          content: "A",
        })
        yield* skillSvc.sessionCreate(session.id, {
          name: "skill-b",
          description: "B",
          content: "B",
        })
        yield* skillSvc.sessionCreate(session.id, {
          name: "skill-c",
          description: "C",
          content: "C",
        })

        const before = yield* ssSvc.list(session.id)
        expect(before.length).toBe(3)

        yield* sessionSvc.remove(session.id)

        const after = yield* ssSvc.list(session.id)
        expect(after).toEqual([])
      }),
    ),
  )

  it.live("removing parent session cleans up parent and child session skills", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const ssSvc = yield* SessionSkill.Service

        const parent = yield* sessionSvc.create({ title: "parent" })
        const child = yield* sessionSvc.create({ parentID: parent.id, title: "child" })

        yield* skillSvc.sessionCreate(parent.id, {
          name: "parent-skill",
          description: "P",
          content: "P",
        })
        yield* skillSvc.sessionCreate(child.id, {
          name: "child-skill",
          description: "C",
          content: "C",
        })

        expect((yield* ssSvc.list(parent.id)).length).toBe(1)
        expect((yield* ssSvc.list(child.id)).length).toBe(1)

        yield* sessionSvc.remove(parent.id)

        expect(yield* ssSvc.list(parent.id)).toEqual([])
        expect(yield* ssSvc.list(child.id)).toEqual([])

        const exit = yield* Effect.exit(sessionSvc.get(parent.id))
        expect(Exit.isFailure(exit)).toBe(true)
        const childExit = yield* Effect.exit(sessionSvc.get(child.id))
        expect(Exit.isFailure(childExit)).toBe(true)
      }),
    ),
  )

  it.live("removing child does not affect parent session skills", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const ssSvc = yield* SessionSkill.Service

        const parent = yield* sessionSvc.create({ title: "parent-keep" })
        const child = yield* sessionSvc.create({ parentID: parent.id, title: "child-rm" })

        yield* skillSvc.sessionCreate(parent.id, {
          name: "parent-only",
          description: "P",
          content: "P",
        })
        yield* skillSvc.sessionCreate(child.id, {
          name: "child-only",
          description: "C",
          content: "C",
        })

        yield* sessionSvc.remove(child.id)

        expect(yield* ssSvc.list(child.id)).toEqual([])
        expect((yield* ssSvc.list(parent.id)).length).toBe(1)

        const parentRead = yield* sessionSvc.get(parent.id)
        expect(parentRead.id).toBe(parent.id)
      }),
    ),
  )

  it.live("can create skills for new session after old one removed", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const ssSvc = yield* SessionSkill.Service

        const s1 = yield* sessionSvc.create({ title: "first" })
        yield* skillSvc.sessionCreate(s1.id, {
          name: "first-skill",
          description: "F",
          content: "F",
        })

        yield* sessionSvc.remove(s1.id)
        expect(yield* ssSvc.list(s1.id)).toEqual([])

        const s2 = yield* sessionSvc.create({ title: "second" })
        yield* skillSvc.sessionCreate(s2.id, {
          name: "second-skill",
          description: "S",
          content: "S",
        })

        const list = yield* ssSvc.list(s2.id)
        expect(list.length).toBe(1)
        expect(list[0].name).toBe("second-skill")
      }),
    ),
  )

  it.live("sessionClear then remove leaves no orphan skills", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const ssSvc = yield* SessionSkill.Service

        const session = yield* sessionSvc.create({ title: "clear-then-rm" })
        yield* skillSvc.sessionCreate(session.id, {
          name: "clearable",
          description: "X",
          content: "X",
        })

        yield* skillSvc.sessionClear(session.id)
        expect(yield* ssSvc.list(session.id)).toEqual([])

        yield* sessionSvc.remove(session.id)

        expect(yield* ssSvc.list(session.id)).toEqual([])
      }),
    ),
  )
})
