import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { LoadDotOpencode } from "@/config/load-dot-opencode"
import { SessionAgentsMd } from "@/session/agents-md"
import { SessionAgent } from "@/agent/session-agent"
import { SessionSkill } from "@/skill/session-skill"
import { SessionMcp } from "@/mcp/session-mcp"
import { SessionTool } from "@/tool/session-tool"
import { SessionCommand } from "@/command/session-command"
import { SessionPlugin } from "@/plugin/session-plugin"
import { SessionID } from "@/session/schema"

const testLayer = Layer.mergeAll(
  LoadDotOpencode.layer,
  SessionAgentsMd.noopLayer,
  SessionAgent.noopLayer,
  SessionSkill.noopLayer,
  SessionMcp.noopLayer,
  SessionTool.noopLayer,
  SessionCommand.noopLayer,
  SessionPlugin.noopLayer,
)

const SID = SessionID.make("sess_test")

async function mkDotDir(dir: string) {
  const dot = path.join(dir, ".opencode")
  await fs.mkdir(dot, { recursive: true })
  return dot
}

async function writeFile(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, "utf-8")
}

function runLoad(dir: string) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* LoadDotOpencode.Service
      return yield* svc.load(SID, dir)
    }).pipe(Effect.provide(testLayer)),
  )
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ldo-"))
  await fn(dir)
  await fs.rm(dir, { recursive: true, force: true })
}

describe("LoadDotOpencode", () => {
  test("returns empty when .opencode is missing", async () => {
    await withDir(async (dir) => {
      const result = await runLoad(dir)
      expect(result.loaded).toEqual([])
      expect(result.skipped).toEqual([])
    })
  })

  test("returns empty for empty .opencode directory", async () => {
    await withDir(async (dir) => {
      await mkDotDir(dir)
      const result = await runLoad(dir)
      expect(result.loaded).toEqual([])
      expect(result.skipped).toEqual([])
    })
  })

  test("loads AGENTS.md", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "AGENTS.md"), "# Project rules\nBe careful.")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("AGENTS.md")
    })
  })

  test("loads agents from markdown", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "agents/reviewer.md"),
        "---\ndescription: Review code\nmode: subagent\n---\nReview the code carefully.",
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("agents/reviewer")
    })
  })

  test("skips internal agent names", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "agents/compaction.md"),
        "---\ndescription: compaction\n---\nDo compaction.",
      )
      const result = await runLoad(dir)
      expect(result.loaded).not.toContain("agents/compaction")
      expect(result.skipped.some((s) => s.path === "agents/compaction")).toBe(true)
    })
  })

  test("skips disabled agents", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "agents/disabled.md"),
        "---\ndisable: true\n---\nShould not load.",
      )
      const result = await runLoad(dir)
      expect(result.loaded).not.toContain("agents/disabled")
      expect(result.skipped.some((s) => s.path === "agents/disabled")).toBe(true)
    })
  })

  test("loads skills with resources", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "skills/my-skill/SKILL.md"),
        "---\nname: my-skill\ndescription: A test skill\n---\nThis is a test skill.",
      )
      await writeFile(path.join(dot, "skills/my-skill/references/guide.md"), "# Guide\nContent")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("skills/my-skill")
    })
  })

  test("loads MCP from opencode.json", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "opencode.json"),
        JSON.stringify({
          mcp: {
            github: { type: "remote", url: "https://example.com/mcp" },
            local: { type: "local", command: ["bun", "run", "mcp.ts"] },
          },
        }),
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("mcp/github")
      expect(result.loaded).toContain("mcp/local")
    })
  })

  test("writes parsed Agent and MCP inputs to Session services", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "agents/reviewer.md"),
        "---\ndescription: Review code\nmode: subagent\nmodel: openai/gpt-4.1\n---\nReview the code.",
      )
      await writeFile(
        path.join(dot, "opencode.json"),
        JSON.stringify({ mcp: { github: { type: "remote", url: "https://example.com/mcp", enabled: false } } }),
      )

      let agentInput: SessionAgent.Input | undefined
      let mcpInput: SessionMcp.Input | undefined
      const captureLayer = Layer.mergeAll(
        LoadDotOpencode.layer,
        SessionAgentsMd.noopLayer,
        Layer.mock(SessionAgent.Service, {
          upsert: (_sessionID, input) =>
            Effect.sync(() => {
              agentInput = input
              return {} as SessionAgent.Row
            }),
        }),
        SessionSkill.noopLayer,
        Layer.mock(SessionMcp.Service, {
          upsert: (_sessionID, input) =>
            Effect.sync(() => {
              mcpInput = input
              return {} as SessionMcp.Row
            }),
        }),
        SessionTool.noopLayer,
        SessionCommand.noopLayer,
        SessionPlugin.noopLayer,
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* LoadDotOpencode.Service
          return yield* svc.load(SID, dir)
        }).pipe(Effect.provide(captureLayer)),
      )

      expect(result.loaded).toContain("agents/reviewer")
      expect(result.loaded).toContain("mcp/github")
      expect(agentInput?.name).toBe("reviewer")
      expect(agentInput?.model).toEqual({ providerID: "openai", modelID: "gpt-4.1" })
      expect(mcpInput).toEqual({
        name: "github",
        type: "remote",
        url: "https://example.com/mcp",
        headers: undefined,
        enabled: false,
      })
    })
  })

  test("skips invalid MCP entries", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "opencode.json"),
        JSON.stringify({ mcp: { bad: { enabled: false } } }),
      )
      const result = await runLoad(dir)
      expect(result.loaded).not.toContain("mcp/bad")
      expect(result.skipped.some((s) => s.path === "opencode.json:mcp.bad")).toBe(true)
    })
  })

  test("loads tools", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "tool/format.ts"),
        "export default {\n  description: 'Format files',\n  args: {},\n  async execute() {\n    return 'formatted'\n  },\n}",
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("tool/format")
    })
  })

  test("loads commands", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "commands/review.md"),
        "---\ndescription: Review changes\nagent: build\n---\nReview the changes.",
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("commands/review")
    })
  })

  test("loads plugins", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "plugins/audit.ts"), "export default { name: 'audit' }")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("plugins/audit")
    })
  })

  test("loads all resource types together", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "AGENTS.md"), "# Rules")
      await writeFile(path.join(dot, "agents/a.md"), "---\n---\nPrompt A")
      await writeFile(path.join(dot, "skills/s/SKILL.md"), "---\nname: s\n---\nSkill S")
      await writeFile(path.join(dot, "opencode.json"), JSON.stringify({ mcp: { m: { type: "remote", url: "https://x" } } }))
      await writeFile(path.join(dot, "tool/t.ts"), "export default {}")
      await writeFile(path.join(dot, "commands/c.md"), "---\n---\nCommand C")
      await writeFile(path.join(dot, "plugins/p.ts"), "export default {}")
      const result = await runLoad(dir)
      expect(result.loaded).toHaveLength(7)
    })
  })

  test("is idempotent on repeated load", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "AGENTS.md"), "# Rules")
      await writeFile(path.join(dot, "agents/a.md"), "---\n---\nPrompt A")
      const first = await runLoad(dir)
      const second = await runLoad(dir)
      expect(second.loaded).toEqual(first.loaded)
      expect(second.skipped).toEqual(first.skipped)
    })
  })
})
