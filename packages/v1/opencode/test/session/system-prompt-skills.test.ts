import { describe, expect } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import { SkillResource } from "../../src/skill/resource"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import type { Agent } from "../../src/agent/agent"

const store = new Map<string, Map<string, Skill.Info>>()

function getStore(session: string) {
  if (!store.has(session)) store.set(session, new Map())
  return store.get(session)!
}

const mockSkillLayer = Layer.succeed(
  Skill.Service,
  Skill.Service.of({
    get: (name: string, session?: string) =>
      Effect.sync(() => {
        if (session) return getStore(session).get(name)
        return undefined
      }),
    require: ((name: string) => Effect.fail(new Error(`Skill not found: ${name}`))) as any,
    all: () => Effect.succeed([]),
    dirs: () => Effect.succeed([]),
    available: (_agent?: Agent.Info, session?: string) =>
      Effect.sync(() => {
        if (session) return [...getStore(session).values()]
        return []
      }),
    sessionList: (session: string) => Effect.succeed([...getStore(session).values()]),
    sessionCreate: (session: string, input: Skill.CreateInput) =>
      Effect.sync(() => {
        const info: Skill.Info = {
          name: input.name,
          description: input.description,
          location: `memory://${input.name}`,
          content: input.content,
          resources: input.resources?.map(SkillResource.make),
        }
        getStore(session).set(input.name, info)
        return info
      }),
    sessionLoad: () => Effect.succeed([]),
    sessionUnload: (session: string, name: string) =>
      Effect.sync(() => {
        getStore(session).delete(name)
      }),
    sessionClear: (session: string) =>
      Effect.sync(() => {
        store.delete(session)
      }),
  }),
)

const it = testEffect(Layer.mergeAll(AppNodeBuilder.build(SystemPrompt.node, [[Skill.node, mockSkillLayer]]), mockSkillLayer))

const AGENT: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: [],
  options: {},
}

const SESSION = "ses_test_prompt_001"

describe("SystemPrompt.skills", () => {
  it.effect("returns undefined when skill tool is disabled", () =>
    Effect.gen(function* () {
      const sys = yield* SystemPrompt.Service
      const agent: Agent.Info = {
        name: "build",
        mode: "primary",
        permission: [{ permission: "skill", pattern: "*", action: "deny" }],
        options: {},
      }
      const result = yield* sys.skills(agent)
      expect(result).toBeUndefined()
    }),
  )

  it.effect("returns available skills without preload", () =>
    Effect.gen(function* () {
      const sys = yield* SystemPrompt.Service
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "test-skill",
        description: "A test skill",
        content: "Do test things",
      })
      const result = yield* sys.skills(AGENT, undefined, SESSION)
      expect(result).toContain("test-skill")
      expect(result).toContain("Skills provide specialized instructions")
    }),
  )

  it.effect("generates preloaded_skills XML block", () =>
    Effect.gen(function* () {
      const sys = yield* SystemPrompt.Service
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "reviewer",
        description: "Code review expert",
        content: "Review code for quality",
      })
      const result = yield* sys.skills(AGENT, ["reviewer"], SESSION)
      expect(result).toContain("<preloaded_skills>")
      expect(result).toContain("</preloaded_skills>")
      expect(result).toContain("<name>reviewer</name>")
      expect(result).toContain("<description>Code review expert</description>")
      expect(result).toContain("<location>memory://reviewer</location>")
      expect(result).toContain("manifests only")
    }),
  )

  it.effect("includes resources in preloaded_skills XML", () =>
    Effect.gen(function* () {
      const sys = yield* SystemPrompt.Service
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "security",
        description: "Security audit",
        content: "Run security checks",
        resources: [
          { path: "refs/owasp.md", type: "doc", content: "OWASP Top 10 checklist" },
          { path: "tpl/safe.py", type: "template", content: "cursor.execute(q, params)" },
        ],
      })
      const result = yield* sys.skills(AGENT, ["security"], SESSION)
      expect(result).toContain("<resources>")
      expect(result).toContain("</resources>")
      expect(result).toContain('path="refs/owasp.md"')
      expect(result).toContain('type="doc"')
      expect(result).toContain('path="tpl/safe.py"')
      expect(result).toContain('type="template"')
    }),
  )

  it.effect("skips preload names that do not exist", () =>
    Effect.gen(function* () {
      const sys = yield* SystemPrompt.Service
      const result = yield* sys.skills(AGENT, ["nonexistent-skill"], SESSION)
      expect(result).toContain("<preloaded_skills>")
      expect(result).toContain("</preloaded_skills>")
      expect(result).not.toContain("<name>nonexistent-skill</name>")
    }),
  )

  it.effect("without session param, session skills not in available list", () =>
    Effect.gen(function* () {
      const sys = yield* SystemPrompt.Service
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "session-only",
        description: "Only in session",
        content: "session stuff",
      })
      const result = yield* sys.skills(AGENT, undefined, undefined)
      expect(result).not.toContain("session-only")
    }),
  )
})
