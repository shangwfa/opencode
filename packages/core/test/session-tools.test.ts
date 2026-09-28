import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { SessionTool } from "@opencode/schema/session-tool"
import { importToolCode, inputFromArgs, toResult, toToolInfo } from "@opencode/core/session/tools"

const context = {
  sessionID: "ses_x" as any,
  agent: "build" as any,
  messageID: "msg_x" as any,
  id: "call_x" as any,
  progress: () => undefined as any,
}

const V1_CODE = (body: string) => `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Test tool",
  args: { text: tool.schema.string().describe("Text") },
  async execute(args) { ${body} },
})`

describe("SessionTools source loading", () => {
  test("caches modules by code content and picks up updated code", async () => {
    const first = await importToolCode(V1_CODE(`return "V1"`))
    const again = await importToolCode(V1_CODE(`return "V1"`))
    expect(again).toBe(first)
    const second = await importToolCode(V1_CODE(`return "V2"`))
    expect(second).not.toBe(first)
    expect(await second.default.execute({ text: "x" }, {})).toBe("V2")
  })

  test("rejects broken and non-tool exports", async () => {
    await expect(importToolCode("export default {{{{ invalid")).rejects.toThrow()
    const notATool = await importToolCode(`export default { foo: "bar" }`)
    const def = notATool.default ?? notATool
    expect(typeof def.execute).not.toBe("function")
    // A failed import stays failed-cached, matching V1 content-cache semantics.
    await expect(importToolCode("export default {{{{ invalid")).rejects.toThrow()
  })
})

describe("SessionTools definition adaptation", () => {
  test("derives a permissive input schema from a V1 zod args shape", () => {
    const fakeZod = {
      description: "User name",
      isOptional: () => false,
      _def: { typeName: "ZodString" },
    }
    const optionalNumber = { _def: { typeName: "ZodOptional" } }
    const schema = inputFromArgs({ name: fakeZod, age: optionalNumber }) as Record<string, any>
    expect(schema.type).toBe("object")
    expect(schema.properties.name).toEqual({ type: "string", description: "User name" })
    expect(schema.properties.age).toEqual({})
    expect(schema.required).toEqual(["name"])
  })

  test("maps V1 results onto the V2 result contract", () => {
    expect(toResult("plain")).toEqual({ output: "plain", content: "plain" })
    expect(toResult({ title: "Greeted", output: "hi", metadata: { k: 1 } })).toEqual({
      output: "hi",
      content: "hi",
      metadata: { k: 1, title: "Greeted" },
    })
    expect(toResult({ output: { nested: true } }, true)).toEqual({ output: { nested: true }, metadata: {} })
  })

  test("wraps user-code failures as tool failures instead of defects", async () => {
    const info = toToolInfo(
      SessionTool.Name.make("crash-tool"),
      {
        description: "throws",
        execute: () => {
          throw new Error("Simulated tool failure: boom")
        },
      },
      "/workspace",
    )
    const result = await Effect.runPromiseExit(info.execute({}, context))
    expect(Exit.isFailure(result)).toBe(true)
  })

  test("passes the session directory through to user code", async () => {
    let seen = ""
    const info = toToolInfo(
      SessionTool.Name.make("ctx-tool"),
      {
        description: "ctx",
        execute: (_args, toolContext) => {
          seen = (toolContext as { directory?: string }).directory ?? ""
          return "ok"
        },
      },
      "/workspace/project",
    )
    const result = await Effect.runPromiseExit(info.execute({}, context))
    expect(seen).toBe("/workspace/project")
    expect(Exit.isSuccess(result)).toBe(true)
  })
})

describe("SessionTool contracts", () => {
  test("rejects empty or unsafe names at the schema boundary", () => {
    expect(() => SessionTool.Name.make("")).toThrow()
    expect(() => SessionTool.Name.make("bad name")).toThrow()
    expect(() => SessionTool.Name.make("bash;rm -rf")).toThrow()
    expect(String(SessionTool.Name.make("add-numbers"))).toBe("add-numbers")
  })

  test("bounds the code payload", () => {
    expect(() =>
      SessionTool.Payload.make({
        name: SessionTool.Name.make("big"),
        description: "x",
        code: "x".repeat(SessionTool.MaxCodeBytes + 1),
      }),
    ).toThrow()
  })
})
