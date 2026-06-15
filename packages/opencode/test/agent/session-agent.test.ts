import { afterEach, test, expect, describe } from "bun:test"
import { Database } from "../../src/storage/db"
import { Effect } from "effect"
import type { SessionID } from "../../src/session/schema"
import path from "path"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

const isPg = Database.dialect === "pg"
const fakeSession = "fake-session-id" as unknown as SessionID

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)),
  )
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Agent.sessionGet", () => {
  test("sessionGet without session returns global agent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await load(tmp.path, (svc) => svc.sessionGet("build"))
        expect(build).toBeDefined()
        expect(build!.name).toBe("build")
        expect(build!.mode).toBe("primary")
      },
    })
  })

  test("sessionGet with non-PG mode falls back to global agent", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await load(tmp.path, (svc) => svc.sessionGet("build", fakeSession))
        expect(build).toBeDefined()
        expect(build!.name).toBe("build")
      },
    })
  })

  test("sessionGet returns undefined for non-existent agent without session", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await load(tmp.path, (svc) => svc.sessionGet("does_not_exist"))
        expect(agent).toBeUndefined()
      },
    })
  })
})

describe("Agent.sessionList", () => {
  test("sessionList returns global agents in non-PG mode", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const list = await load(tmp.path, (svc) => svc.sessionList(fakeSession))
        const names = list.map((a) => a.name)
        expect(names).toContain("build")
        expect(names).toContain("plan")
      },
    })
  })
})

describe("Agent.sessionCreate in non-PG mode", () => {
  test.skipIf(isPg)("sessionCreate throws in non-PG mode", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(
          load(tmp.path, (svc) =>
            svc.sessionCreate(fakeSession, {
              name: "test-agent",
              description: "Test",
              mode: "all",
              prompt: "Test prompt",
            }),
          ),
        ).rejects.toThrow("only available in SaaS mode")
      },
    })
  })
})

describe("Agent.sessionUnload/sessionClear in non-PG mode", () => {
  test.skipIf(isPg)("sessionUnload throws in non-PG mode", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(
          load(tmp.path, (svc) => svc.sessionUnload(fakeSession, "test-agent")),
        ).rejects.toThrow("only available in SaaS mode")
      },
    })
  })

  test.skipIf(isPg)("sessionClear throws in non-PG mode", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(
          load(tmp.path, (svc) => svc.sessionClear(fakeSession)),
        ).rejects.toThrow("only available in SaaS mode")
      },
    })
  })
})

describe("Agent.CreateInput schema", () => {
  test("CreateInput parses valid input with defaults", () => {
    const parsed = Agent.CreateInput.safeParse({
      name: "my-agent",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.name).toBe("my-agent")
      expect(parsed.data.mode).toBe("all")
    }
  })

  test("CreateInput parses full input", () => {
    const parsed = Agent.CreateInput.safeParse({
      name: "full-agent",
      description: "Full agent",
      mode: "subagent",
      prompt: "Custom prompt",
      permission: [{ permission: "bash", pattern: "*", action: "deny" }],
      temperature: 0.5,
      topP: 0.8,
      steps: 10,
      color: "#00FF00",
      variant: "fast",
      options: { key: "value" },
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.mode).toBe("subagent")
      expect(parsed.data.steps).toBe(10)
    }
  })

  test("CreateInput rejects invalid mode", () => {
    const parsed = Agent.CreateInput.safeParse({
      name: "bad-agent",
      mode: "invalid",
    })
    expect(parsed.success).toBe(false)
  })

  test("CreateInput rejects invalid name", () => {
    for (const value of ["", " ", "1bad", "bad/name", "bad name"]) {
      expect(Agent.CreateInput.safeParse({ name: value }).success).toBe(false)
    }
  })

  test("CreateInput rejects invalid sampling values", () => {
    expect(Agent.CreateInput.safeParse({ name: "bad", temperature: -0.1 }).success).toBe(false)
    expect(Agent.CreateInput.safeParse({ name: "bad", temperature: 2.1 }).success).toBe(false)
    expect(Agent.CreateInput.safeParse({ name: "bad", topP: -0.1 }).success).toBe(false)
    expect(Agent.CreateInput.safeParse({ name: "bad", topP: 1.1 }).success).toBe(false)
  })
})

describe("Agent.CreateInput permission object syntax", () => {
  test("specer permission: edit whitelist matches relative path", () => {
    const parsed = Agent.CreateInput.safeParse({
      name: "specer",
      permission: {
        read: "allow",
        edit: {
          "*": "deny",
          "analysis/9f06e4c6/spec/*.md": "allow",
          "analysis/9f06e4c6/suggest-step.json": "allow",
        },
        bash: "deny",
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const ruleset = Permission.fromConfig(parsed.data.permission ?? {})
    expect(Permission.evaluate("edit", "analysis/9f06e4c6/spec/spec.md", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "analysis/9f06e4c6/suggest-step.json", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/components/index.tsx", ruleset).action).toBe("deny")
    expect(Permission.evaluate("read", "src/components/index.tsx", ruleset).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("deny")
  })

  test("specer permission: **/ prefix does NOT match relative path (known wildcard limitation)", () => {
    const parsed = Agent.CreateInput.safeParse({
      name: "specer",
      permission: {
        edit: {
          "*": "deny",
          "**/analysis/9f06e4c6/spec/*.md": "allow",
        },
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const ruleset = Permission.fromConfig(parsed.data.permission ?? {})
    // **/ prefix requires a "/" before "analysis/" in the path
    // relative paths like "analysis/..." don't have that leading "/" → no match → falls back to deny
    expect(Permission.evaluate("edit", "analysis/9f06e4c6/spec/spec.md", ruleset).action).toBe("deny")
  })
})

describe("Agent.sessionGet preserves global agent properties", () => {
  test("sessionGet returns correct permissions for global agents", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const explore = await load(tmp.path, (svc) => svc.sessionGet("explore"))
        expect(explore).toBeDefined()
        expect(explore!.mode).toBe("subagent")
        expect(Permission.evaluate("edit", "*", explore!.permission).action).toBe("deny")
        expect(Permission.evaluate("read", "*", explore!.permission).action).toBe("allow")
      },
    })
  })

  test("sessionGet respects config overrides", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          build: {
            temperature: 0.9,
            color: "#FF5733",
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await load(tmp.path, (svc) => svc.sessionGet("build"))
        expect(build).toBeDefined()
        expect(build!.temperature).toBe(0.9)
        expect(build!.color).toBe("#FF5733")
      },
    })
  })
})
