import { afterEach, test, expect, describe } from "bun:test"
import { Database } from "../../src/storage/db"
import { Effect, Schema } from "effect"
import type { SessionID } from "../../src/session/schema"
import path from "path"
import { provideInstance, tmpdir, testInstanceStoreLayer } from "../fixture/fixture"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

const isPg = Database.dialect === "pg"
const fakeSession = "fake-session-id" as unknown as SessionID

function load<A = any, E = unknown>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A, E>): Promise<any> {
  return Effect.runPromise(
    provideInstance(dir)(Agent.Service.use(fn)).pipe(
      Effect.provide(Agent.defaultLayer),
      Effect.provide(testInstanceStoreLayer),
    ) as any,
  )
}

const safeParse = (_schema: any, input: unknown): { success: true; data: any } | { success: false } => {
  try {
    const data = Schema.decodeUnknownSync(_schema)(input)
    return { success: true, data }
  } catch {
    return { success: false }
  }
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("Agent.sessionGet", () => {
  test("sessionGet without session returns global agent", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
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
    await provideTestInstance({
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
    await provideTestInstance({
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
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const list: any[] = await load(tmp.path, (svc) => svc.sessionList(fakeSession))
        const names = list.map((a: any) => a.name)
        expect(names).toContain("build")
        expect(names).toContain("plan")
      },
    })
  })
})

describe("Agent.sessionCreate in non-PG mode", () => {
  test.skipIf(isPg)("sessionCreate throws in non-PG mode", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        await expect(
          load(tmp.path, (svc) =>
            svc.sessionCreate(fakeSession, {
              name: "test-agent",
              description: "Test",
              mode: "all",
              prompt: "Test prompt",
            }) as any,
          ),
        ).rejects.toThrow("only available in SaaS mode")
      },
    })
  })
})

describe("Agent.sessionUnload/sessionClear in non-PG mode", () => {
  test.skipIf(isPg)("sessionUnload throws in non-PG mode", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
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
    await provideTestInstance({
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
    const parsed = safeParse(Agent.CreateInput, {
      name: "my-agent",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.name).toBe("my-agent")
      expect(parsed.data.mode).toBe("all")
    }
  })

  test("CreateInput parses full input", () => {
    const parsed = safeParse(Agent.CreateInput, {
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
    const parsed = safeParse(Agent.CreateInput, {
      name: "bad-agent",
      mode: "invalid",
    })
    expect(parsed.success).toBe(false)
  })

  test("CreateInput rejects invalid name", () => {
    for (const value of ["", " ", "1bad", "bad/name", "bad name"]) {
      expect(safeParse(Agent.CreateInput, { name: value }).success).toBe(false)
    }
  })

  test("CreateInput rejects invalid sampling values", () => {
    expect(safeParse(Agent.CreateInput, { name: "bad", temperature: -0.1 }).success).toBe(false)
    expect(safeParse(Agent.CreateInput, { name: "bad", temperature: 2.1 }).success).toBe(false)
    expect(safeParse(Agent.CreateInput, { name: "bad", topP: -0.1 }).success).toBe(false)
    expect(safeParse(Agent.CreateInput, { name: "bad", topP: 1.1 }).success).toBe(false)
  })
})

describe("Agent.sessionGet preserves global agent properties", () => {
  test("sessionGet returns correct permissions for global agents", async () => {
    await using tmp = await tmpdir()
    await provideTestInstance({
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
    await provideTestInstance({
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
