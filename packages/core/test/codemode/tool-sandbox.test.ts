import { describe, expect } from "bun:test"
import { CodeMode } from "@opencode/codemode"
import { CodeModeSandbox } from "@opencode/core/codemode/sandbox"
import { CodeModeTool } from "@opencode/core/codemode/tool"
import type { Metadata } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { it } from "../lib/effect"

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

const context = (rows: Array<ExecuteCall>) => ({
  sessionID: "ses_test" as never,
  agent: "agt_test" as never,
  messageID: "msg_test" as never,
  id: "call_test" as never,
  progress: (update: Metadata) =>
    Effect.sync(() => {
      rows.length = 0
      rows.push(...((update.toolCalls ?? []) as Array<ExecuteCall>))
    }),
})

const oneTool = {
  name: "one",
  description: "one tool",
  input: Schema.Struct({ v: Schema.optionalKey(Schema.Number) }),
  options: { namespace: "t" },
  execute: (input: { v?: number }) =>
    Effect.succeed({
      output: `ran:${input.v ?? 0}`,
      content: [
        { type: "text" as const, text: "note" },
        { type: "file" as const, uri: "data:text/plain;base64,aGVsbG8=", mime: "text/plain" },
      ],
    }),
}

describe("CodeModeTool sandbox routing", () => {
  it.effect("routes through the sandbox service and assembles rows, files, and output", () =>
    Effect.gen(function* () {
      const executed: Array<{ name: string; input: unknown }> = []
      const inventory = { tools: new Map([["one", oneTool]]) }
      const codeModeTool = CodeModeTool.create(inventory, (name, _tool, input) =>
        Effect.gen(function* () {
          executed.push({ name, input })
          return yield* oneTool.execute(input as { v?: number })
        }),
      )

      const runInputs: Array<Parameters<CodeModeSandbox.Interface["run"]>[0]> = []
      const notify = (effect: Effect.Effect<void> | undefined) => effect ?? Effect.void
      const fakeRun = (input: Parameters<CodeModeSandbox.Interface["run"]>[0]): Effect.Effect<CodeMode.Result> =>
        Effect.gen(function* () {
          runInputs.push(input)
          yield* notify(input.bridge.onStart?.("t.one", { v: 9 }))
          const value = yield* input.bridge.call("t.one", { v: 9 })
          yield* notify(input.bridge.onEnd?.("t.one", true))
          yield* notify(input.bridge.onStart?.("t.one", { v: 8 }))
          yield* input.bridge.call("t.one", { v: 8 })
          yield* notify(input.bridge.onEnd?.("t.one", false))
          return { ok: true, value, toolCalls: [] } as CodeMode.Result
        }).pipe(Effect.catch(() => Effect.die("unexpected bridge failure")))

      const rows: Array<ExecuteCall> = []
      const outcome = yield* codeModeTool
        .execute({ code: "return await tools.t.one({ v: 9 })" }, context(rows))
        .pipe(Effect.provideService(CodeModeSandbox.Service, CodeModeSandbox.Service.of({ run: fakeRun })))

      // The sandbox received the code and the qualified catalog entries.
      expect(runInputs).toHaveLength(1)
      expect(runInputs[0]?.code).toBe("return await tools.t.one({ v: 9 })")
      expect(runInputs[0]?.tools).toEqual([{ path: "t.one", description: "one tool" }])
      // Bridge calls resolved back to the registered tool by qualified path.
      expect(executed).toEqual([
        { name: "one", input: { v: 9 } },
        { name: "one", input: { v: 8 } },
      ])
      // Rows update through progress in start order, settling running rows first.
      expect(rows).toEqual([
        { tool: "t.one", status: "completed", input: { v: 9 } },
        { tool: "t.one", status: "error", input: { v: 8 } },
      ])
      // The returned value is the first tool output; each bridge call's file lands in the output once.
      expect(outcome.output.output).toBe("ran:9")
      expect(outcome.output.error).toBeUndefined()
      expect(outcome.output.files).toEqual([
        { data: "aGVsbG8=", mime: "text/plain" },
        { data: "aGVsbG8=", mime: "text/plain" },
      ])
      expect(outcome.metadata.toolCalls).toEqual(rows)
      expect(outcome.content.some((part) => part.type === "file" && part.uri.includes("aGVsbG8="))).toBe(true)
    }))

  it.effect("falls back to the in-process interpreter without a sandbox service", () =>
    Effect.gen(function* () {
      const inventory = { tools: new Map([["one", { ...oneTool, options: undefined }]]) }
      const codeModeTool = CodeModeTool.create(inventory, (name, _tool, input) =>
        Effect.succeed({ output: `${name}:${JSON.stringify(input)}` }),
      )
      const outcome = yield* codeModeTool.execute({ code: "return await tools.one({ v: 3 })" }, context([]))
      expect(outcome.output.output).toBe("one:{\"v\":3}")
      expect(outcome.output.toolCalls).toEqual([{ tool: "one", status: "completed", input: { v: 3 } }])
      expect(outcome.output.error).toBeUndefined()
    }))
})
