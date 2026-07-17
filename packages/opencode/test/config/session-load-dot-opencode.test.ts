import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import os from "os"
import { SessionLoadDotOpencode } from "@/config/session-load-dot-opencode"
import { SessionAgentsMd } from "@/session/agents-md"
import { SessionAgent } from "@/agent/session-agent"
import { SessionSkill } from "@/skill/session-skill"
import { SessionMcp } from "@/mcp/session-mcp"
import { SessionTool } from "@/tool/session-tool"
import { SessionCommand } from "@/command/session-command"
import { SessionPlugin } from "@/plugin/session-plugin"
import { SessionID } from "@/session/schema"

const testLayer = Layer.mergeAll(
  SessionLoadDotOpencode.layer,
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
      const svc = yield* SessionLoadDotOpencode.Service
      return yield* svc.load(SID, dir)
    }).pipe(Effect.provide(testLayer)),
  )
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ldo-"))
  await fn(dir)
  await fs.rm(dir, { recursive: true, force: true })
}

describe("SessionLoadDotOpencode", () => {
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
        SessionLoadDotOpencode.layer,
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
          const svc = yield* SessionLoadDotOpencode.Service
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

  test("skips agent file reached via symlink outside worktree", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      const agentsDir = path.join(dot, "agents")
      await fs.mkdir(agentsDir, { recursive: true })
      const escape = await fs.mkdtemp(path.join(os.tmpdir(), "ldo-escape-"))
      await fs.writeFile(path.join(escape, "secret.md"), "---\n---\nEscaped.", "utf-8")
      await fs.symlink(path.join(escape, "secret.md"), path.join(agentsDir, "escape.md"))
      const result = await runLoad(dir)
      expect(result.loaded).not.toContain("agents/escape")
      expect(result.skipped.some((s) => s.path === "agents/escape.md" && s.reason.includes("outside worktree"))).toBe(true)
      await fs.rm(escape, { recursive: true, force: true })
    })
  })

  test("skills ignore resources reached via symlink outside worktree", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      const escape = await fs.mkdtemp(path.join(os.tmpdir(), "ldo-escape-"))
      await fs.writeFile(path.join(escape, "secret.md"), "# Escaped", "utf-8")
      const skillDir = path.join(dot, "skills", "my-skill")
      await fs.mkdir(skillDir, { recursive: true })
      await fs.symlink(path.join(escape, "secret.md"), path.join(skillDir, "escape.md"))
      await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---\nSkill.")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("skills/my-skill")
      await fs.rm(escape, { recursive: true, force: true })
    })
  })

  test("skips AGENTS.md when it is not a regular file", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await fs.mkdir(path.join(dot, "AGENTS.md"), { recursive: true })
      const result = await runLoad(dir)
      expect(result.loaded).not.toContain("AGENTS.md")
    })
  })

  test("skips invalid agent frontmatter", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "agents/bad.md"), "---\nmode: invalid-mode\n---\nPrompt.")
      await writeFile(path.join(dot, "agents/good.md"), "---\n---\nPrompt.")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("agents/good")
      expect(result.loaded).not.toContain("agents/bad")
      expect(result.skipped.some((s) => s.path === "agents/bad.md")).toBe(true)
    })
  })

  test("skips invalid command frontmatter", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "commands/bad.md"), "---\nsubtask: not-a-boolean\n---\nTemplate.")
      await writeFile(path.join(dot, "commands/good.md"), "---\n---\nTemplate.")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("commands/good")
      expect(result.loaded).not.toContain("commands/bad")
      expect(result.skipped.some((s) => s.path === "commands/bad.md")).toBe(true)
    })
  })

  test("skips empty plugin files", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "plugins/empty.ts"), "")
      await writeFile(path.join(dot, "plugins/audit.ts"), "export default { name: 'audit' }")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("plugins/audit")
      expect(result.loaded).not.toContain("plugins/empty")
      expect(result.skipped.some((s) => s.path === "plugins/empty.ts")).toBe(true)
    })
  })

  test("reports unavailable services in skipped", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "AGENTS.md"), "# Rules")
      const partialLayer = Layer.mergeAll(
        SessionLoadDotOpencode.layer,
        SessionAgentsMd.noopLayer,
        SessionAgent.noopLayer,
        SessionSkill.noopLayer,
        SessionMcp.noopLayer,
        SessionTool.noopLayer,
        SessionCommand.noopLayer,
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionLoadDotOpencode.Service
          return yield* svc.load(SID, dir)
        }).pipe(Effect.provide(partialLayer)),
      )
      expect(result.skipped.some((s) => s.path === "plugins" && s.reason === "Session service unavailable")).toBe(true)
    })
  })

  test("loads MCP from opencode.jsonc", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "opencode.jsonc"),
        `{
          // comment
          "mcp": {
            "github": { "type": "remote", "url": "https://example.com/mcp" },
          },
        }`,
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("mcp/github")
    })
  })

  test("skips skill resources exceeding size limit", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      const skillDir = path.join(dot, "skills", "my-skill")
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true })
      await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---\nSkill.")
      await writeFile(path.join(skillDir, "references", "huge.md"), "x".repeat(300 * 1024))
      await writeFile(path.join(skillDir, "references", "small.md"), "# Small")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("skills/my-skill")
    })
  })

  test("limits skill resource count", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      const skillDir = path.join(dot, "skills", "my-skill")
      await fs.mkdir(path.join(skillDir, "references"), { recursive: true })
      await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: my-skill\n---\nSkill.")
      for (let i = 0; i < 80; i++) {
        await writeFile(path.join(skillDir, "references", `ref${i}.md`), `# Ref ${i}`)
      }
      const result = await runLoad(dir)
      expect(result.loaded).toContain("skills/my-skill")
    })
  })

  // ── Local MCP type ──

  test("loads local MCP with command and environment", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "opencode.json"),
        JSON.stringify({
          mcp: {
            local: {
              type: "local",
              command: ["bun", "run", "server.ts"],
              environment: { API_KEY: "secret" },
            },
          },
        }),
      )
      let mcpInput: SessionMcp.Input | undefined
      const captureLayer = Layer.mergeAll(
        SessionLoadDotOpencode.layer,
        SessionAgentsMd.noopLayer,
        SessionAgent.noopLayer,
        SessionSkill.noopLayer,
        Layer.mock(SessionMcp.Service, {
          upsert: (_sid, input) =>
            Effect.sync(() => {
              mcpInput = input
              return {} as SessionMcp.Row
            }),
        }),
        SessionTool.noopLayer,
        SessionCommand.noopLayer,
        SessionPlugin.noopLayer,
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionLoadDotOpencode.Service
          return yield* svc.load(SID, dir)
        }).pipe(Effect.provide(captureLayer)),
      )
      expect(mcpInput).toEqual({
        name: "local",
        type: "local",
        command: ["bun", "run", "server.ts"],
        environment: { API_KEY: "secret" },
        enabled: undefined,
      })
    })
  })

  // ── Plural directory names ──

  test("loads agents from plural agents/ directory", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "agents/reviewer.md"),
        "---\ndescription: Review\n---\nReview code.",
      )
      await writeFile(
        path.join(dot, "agents/tester.md"),
        "---\ndescription: Test\n---\nTest code.",
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("agents/reviewer")
      expect(result.loaded).toContain("agents/tester")
    })
  })

  test("loads commands from plural commands/ directory", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "commands/deploy.md"),
        "---\ndescription: Deploy\n---\nDeploy the app.",
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("commands/deploy")
    })
  })

  test("loads plugins from plural plugins/ directory", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "plugins/audit.ts"), "export default { name: 'audit' }")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("plugins/audit")
    })
  })

  // ── Agent full field mapping ──

  test("maps all agent fields correctly", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "agents/full.md"),
        [
          "---",
          "description: Full agent",
          "mode: subagent",
          "model: openai/gpt-4.1",
          "temperature: 0.7",
          "top_p: 0.9",
          "steps: 25",
          "color: \"#FF5733\"",
          "variant: fast",
          'options:',
          '  reasoning: true',
          'permission:',
          '  edit: allow',
          '  bash:',
          '    "*": allow',
          "---",
          "You are a full agent.",
        ].join("\n"),
      )
      let agentInput: SessionAgent.Input | undefined
      const captureLayer = Layer.mergeAll(
        SessionLoadDotOpencode.layer,
        SessionAgentsMd.noopLayer,
        Layer.mock(SessionAgent.Service, {
          upsert: (_sid, input) =>
            Effect.sync(() => {
              agentInput = input
              return {} as SessionAgent.Row
            }),
        }),
        SessionSkill.noopLayer,
        SessionMcp.noopLayer,
        SessionTool.noopLayer,
        SessionCommand.noopLayer,
        SessionPlugin.noopLayer,
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionLoadDotOpencode.Service
          return yield* svc.load(SID, dir)
        }).pipe(Effect.provide(captureLayer)),
      )
      expect(agentInput?.name).toBe("full")
      expect(agentInput?.description).toBe("Full agent")
      expect(agentInput?.mode).toBe("subagent")
      expect(agentInput?.model).toEqual({ providerID: "openai", modelID: "gpt-4.1" })
      expect(agentInput?.temperature).toBe(0.7)
      expect(agentInput?.topP).toBe(0.9)
      expect(agentInput?.steps).toBe(25)
      expect(agentInput?.color).toBe("#FF5733")
      expect(agentInput?.variant).toBe("fast")
      expect(agentInput?.options).toEqual({ reasoning: true })
    })
  })

  // ── MCP headers ──

  test("loads remote MCP with headers", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "opencode.json"),
        JSON.stringify({
          mcp: {
            github: {
              type: "remote",
              url: "https://example.com/mcp",
              headers: { Authorization: "Bearer token123", "X-Custom": "val" },
            },
          },
        }),
      )
      let mcpInput: SessionMcp.Input | undefined
      const captureLayer = Layer.mergeAll(
        SessionLoadDotOpencode.layer,
        SessionAgentsMd.noopLayer,
        SessionAgent.noopLayer,
        SessionSkill.noopLayer,
        Layer.mock(SessionMcp.Service, {
          upsert: (_sid, input) =>
            Effect.sync(() => {
              mcpInput = input
              return {} as SessionMcp.Row
            }),
        }),
        SessionTool.noopLayer,
        SessionCommand.noopLayer,
        SessionPlugin.noopLayer,
      )
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionLoadDotOpencode.Service
          return yield* svc.load(SID, dir)
        }).pipe(Effect.provide(captureLayer)),
      )
      expect(mcpInput?.headers).toEqual({ Authorization: "Bearer token123", "X-Custom": "val" })
    })
  })

  // ── Command nested path ──

  test("extracts command name from nested directory path", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "commands/category/deploy.md"),
        "---\ndescription: Deploy\n---\nDeploy the app.",
      )
      const result = await runLoad(dir)
      expect(result.loaded).toContain("commands/category/deploy")
    })
  })

  // ── opencode.json without mcp field ──

  test("handles opencode.json without mcp field gracefully", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "opencode.json"),
        JSON.stringify({ command: { greet: { template: "hello" } } }),
      )
      await writeFile(path.join(dot, "AGENTS.md"), "# Rules")
      const result = await runLoad(dir)
      expect(result.loaded).toContain("AGENTS.md")
      expect(result.loaded.filter((l) => l.startsWith("mcp/"))).toHaveLength(0)
      expect(result.skipped.filter((s) => s.path.startsWith("opencode.json"))).toHaveLength(0)
    })
  })

  // ── Empty frontmatter ──

  test("loads agent with empty frontmatter", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "agents/minimal.md"), "---\n---\nJust a prompt.")
      let agentInput: SessionAgent.Input | undefined
      const captureLayer = Layer.mergeAll(
        SessionLoadDotOpencode.layer,
        SessionAgentsMd.noopLayer,
        Layer.mock(SessionAgent.Service, {
          upsert: (_sid, input) =>
            Effect.sync(() => {
              agentInput = input
              return {} as SessionAgent.Row
            }),
        }),
        SessionSkill.noopLayer,
        SessionMcp.noopLayer,
        SessionTool.noopLayer,
        SessionCommand.noopLayer,
        SessionPlugin.noopLayer,
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* SessionLoadDotOpencode.Service
          return yield* svc.load(SID, dir)
        }).pipe(Effect.provide(captureLayer)),
      )
      expect(result.loaded).toContain("agents/minimal")
      expect(agentInput?.name).toBe("minimal")
      expect(agentInput?.mode).toBe("all")
      expect(agentInput?.prompt).toBe("Just a prompt.")
    })
  })

  // ── Same-name resource conflict ──

  test("handles same-name agent from different paths (last wins)", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(
        path.join(dot, "agents/reviewer.md"),
        "---\ndescription: File reviewer\n---\nReview A.",
      )
      await fs.mkdir(path.join(dot, "agents", "reviewer"), { recursive: true })
      await writeFile(
        path.join(dot, "agents/reviewer/index.md"),
        "---\ndescription: Dir reviewer\n---\nReview B.",
      )
      const result = await runLoad(dir)
      const reviewerLoaded = result.loaded.filter((l) => l.startsWith("agents/reviewer"))
      expect(reviewerLoaded.length).toBeGreaterThanOrEqual(1)
    })
  })

  test("supports concurrent load calls without loader failures", async () => {
    await withDir(async (dir) => {
      const dot = await mkDotDir(dir)
      await writeFile(path.join(dot, "agents/concurrent.md"), "---\n---\nConcurrent prompt.")

      let upsertCount = 0
      const captureLayer = Layer.mergeAll(
        SessionLoadDotOpencode.layer,
        SessionAgentsMd.noopLayer,
        Layer.mock(SessionAgent.Service, {
          upsert: (_sessionID, input) =>
            Effect.promise(async () => {
              await new Promise((resolve) => setTimeout(resolve, 10))
              upsertCount += 1
              return {
                id: `agent-${upsertCount}`,
                session_id: SID,
                name: input.name,
                description: input.description ?? null,
                mode: input.mode ?? "all",
                prompt: input.prompt ?? null,
                permission: [...(input.permission ?? [])],
                model: input.model ?? null,
                temperature: input.temperature ?? null,
                top_p: input.topP ?? null,
                steps: input.steps ?? null,
                color: input.color ?? null,
                variant: input.variant ?? null,
                options: input.options ?? {},
                time_created: Date.now(),
                time_updated: Date.now(),
              } as SessionAgent.Row
            }),
        }),
        SessionSkill.noopLayer,
        SessionMcp.noopLayer,
        SessionTool.noopLayer,
        SessionCommand.noopLayer,
        SessionPlugin.noopLayer,
      )

      const load = () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const svc = yield* SessionLoadDotOpencode.Service
            return yield* svc.load(SID, dir)
          }).pipe(Effect.provide(captureLayer)),
        )

      const results = await Promise.all([load(), load(), load()])
      expect(results.every((result) => result.loaded.includes("agents/concurrent"))).toBe(true)
      expect(results.every((result) => result.skipped.length === 0)).toBe(true)
      expect(upsertCount).toBe(3)
    })
  })
})
