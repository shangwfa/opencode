import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Skill } from "../../src/skill"
import { SkillResource } from "../../src/skill/resource"
import { materialize, sessionOutput } from "../../src/tool/skill"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"

describe("SkillResource", () => {
  test("normalizes stored resources and derives metadata", () => {
    const resource = SkillResource.fromStored({ path: "scripts/run.mjs", type: "script", content: "console.log('ok')" })

    expect(resource.size).toBe(Buffer.byteLength(resource.content))
    expect(resource.digest).toHaveLength(64)
    expect(SkillResource.metadata(resource)).not.toHaveProperty("content")
    expect(SkillResource.kind(resource.path)).toBe("script")
  })

  test("rejects binary resource content", () => {
    expect(SkillResource.isBinaryContent("\x00\x01binary")).toBe(true)
    expect(SkillResource.isBinaryContent("a,b\r\n1,2\n")).toBe(false)
    expect(() => SkillResource.make({ path: "scripts/run.pyc", type: "asset", content: "\x00\x01binary" })).toThrow(
      "Binary resource content is not supported",
    )
    expect(() => SkillResource.make({ path: "data/table.csv", type: "asset", content: "a,b\r\n1,2\n" })).not.toThrow()
  })

  test.each(["", "/absolute", "../escape", "refs/../escape", "refs\\escape.md", "refs//escape.md"])(
    "rejects invalid resource path %p",
    (resourcePath) => {
      expect(() => SkillResource.make({ path: resourcePath, type: "doc", content: "x" })).toThrow()
    },
  )

  test("snapshot is deterministic regardless of resource order", () => {
    const a = SkillResource.make({ path: "a.md", type: "doc", content: "a" })
    const b = SkillResource.make({ path: "b.md", type: "doc", content: "b" })

    expect(SkillResource.snapshot("body", [a, b])).toBe(SkillResource.snapshot("body", [b, a]))
  })

  test("directory prefers the database id over a digest of the name", () => {
    const a = SkillResource.make({ path: "a.md", type: "doc", content: "a" })
    const byId = SkillResource.directory("ses_x", "ssk_abc", "body", [a])
    const byName = SkillResource.directoryForName("ses_x", "skill-name", "body", [a])

    expect(byId).toContain("/ses_x/ssk_abc/")
    expect(byName).toContain("/ses_x/")
    expect(byName).not.toContain("/skill-name/")
    expect(byName).not.toContain("/ssk_abc/")
    expect(byId).not.toBe(byName)
  })

  test("rejects duplicate resource paths", () => {
    const resource = SkillResource.make({ path: "same.md", type: "doc", content: "x" })
    expect(() => SkillResource.validateBundle([resource, resource])).toThrow("duplicate resource paths")
  })

  test("public skill metadata omits stored resource content", () => {
    const resource = SkillResource.make({ path: "reference.md", type: "doc", content: "private resource body" })
    const info = Skill.publicInfo({
      name: "public-info",
      location: "session://ses_test/public-info",
      content: "Skill instructions",
      resources: [resource],
    })

    expect(info.resources?.[0]).not.toHaveProperty("content")
    expect(info.resources?.[0].digest).toBe(resource.digest)
  })

  test("rejects oversized resources with typed error", () => {
    const content = "x".repeat(SkillResource.MAX_SIZE + 1)
    expect(() => SkillResource.make({ path: "big.md", type: "doc", content })).toThrow(
      SkillResource.InvalidResourceError,
    )
  })

  test("rejects bundle over limit with typed error", () => {
    // Each resource stays within MAX_SIZE while the total exceeds MAX_BUNDLE_SIZE.
    const per = SkillResource.MAX_SIZE
    const count = Math.ceil(SkillResource.MAX_BUNDLE_SIZE / per) + 1
    const items = Array.from({ length: count }, (_, i) =>
      SkillResource.make({ path: `f${i}.md`, type: "doc", content: "x".repeat(per) }),
    )
    expect(() => SkillResource.validateBundle(items)).toThrow(SkillResource.InvalidResourceError)
  })

  test("rejects too many resources with typed error", () => {
    const items = Array.from({ length: SkillResource.MAX_COUNT + 1 }, (_, i) =>
      SkillResource.make({ path: `f${i}.md`, type: "doc", content: "x" }),
    )
    expect(() => SkillResource.validateBundle(items)).toThrow(SkillResource.InvalidResourceError)
  })

  test.each([
    "",
    "a".repeat(65),
    "../escape",
    "skill/slash",
    "skill with space",
    "skill<script>",
    "中文技能",
    "UpperCase",
    "-leading",
    "trailing-",
    "double--dash",
  ])("rejects invalid skill name %p", (name) => {
    expect(() => Skill.requireName(name)).toThrow(Skill.InvalidNameError)
  })

  test("accepts valid skill names", () => {
    expect(Skill.requireName("reviewer")).toBe("reviewer")
    expect(Skill.requireName("my-skill-1")).toBe("my-skill-1")
    expect(Skill.requireName("a")).toBe("a")
    expect(Skill.requireName("a".repeat(64))).toBe("a".repeat(64))
  })

  test("CreateInput schema rejects invalid names", () => {
    expect(() => Skill.CreateInput.make({ name: "UPPER", content: "x" })).toThrow()
    expect(() => Skill.CreateInput.make({ name: "a".repeat(65), content: "x" })).toThrow()
    expect(Skill.CreateInput.make({ name: "valid-name", content: "x" }).name).toBe("valid-name")
  })
})

describe("session skill materialization", () => {
  test("writes resources outside the user workspace", async () => {
    const writes: Array<{ path: string; data: string }> = []
    const directories: string[] = []
    const resource = SkillResource.make({
      path: "scripts/generate.mjs",
      type: "script",
      content: "console.log('generated')",
    })
    const ctx: Tool.Context = {
      sessionID: SessionID.make("ses_materialize"),
      messageID: MessageID.make("msg_materialize"),
      agent: "build",
      abort: AbortSignal.any([]),
      messages: [],
      sandbox: Promise.resolve({
        commands: {
          run: async () => ({ exitCode: 0 }),
        },
        files: {
          createDirectories: async (entries: Array<{ path: string }>) => {
            directories.push(...entries.map((entry) => entry.path))
          },
          writeFiles: async (files: Array<{ path: string; data: string }>) => {
            writes.push(...files)
          },
        },
      }),
      metadata: () => Effect.void,
      ask: () => Effect.void,
    }

    const dir = await Effect.runPromise(
      materialize(
        {
          name: "generator",
          description: "Generate files",
          location: "session://ses_materialize/generator",
          content: "Run the generator.",
          resources: [resource],
        },
        ctx,
      ),
    )

    expect(dir).toStartWith(`${SkillResource.SANDBOX_ROOT}/ses_materialize/`)
    expect(dir).not.toStartWith("/workspace/")
    expect(writes.map((item) => item.path)).toContain(`${dir}/SKILL.md`)
    expect(writes.map((item) => item.path)).toContain(`${dir}/resources.json`)
    expect(writes.map((item) => item.path)).toContain(`${dir}/scripts/generate.mjs`)
    expect(directories).toContain(`${dir}/scripts`)
    expect(writes.find((item) => item.path.endsWith("generate.mjs"))?.data).toBe(resource.content)

    const output = sessionOutput(
      {
        name: "generator",
        location: "session://ses_materialize/generator",
        content: "Run the generator.",
        resources: [resource],
      },
      dir,
    )
    expect(output).toContain(resource.path)
    expect(output).toContain(dir!)
    expect(output).not.toContain(resource.content)
  })
})
