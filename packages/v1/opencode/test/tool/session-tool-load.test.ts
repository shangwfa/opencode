import { describe, expect, test } from "bun:test"
import { importToolCode } from "../../src/tool/session-tool"

const TOOL_WITH_PLUGIN = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args) {
    return \`Executed query: \${args.query}\`
  },
})`

const TOOL_PLAIN = `export default {
  description: "Plain echo tool",
  args: {},
  async execute() {
    return { title: "Echo", output: "hello" }
  },
}`

const TOOL_WITH_ARGS = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Add two numbers",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args) {
    return { title: "Add", output: String(args.a + args.b) }
  },
})`

describe("importToolCode", () => {
  test("loads code using @opencode-ai/plugin tool() helper", async () => {
    const mod = await importToolCode(TOOL_WITH_PLUGIN)
    const def = mod.default ?? mod
    expect(def.description).toBe("Query the project database")
    expect(def.args.query).toBeDefined()
    expect(typeof def.execute).toBe("function")

    const result = await def.execute({ query: "SELECT 1" }, {
      sessionID: "s1",
      messageID: "m1",
      agent: "build",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    })
    expect(result).toBe("Executed query: SELECT 1")
  })

  test("loads plain object default export", async () => {
    const mod = await importToolCode(TOOL_PLAIN)
    const def = mod.default ?? mod
    expect(def.description).toBe("Plain echo tool")

    const result = await def.execute({}, {
      sessionID: "s1",
      messageID: "m1",
      agent: "build",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    })
    expect(result).toEqual({ title: "Echo", output: "hello" })
  })

  test("loads tool with typed args via tool.schema", async () => {
    const mod = await importToolCode(TOOL_WITH_ARGS)
    const def = mod.default ?? mod
    expect(def.description).toBe("Add two numbers")
    expect(def.args.a).toBeDefined()
    expect(def.args.b).toBeDefined()

    const result = await def.execute({ a: 3, b: 4 }, {
      sessionID: "s1",
      messageID: "m1",
      agent: "build",
      directory: "/tmp",
      worktree: "/tmp",
      abort: new AbortController().signal,
      metadata() {},
      async ask() {},
    })
    expect(result).toEqual({ title: "Add", output: "7" })
  })

  test("caches by code content (same reference)", async () => {
    const mod1 = await importToolCode(TOOL_PLAIN)
    const mod2 = await importToolCode(TOOL_PLAIN)
    expect(mod1).toBe(mod2)
  })

  test("different code produces different modules", async () => {
    const mod1 = await importToolCode(TOOL_PLAIN)
    const mod2 = await importToolCode(TOOL_WITH_ARGS)
    expect(mod1).not.toBe(mod2)
  })

  test("throws on syntax error", async () => {
    const badCode = `export default {{{{ invalid`
    await expect(importToolCode(badCode)).rejects.toThrow()
  })
})
