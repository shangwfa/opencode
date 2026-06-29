import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import postgres from "postgres"
import path from "path"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { Session } from "../../src/session/session"
import { SessionSkill } from "../../src/skill/session-skill"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { Database } from "../../src/storage/db"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "../../src/config/config"
import { Agent } from "../../src/agent/agent"
import { Project } from "../../src/project/project"
import { Truncate } from "../../src/tool/truncate"
import { ToolRegistry } from "../../src/tool/registry"
import { Permission } from "../../src/permission"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent as AgentType } from "../../src/agent/agent"

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

const mockAgent: AgentType.Info = {
  name: "test",
  mode: "primary",
  permission: [] as PermissionV1.Ruleset,
} as AgentType.Info

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
    SystemPrompt.defaultLayer,
  ),
)

describe.skipIf(!enabled)("PG system prompt preload session skill", () => {
  beforeAll(async () => {
    await reset()
    await Database.close().catch(() => undefined)
    await Database.initialize()
  })

  afterAll(async () => {
    await Database.close().catch(() => undefined)
  })

  it.live("preload session skill manifest from PG DB", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const sys = yield* SystemPrompt.Service

        const session = yield* sessionSvc.create({ title: "preload pg" })

        yield* skillSvc.sessionCreate(session.id, {
          name: "pg-preload-skill",
          description: "PG preload skill",
          content: "# PG Preload\n\nContent from PG session skill.",
          resources: [
            { path: "references/checklist.md", type: "doc", content: "PG resource doc" },
            { path: "templates/run.sh", type: "template", content: "echo resource" },
          ],
        })

        const result = yield* sys.skills(mockAgent, ["pg-preload-skill"], session.id)

        expect(result).toBeDefined()
        expect(result).toContain("<preloaded_skills>")
        expect(result).toContain("<name>pg-preload-skill</name>")
        expect(result).toContain('<resource path="references/checklist.md" type="doc"')
        expect(result).toContain('<resource path="templates/run.sh" type="template"')
        expect(result).not.toContain("Content from PG session skill.")
        expect(result).not.toContain("PG resource doc")
        expect(result).not.toContain("echo resource")
        expect(result).toContain("<available_skills>")
        expect(result).toContain("pg-preload-skill")
      }),
    ),
  )

  it.live("session skill shadows global skill in preload", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const sys = yield* SystemPrompt.Service

        yield* skillSvc.create({
          name: "shared",
          description: "Global version",
          content: "Global content",
        })

        const session = yield* sessionSvc.create({ title: "shadow" })
        yield* skillSvc.sessionCreate(session.id, {
          name: "shared",
          description: "Session version",
          content: "Session content",
        })

        const result = yield* sys.skills(mockAgent, ["shared"], session.id)

        expect(result).toContain("Session version")
        expect(result).not.toContain("Global content")
      }),
    ),
  )

  it.live("available skills list includes PG session skills", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const sys = yield* SystemPrompt.Service

        const session = yield* sessionSvc.create({ title: "available" })
        yield* skillSvc.sessionCreate(session.id, {
          name: "pg-listed-skill",
          description: "Listed via PG",
          content: "Listed content",
        })

        const result = yield* sys.skills(mockAgent, undefined, session.id)

        expect(result).toBeDefined()
        expect(result).toContain("pg-listed-skill")
        expect(result).toContain("Listed via PG")
      }),
    ),
  )

  it.live("preload non-existent session skill skips gracefully", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const sys = yield* SystemPrompt.Service

        const session = yield* sessionSvc.create({ title: "missing preload" })

        const result = yield* sys.skills(mockAgent, ["no-such-skill"], session.id)

        expect(result).toBeDefined()
        expect(result).not.toContain('<skill_content name="no-such-skill">')
      }),
    ),
  )

  it.live("sessions are isolated in preload", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const sys = yield* SystemPrompt.Service

        const s1 = yield* sessionSvc.create({ title: "iso-1" })
        const s2 = yield* sessionSvc.create({ title: "iso-2" })

        yield* skillSvc.sessionCreate(s1.id, {
          name: "s1-only",
          description: "S1",
          content: "S1 content",
        })
        yield* skillSvc.sessionCreate(s2.id, {
          name: "s2-only",
          description: "S2",
          content: "S2 content",
        })

        const r1 = yield* sys.skills(mockAgent, ["s1-only", "s2-only"], s1.id)
        expect(r1).toContain("<name>s1-only</name>")
        expect(r1).not.toContain("<name>s2-only</name>")

        const r2 = yield* sys.skills(mockAgent, ["s1-only", "s2-only"], s2.id)
        expect(r2).not.toContain("<name>s1-only</name>")
        expect(r2).toContain("<name>s2-only</name>")
      }),
    ),
  )

  it.live("sessionLoad imports bundle resources from directory", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessionSvc = yield* Session.Service
        const skillSvc = yield* Skill.Service
        const sys = yield* SystemPrompt.Service

        yield* Effect.promise(() =>
          Promise.all([
            Bun.$`mkdir -p ${path.join(dir, "skills", "bundle", "references")}`,
            Bun.$`mkdir -p ${path.join(dir, "skills", "bundle", "templates")}`,
          ]),
        )
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(
              path.join(dir, "skills", "bundle", "SKILL.md"),
              `---
name: pg-bundle-skill
description: PG bundle skill
---

# PG Bundle

Main bundle content.
`,
            ),
            Bun.write(path.join(dir, "skills", "bundle", "references", "guide.md"), "Bundle guide"),
            Bun.write(path.join(dir, "skills", "bundle", "templates", "run.sh"), "echo bundle"),
          ]),
        )

        const session = yield* sessionSvc.create({ title: "bundle load" })
        const loaded = yield* skillSvc.sessionLoad(session.id, path.join(dir, "skills"))

        expect(loaded.length).toBe(1)
        expect(loaded[0].resources.map((item) => item.path)).toEqual([
          "references/guide.md",
          "templates/run.sh",
        ])

        const result = yield* sys.skills(mockAgent, ["pg-bundle-skill"], session.id)
        expect(result).toContain("<name>pg-bundle-skill</name>")
        expect(result).toContain('<resource path="references/guide.md" type="doc"')
        expect(result).toContain('<resource path="templates/run.sh" type="template"')
        expect(result).not.toContain("Main bundle content.")
        expect(result).not.toContain("Bundle guide")
        expect(result).not.toContain("echo bundle")
      }),
    ),
  )
})
