import { describe, expect, test } from "bun:test"
import { makeCodeModeTool, type Extension } from "@/tool/code-mode"
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js"
import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { Plugin } from "@/plugin"
import { Session } from "@/session/session"
import { Tool } from "@/tool/tool"
import * as Truncate from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"
import { Cause, Effect, Exit, Layer } from "effect"
import { toolError } from "@opencode-ai/codemode"

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_parity"),
  messageID: MessageID.make("msg_parity"),
  agent: "build",
  abort: new AbortController().signal,
  callID: "call_parity",
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  sandbox: null,
}

function mcpTool(name: string, handler: (args: Record<string, unknown>) => unknown): MCP.McpTool {
  return {
    def: { name, description: name, inputSchema: { type: "object", properties: {} } } as MCPToolDef,
    client: {
      callTool: async (params: { arguments?: Record<string, unknown> }) => handler(params.arguments ?? {}),
    } as unknown as MCP.McpTool["client"],
  }
}

function extension(id: string, run: (args: Record<string, unknown>) => unknown): Extension {
  return {
    id,
    description: `fake ${id}`,
    input: { type: "object", properties: { value: { type: "string" } } },
    run: (args) =>
      Effect.promise(() => Promise.resolve(run(args))).pipe(
        Effect.map((output) => ({ title: id, output: String(output), metadata: {} })),
      ),
  }
}

function failingExtension(id: string, message: string): Extension {
  return {
    id,
    description: `fake ${id}`,
    input: { type: "object", properties: {} },
    run: () => Effect.fail(toolError(message)),
  }
}

function harness(input: { mcpTools: Record<string, MCP.McpTool>; servers: string[]; permission?: PermissionV1.Rule[] }) {
  return Layer.mergeAll(
    Layer.mock(Plugin.Service, {
      trigger: ((_name: unknown, _input: unknown, output: unknown) =>
        Effect.succeed(output)) as Plugin.Interface["trigger"],
    }),
    Layer.mock(Truncate.Service, {
      output: (text: string) => Effect.succeed({ content: text, truncated: false as const }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", permission: input.permission ?? [] } as any),
    }),
    Layer.mock(Session.Service, {
      get: () => Effect.succeed({ permission: [] } as any),
    }),
    Layer.mock(MCP.Service, {
      tools: () => Effect.succeed(input.mcpTools),
      toolsForSession: () => Effect.succeed(input.mcpTools),
      clients: () => Effect.succeed(Object.fromEntries(input.servers.map((name) => [name, {} as any]))),
    }),
  )
}

const emptyHarness = harness({ mcpTools: {}, servers: [] })

function buildExtended(extensions: readonly Extension[]) {
  return Effect.runPromise(
    makeCodeModeTool(extensions).pipe(Effect.flatMap(Tool.init), Effect.provide(emptyHarness)),
  )
}

function build(mcpTools: Record<string, MCP.McpTool>) {
  const servers = [...new Set(Object.keys(mcpTools).map((key) => key.split("_")[0]!))]
  return Effect.runPromise(
    makeCodeModeTool([]).pipe(Effect.flatMap(Tool.init), Effect.provide(harness({ mcpTools, servers }))),
  )
}

async function failure(effect: Effect.Effect<unknown>) {
  const exit = await Effect.runPromise(effect.pipe(Effect.exit))
  if (Exit.isSuccess(exit)) throw new Error("expected the tool to fail")
  return Cause.squash(exit.cause) as Error
}

describe("tool-script parity: execution and aggregation", () => {
  test("executes code, calls tools, returns aggregated result", async () => {
    const seen: string[] = []
    const tool = await buildExtended([
      extension("echo", (args) => {
        seen.push(String(args.value))
        return `echo:${args.value}`
      }),
    ])
    const result = await Effect.runPromise(
      tool.execute(
        {
          code: `
            const items = ["a", "b", "c"]
            const outs = await Promise.all(items.map(v => tools.opencode.echo({ value: v })))
            return outs.join(",")
          `,
        },
        ctx,
      ),
    )
    expect(result.metadata.toolCalls).toHaveLength(3)
    expect(result.output).toBe("echo:a,echo:b,echo:c")
    expect(seen.toSorted()).toEqual(["a", "b", "c"])
  })

  test("sequential dependent calls compose results", async () => {
    const tool = await buildExtended([extension("echo", (args) => `echo:${args.value}`)])
    const result = await Effect.runPromise(
      tool.execute(
        {
          code: `
            const first = await tools.opencode.echo({ value: "x" })
            const second = await tools.opencode.echo({ value: first })
            return second
          `,
        },
        ctx,
      ),
    )
    expect(result.output).toBe("echo:echo:x")
  })

  test("console.log is captured into the output logs section", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `console.log("hello", { a: 1 }); return 1` }, ctx))
    expect(result.output).toContain("Logs:")
    expect(result.output).toContain("hello")
  })

  test("string return passes through verbatim without JSON escaping", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(
      tool.execute({ code: `return "line1\\nline2 with \\"quotes\\""` }, ctx),
    )
    expect(result.output).toBe('line1\nline2 with "quotes"')
  })
})

