import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { SessionTool } from "@opencode/schema/session-tool"
import { inputFromArgs, toResult, toToolInfo } from "@opencode/core/session/tool-definition"
import { mergeDefinitions } from "@opencode/core/session/tools"
import { parseSandboxToolScan } from "@opencode/core/session/tool-scan"

const context = {
  sessionID: "ses_x" as any,
  agent: "build" as any,
  messageID: "msg_x" as any,
  id: "call_x" as any,
  progress: () => undefined as any,
}

describe("SessionTools definition adaptation", () => {
  test("sandbox project definitions take precedence over session definitions", () => {
    const session = toToolInfo(
      SessionTool.Name.make("priority-tool"),
      {
        description: "session",
        args: {},
        execute: () => "session",
      },
      "/workspace",
    )
    const sandbox = toToolInfo(
      SessionTool.Name.make("priority-tool"),
      {
        description: "sandbox",
        args: {},
        execute: () => "sandbox",
      },
      "/workspace",
    )

    expect(mergeDefinitions([session], [sandbox])).toEqual([sandbox])
    expect(mergeDefinitions([session], [])).toEqual([session])
  })

  test("scans only safe direct TS/JS tools and resolves legacy aliases deterministically", () => {
    const parsed = parseSandboxToolScan(
      [
        "/workspace/.opencode/tool/probe.ts\t1\t10",
        "/workspace/.opencode/tools/probe.js\t2\t20",
        "/workspace/.opencode/tools/probe.ts\t3\t30",
        "/workspace/.opencode/tools/bad name.ts\t4\t40",
        "/workspace/.opencode/tools/nested/probe.ts\t5\t50",
        "/workspace/.opencode/tools/ignored.md\t6\t60",
      ].join("\n"),
    )

    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]).toMatchObject({
      name: "probe",
      path: "/workspace/.opencode/tools/probe.ts",
      fingerprint: "3\t30",
    })
    expect(parsed.skipped).toBe(1)
  })

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
