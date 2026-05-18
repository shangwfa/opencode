import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Effect, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import type { Permission } from "../../src/permission"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "../../src/tool/registry"
import { provideTmpdirInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"
import { Skill } from "../../src/skill"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  sandbox: null,
}

afterEach(async () => {
  await Instance.disposeAll()
})

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(ToolRegistry.defaultLayer, Skill.defaultLayer, node))

describe("tool.skill", () => {
  it.live("description lists skill location URL", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".opencode", "skill", "tool-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill
`,
            ),
          )
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )
          const registry = yield* ToolRegistry.Service
          const desc =
            (yield* registry.tools({
              providerID: "opencode" as any,
              modelID: "gpt-5" as any,
              agent: { name: "build", mode: "primary", permission: [], options: {} },
            })).find((tool) => tool.id === SkillTool.id)?.description ?? ""
          expect(desc).toContain("**tool-skill**: Skill for tool tests.")
        }),
      { git: true },
    ),
  )

  it.live("description sorts skills by name and is stable across calls", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          for (const [name, description] of [
            ["zeta-skill", "Zeta skill."],
            ["alpha-skill", "Alpha skill."],
            ["middle-skill", "Middle skill."],
          ]) {
            const skill = path.join(dir, ".opencode", "skill", name)
            yield* Effect.promise(() =>
              Bun.write(
                path.join(skill, "SKILL.md"),
                `---
name: ${name}
description: ${description}
---

# ${name}
`,
              ),
            )
          }
          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )

          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const registry = yield* ToolRegistry.Service
          const load = Effect.fnUntraced(function* () {
            return (
              (yield* registry.tools({
                providerID: "opencode" as any,
                modelID: "gpt-5" as any,
                agent,
              })).find((tool) => tool.id === SkillTool.id)?.description ?? ""
            )
          })
          const first = yield* load()
          const second = yield* load()

          expect(first).toBe(second)

          const alpha = first.indexOf("**alpha-skill**: Alpha skill.")
          const middle = first.indexOf("**middle-skill**: Middle skill.")
          const zeta = first.indexOf("**zeta-skill**: Zeta skill.")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        }),
      { git: true },
    ),
  )

  it.live("execute returns skill content block with files", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = path.join(dir, ".opencode", "skill", "tool-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skill, "SKILL.md"),
              `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
            ),
          )
          yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))

          const home = process.env.OPENCODE_TEST_HOME
          process.env.OPENCODE_TEST_HOME = dir
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              process.env.OPENCODE_TEST_HOME = home
            }),
          )

          const registry = yield* ToolRegistry.Service
          const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
          const tool = (yield* registry.tools({
            providerID: "opencode" as any,
            modelID: "gpt-5" as any,
            agent,
          })).find((tool) => tool.id === SkillTool.id)
          if (!tool) throw new Error("Skill tool not found")

          const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
          const ctx: Tool.Context = {
            ...baseCtx,
            ask: (req) =>
              Effect.sync(() => {
                requests.push(req)
              }),
          }

          const result = yield* tool.execute({ name: "tool-skill" }, ctx)
          const file = path.resolve(skill, "scripts", "demo.txt")

          expect(requests.length).toBe(1)
          expect(requests[0].permission).toBe("skill")
          expect(requests[0].patterns).toContain("tool-skill")
          expect(requests[0].always).toContain("tool-skill")
          expect(result.metadata.dir).toBe(skill)
          expect(result.output).toContain(`<skill_content name="tool-skill">`)
          expect(result.output).toContain(`Base directory for this skill: ${pathToFileURL(skill).href}`)
          expect(result.output).toContain(`<file>${file}</file>`)
        }),
      { git: true },
    ),
  )

  it.live("load fills resources for file-based skill", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "custom-skills", "file-bundle")
          yield* Effect.promise(() =>
            Promise.all([
              Bun.write(
                path.join(skillDir, "SKILL.md"),
                `---
name: file-bundle
description: File-based bundle skill.
---

# File Bundle

Use bundled resources.
`,
              ),
              Bun.write(path.join(skillDir, "references", "guide.md"), "FILE_GUIDE_CONTENT"),
              Bun.write(path.join(skillDir, "templates", "run.sh"), "FILE_SCRIPT_CONTENT"),
            ]),
          )

          const skills = yield* Skill.Service
          yield* skills.load(skillDir)

          const info = yield* skills.get("file-bundle")
          expect(info).toBeDefined()
          expect(info!.resources.map((r) => r.path)).toEqual(["references/guide.md", "templates/run.sh"])
          expect(info!.resources[0].content).toBe("FILE_GUIDE_CONTENT")
          expect(info!.resources[1].content).toBe("FILE_SCRIPT_CONTENT")
        }),
      { git: true },
    ),
  )

  it.live("execute loads session skill manifest before resource content", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const skills = yield* Skill.Service
        const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
        const tool = (yield* registry.tools({
          providerID: "opencode" as any,
          modelID: "gpt-5" as any,
          agent,
        })).find((tool) => tool.id === SkillTool.id)
        if (!tool) throw new Error("Skill tool not found")

        yield* skills.sessionCreate(baseCtx.sessionID, {
          name: "session-bundle",
          description: "Session bundle skill.",
          content: "# Session Bundle\n\nUse this bundle.",
          resources: [
            { path: "references/guide.md", type: "doc", content: "Guide content" },
            { path: "templates/run.sh", type: "template", content: "echo run" },
          ],
        })

        const ctx: Tool.Context = {
          ...baseCtx,
          ask: () => Effect.void,
        }

        const manifest = yield* tool.execute({ name: "session-bundle" }, ctx)
        expect(manifest.output).toContain('<skill_content name="session-bundle">')
        expect(manifest.output).toContain("Use this bundle.")
        expect(manifest.output).toContain('<resource path="references/guide.md" type="doc" size=')
        expect(manifest.output).toContain('<resource path="templates/run.sh" type="template" size=')
        expect(manifest.output).not.toContain("Guide content")
        expect(manifest.output).not.toContain("echo run")

        const loaded = yield* tool.execute({ name: "session-bundle", resources: ["references/guide.md"] }, ctx)
        expect(loaded.output).toContain('<resource path="references/guide.md" type="doc">')
        expect(loaded.output).toContain("Guide content")
        expect(loaded.output).not.toContain("echo run")
      }),
      { git: true },
    ),
  )
})