describe("tool-script parity: failure taxonomy", () => {
  test("unknown tool rejects catchably and records the error in metadata", async () => {
    const tool = await buildExtended([extension("echo", () => "ok")])
    const result = await Effect.runPromise(
      tool.execute(
        { code: `try { await tools.opencode.nope({}) } catch (e) { return "caught: " + e.message }` },
        ctx,
      ),
    )
    expect(result.output).toContain("caught:")
    expect(result.output).toContain("opencode.nope")
    expect(result.metadata.toolCalls).toEqual([])
  })

  test("tool failure rejects the guest promise with a readable message", async () => {
    const tool = await buildExtended([failingExtension("boom", "kapow")])
    const result = await Effect.runPromise(
      tool.execute({ code: `try { await tools.opencode.boom({}) } catch (e) { return e.message }` }, ctx),
    )
    expect(result.output).toContain("kapow")
    expect(result.metadata.toolCalls).toEqual([{ tool: "opencode.boom", status: "error" }])
  })

  test("uncaught tool failure fails the whole execution with metadata", async () => {
    const tool = await buildExtended([failingExtension("boom", "kapow")])
    const error = await failure(tool.execute({ code: `return await tools.opencode.boom({})` }, ctx))
    expect(error).toBeInstanceOf(Tool.ExecutionError)
    expect(error.message).toContain("kapow")
    expect((error as Tool.ExecutionError).metadata).toMatchObject({ error: true })
  })

  test("syntax error surfaces as a parse failure", async () => {
    const tool = await buildExtended([])
    const error = await failure(tool.execute({ code: `const = broken (` }, ctx))
    expect(error).toBeInstanceOf(Tool.ExecutionError)
  })

  test("pre-aborted signal cancels the execution", async () => {
    const abort = new AbortController()
    abort.abort()
    const tool = await buildExtended([])
    const error = await failure(tool.execute({ code: `return 1` }, { ...ctx, abort: abort.signal }))
    expect(error.message).toBe("Execution cancelled.")
    expect((error as Tool.ExecutionError).metadata).toMatchObject({ toolCalls: [], error: true })
  })

  test("import is not supported", async () => {
    const tool = await buildExtended([])
    const error = await failure(tool.execute({ code: `import * as x from "node:fs"\nreturn 1` }, ctx))
    expect(error.message).toContain("import")
  })

  test("require resolves to undefined (unknown globals are inert)", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `return typeof require` }, ctx))
    expect(result.output).toBe("undefined")
  })
})

describe("tool-script parity: data boundary", () => {
  test("circular reference in return value fails with an invalid-data diagnostic", async () => {
    const tool = await buildExtended([])
    const error = await failure(
      tool.execute({ code: `const a = { items: [{}] }; a.items[0].self = a; return a` }, ctx),
    )
    expect(error.message).toContain("circular")
  })

  test("BigInt literal is rejected as non-data", async () => {
    const tool = await buildExtended([])
    const error = await failure(tool.execute({ code: `return 123n` }, ctx))
    expect(error.message).toMatch(/data|BigInt/i)
  })

  test("object getters are unsupported and fail loudly", async () => {
    const tool = await buildExtended([])
    const error = await failure(tool.execute({ code: `return { get x() { return 1 } }` }, ctx))
    expect(error.message).toContain("init object properties")
  })

  test("NaN and Infinity serialize to null at the boundary", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(
      tool.execute({ code: `return { n: NaN, i: Infinity, ni: -Infinity }` }, ctx),
    )
    expect(JSON.parse(result.output)).toEqual({ n: null, i: null, ni: null })
  })

  test("Error values serialize to a plain object with name and message", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `return new Error("boom")` }, ctx))
    expect(JSON.parse(result.output)).toMatchObject({ name: "Error", message: "boom" })
  })

  test("clean JSON return has no warnings and no logs", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `return { a: 1, b: "x", c: [true, null] }` }, ctx))
    expect(result.output).not.toContain("Logs:")
    expect(JSON.parse(result.output)).toEqual({ a: 1, b: "x", c: [true, null] })
  })

  test("returning undefined yields an empty output", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `return undefined` }, ctx))
    expect(result.output).toBe("null")
  })
})

describe("tool-script parity: ambient capabilities", () => {
  test("Date is available inside the sandbox", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `return typeof Date.now()` }, ctx))
    expect(result.output).toBe("number")
  })

  test("Math.random is not available", async () => {
    const tool = await buildExtended([])
    const error = await failure(tool.execute({ code: `return Math.random()` }, ctx))
    expect(error.message).toContain("Math.random")
  })

  test("no files global is provided (host keeps raw file IO out of the sandbox)", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `return typeof files` }, ctx))
    expect(result.output).toBe("undefined")
  })

  test("no fetch global is provided", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(tool.execute({ code: `return typeof fetch` }, ctx))
    expect(result.output).toBe("undefined")
  })

  test("no process or Node module globals are provided", async () => {
    const tool = await buildExtended([])
    const result = await Effect.runPromise(
      tool.execute({ code: `return [typeof process, typeof global, typeof Buffer]` }, ctx),
    )
    expect(JSON.parse(result.output)).toEqual(["undefined", "undefined", "undefined"])
  })
})

