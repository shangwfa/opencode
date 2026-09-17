import { describe, expect, test } from "bun:test"
import { importPluginCode } from "../../src/plugin/session-plugin-runtime"
import path from "path"

const CODE = `export default async () => ({
  "chat.params": async (_input, output) => {
    output.temperature = 0
  },
  config: async () => {
    throw new Error("must be filtered")
  },
})`

describe("importPluginCode", () => {
  test("loads a default-exported plugin function", async () => {
    const plugin = await importPluginCode(CODE)
    const hooks = await plugin({} as never)
    expect(typeof plugin).toBe("function")
    expect(typeof hooks["chat.params"]).toBe("function")
  })

  test("caches modules by code", async () => {
    expect(await importPluginCode(CODE)).toBe(await importPluginCode(CODE))
  })

  test("rejects a plugin without a default function export", async () => {
    await expect(importPluginCode("export default {}")).rejects.toThrow("Session plugin must default-export a function")
  })

  test("preserves in-process tool definitions", async () => {
    const plugin = await importPluginCode(`export default async () => ({
      tool: {
        demo: {
          description: "Demo tool",
          args: {},
          execute: async () => "ok",
        },
      },
    })`)
    const hooks = await plugin({} as never)
    expect(hooks.tool?.demo.description).toBe("Demo tool")
    expect(await hooks.tool?.demo.execute({}, {} as never)).toBe("ok")
  })
})

describe("sandbox plugin agent", () => {
  test("serializes mutations and chains replacement outputs", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const zod = import.meta.resolve("zod")
    const plugins = [
      {
        name: "first",
        source: "code",
        code: `import { z } from ${JSON.stringify(zod)}
        export default async (input) => ({
          "chat.params": async (_input, output) => {
            output.temperature = 0
            output.directory = input.directory
            output.worktree = input.worktree
            return { ...output, topP: 0.5 }
           },
           "experimental.session.compacting": async (_input, output) => {
             output.context.push("remembered")
             return "snapshot"
           },
           "tool.execute.before": async () => {
             throw new Error("blocked by plugin")
           },
           tool: {
            demo: {
              description: "Demo tool",
              args: { value: z.string() },
              execute: async (args, context) => ({ output: args.value + ":" + context.directory }),
            },
          },
        })`,
      },
      {
        name: "second",
        source: "code",
        code: `export default async () => ({
           "chat.params": async (_input, output) => {
             output.topK = 1
             return []
           },
        })`,
      },
    ]
    const process = Bun.spawn(["bun", path.join(import.meta.dir, "../../docker/opt/sandbox-plugin-agent.ts")], {
      env: {
        ...Bun.env,
        PLUGIN_AGENT_PORT: String(port),
        SESSION_ID: "ses_test",
        PLUGINS_BASE64: Buffer.from(JSON.stringify(plugins)).toString("base64"),
      },
      stdout: "ignore",
      stderr: "ignore",
    })

    try {
      const url = `http://127.0.0.1:${port}`
      const health = await waitForHealth(url)
      expect(health.hooks).toEqual(["chat.params", "experimental.session.compacting", "tool.execute.before"])
      expect(health.tools).toEqual(["demo"])

      const response = await fetch(`${url}/hook/chat.params`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: {}, output: { temperature: 1, topP: 1, topK: 2 } }),
      })
      expect(await response.json()).toEqual({
        result: { temperature: 0, topP: 0.5, topK: 1, directory: "/workspace", worktree: "/workspace" },
      })

      const compacting = await fetch(`${url}/hook/experimental.session.compacting`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: {}, output: { context: [], prompt: undefined } }),
      })
      expect(await compacting.json()).toEqual({ result: { context: ["remembered"] } })

      const blocked = await fetch(`${url}/hook/tool.execute.before`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: {}, output: { args: {} } }),
      })
      expect(blocked.status).toBe(500)
      expect(await blocked.json()).toEqual({ error: "Error: blocked by plugin" })

      const tools = await (await fetch(`${url}/tools`)).json()
      expect(tools.demo.jsonSchema).toMatchObject({
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      })
      const tool = await fetch(`${url}/tool/demo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: { value: "ok" }, context: { directory: "/workspace" } }),
      })
      expect(await tool.json()).toMatchObject({ result: { output: "ok:/workspace" } })

      expect((await fetch(`${url}/shutdown`, { method: "POST" })).ok).toBe(true)
      await Promise.race([
        process.exited,
        Bun.sleep(2000).then(() => {
          throw new Error("sandbox plugin agent did not stop")
        }),
      ])
    } finally {
      process.kill()
    }
  }, 10_000)

  test("stays healthy when every plugin fails to load", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const process = Bun.spawn(["bun", path.join(import.meta.dir, "../../docker/opt/sandbox-plugin-agent.ts")], {
      env: {
        ...Bun.env,
        PLUGIN_AGENT_PORT: String(port),
        SESSION_ID: "ses_broken",
        PLUGINS_BASE64: Buffer.from(JSON.stringify([
          { name: "broken", source: "code", code: "export default {{{ invalid" },
        ])).toString("base64"),
      },
      stdout: "ignore",
      stderr: "ignore",
    })

    try {
      const url = `http://127.0.0.1:${port}`
      const health = await waitForHealth(url)
      expect(health.status).toBe("degraded")
      expect(health.plugins).toBe(0)
      expect(health.configuredPlugins).toBe(1)
      expect(health.errors).toHaveLength(1)
      expect((await fetch(`${url}/shutdown`, { method: "POST" })).ok).toBe(true)
    } finally {
      process.kill()
    }
  }, 10_000)
})

async function waitForHealth(url: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await fetch(`${url}/health`).catch(() => undefined)
    if (response?.ok) return (await response.json()) as {
      status: string
      plugins: number
      configuredPlugins: number
      errors: Array<{ name: string; error: string }>
      hooks: string[]
      tools: string[]
    }
    await Bun.sleep(20)
  }
  throw new Error("sandbox plugin agent did not become healthy")
}