describe("tool-script parity: concurrency", () => {
  test("Promise.all runs independent calls concurrently", async () => {
    const order: string[] = []
    const tool = await buildExtended([
      {
        id: "slow",
        description: "slow",
        input: { type: "object", properties: {} },
        run: () =>
          Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50))
            order.push("slow")
            return { title: "slow", output: "s", metadata: {} }
          }),
      },
      {
        id: "fast",
        description: "fast",
        input: { type: "object", properties: {} },
        run: () =>
          Effect.sync(() => {
            order.push("fast")
            return { title: "fast", output: "f", metadata: {} }
          }),
      },
    ])
    const result = await Effect.runPromise(
      tool.execute(
        { code: `const [a, b] = await Promise.all([tools.opencode.slow({}), tools.opencode.fast({})]); return a + b` },
        ctx,
      ),
    )
    expect(result.output).toBe("sf")
    expect(order).toEqual(["fast", "slow"])
  })

  test("Promise.allSettled collects mixed outcomes", async () => {
    const tool = await buildExtended([
      extension("ok", () => "good"),
      failingExtension("bad", "went wrong"),
    ])
    const result = await Effect.runPromise(
      tool.execute(
        {
          code: `
            const results = await Promise.allSettled([tools.opencode.ok({}), tools.opencode.bad({})])
            return results.map(r => r.status)
          `,
        },
        ctx,
      ),
    )
    expect(JSON.parse(result.output)).toEqual(["fulfilled", "rejected"])
  })
})

describe("tool-script parity: MCP path", () => {
  test("MCP tools are callable and return text content", async () => {
    const tool = await build({
      srv_search: mcpTool("search", () => ({
        content: [
          { type: "text", text: "hit-1" },
          { type: "text", text: "hit-2" },
        ],
      })),
    })
    const result = await Effect.runPromise(tool.execute({ code: `return await tools.srv.search({ q: "x" })` }, ctx))
    expect(result.output).toBe("hit-1\nhit-2")
  })

  test("MCP tool failure is catchable inside the program", async () => {
    const tool = await build({
      srv_fail: mcpTool("fail", () => ({ isError: true, content: [{ type: "text", text: "server exploded" }] })),
    })
    const result = await Effect.runPromise(
      tool.execute({ code: `try { await tools.srv.fail({}) } catch (e) { return "caught: " + e.message }` }, ctx),
    )
    expect(result.output).toBe("caught: server exploded")
  })

  test("MCP permission is asked per child call", async () => {
    const asked: unknown[] = []
    const permissionCtx: Tool.Context = { ...ctx, ask: (req) => Effect.sync(() => void asked.push(req)) }
    const tool = await build({ srv_ping: mcpTool("ping", () => ({ content: [{ type: "text", text: "pong" }] })) })
    await Effect.runPromise(tool.execute({ code: `await tools.srv.ping({}); await tools.srv.ping({}); return 1` }, permissionCtx))
    expect(asked.map((req: any) => req.permission)).toEqual(["srv_ping", "srv_ping"])
  })

  test("MCP image content is collected as an attachment, not dropped", async () => {
    const tool = await build({
      srv_img: mcpTool("img", () => ({
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      })),
    })
    const result = await Effect.runPromise(tool.execute({ code: `return await tools.srv.img({})` }, ctx))
    expect(result.output).toBe("[1 image attached to the result]")
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments![0]).toMatchObject({ type: "file", mime: "image/png" })
    expect(JSON.stringify(result.output)).not.toContain("aGVsbG8=")
  })

  test("MCP structured content crosses as native data", async () => {
    const tool = await build({
      srv_add: mcpTool("add", (args) => ({
        content: [],
        structuredContent: { sum: (args.a as number) + (args.b as number) },
      })),
    })
    const result = await Effect.runPromise(
      tool.execute({ code: `const r = await tools.srv.add({ a: 2, b: 3 }); return r.sum` }, ctx),
    )
    expect(result.output).toBe("5")
  })

  test("mixed MCP and extension calls compose in one program", async () => {
    const ext = extension("double", (args) => String(Number(args.value) * 2))
    const tool = await Effect.runPromise(
      makeCodeModeTool([ext]).pipe(
        Effect.flatMap(Tool.init),
        Effect.provide(
          harness({
            mcpTools: { srv_echo: mcpTool("echo", (args) => ({ content: [{ type: "text", text: String(args.message) }] })) },
            servers: ["srv"],
          }),
        ),
      ),
    )
    const result = await Effect.runPromise(
      tool.execute(
        {
          code: `
            const [d, e] = await Promise.all([
              tools.opencode.double({ value: "21" }),
              tools.srv.echo({ message: "hi" }),
            ])
            return d + ":" + e
          `,
        },
        ctx,
      ),
    )
    expect(result.output).toBe("42:hi")
    expect(result.metadata.toolCalls.map((c) => c.tool).sort()).toEqual(["opencode.double", "srv.echo"])
  })
})
