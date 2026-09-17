import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { Schema } from "effect"

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
  sandbox: null,
}

const testLayers = Layer.mergeAll(
  Layer.succeed(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false }),
    limits: () => Effect.succeed({ maxBytes: 50000, maxLines: 2000 }),
  } as any),
  Layer.succeed(Agent.Service, {
    get: () => Effect.succeed({ model: undefined, permission: [], tools: [] } as any),
  } as any),
)

const Params = Schema.Struct({ value: Schema.String })

describe("tool.ts error message preservation", () => {
  test("typed Error message survives to the caller", async () => {
    const tool = Tool.define("test-err", Effect.gen(function* () {
      return {
        description: "test",
        parameters: Params,
        execute: () => Effect.fail(new Error("specific error message")),
      }
    }))

    const init = await Effect.runPromise(tool.pipe(Effect.provide(testLayers)))
    const info = await Effect.runPromise(init.init().pipe(Effect.provide(testLayers)))
    const exit = await Effect.runPromiseExit(info.execute({ value: "x" }, ctx as any).pipe(Effect.provide(testLayers)))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const { Cause } = await import("effect")
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("specific error message")
    }
  })

  test("non-Error throw is converted to Error with String()", async () => {
    const tool = Tool.define("test-throw", Effect.gen(function* () {
      return {
        description: "test",
        parameters: Params,
        execute: () => Effect.fail("string error" as any),
      }
    }))

    const init = await Effect.runPromise(tool.pipe(Effect.provide(testLayers)))
    const info = await Effect.runPromise(init.init().pipe(Effect.provide(testLayers)))
    const exit = await Effect.runPromiseExit(info.execute({ value: "x" }, ctx as any).pipe(Effect.provide(testLayers)))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const { Cause } = await import("effect")
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("string error")
    }
  })

  test("successful execution returns result normally", async () => {
    const tool = Tool.define("test-ok", Effect.gen(function* () {
      return {
        description: "test",
        parameters: Params,
        execute: () =>
          Effect.succeed({
            title: "ok",
            output: "success",
            metadata: {},
          }),
      }
    }))

    const init = await Effect.runPromise(tool.pipe(Effect.provide(testLayers)))
    const info = await Effect.runPromise(init.init().pipe(Effect.provide(testLayers)))
    const exit = await Effect.runPromiseExit(info.execute({ value: "x" }, ctx as any).pipe(Effect.provide(testLayers)))

    expect(exit._tag).toBe("Success")
  })

  test("error message is not 'undefined'", async () => {
    const tool = Tool.define("test-undef", Effect.gen(function* () {
      return {
        description: "test",
        parameters: Params,
        execute: () => Effect.fail(new Error("real message")),
      }
    }))

    const init = await Effect.runPromise(tool.pipe(Effect.provide(testLayers)))
    const info = await Effect.runPromise(init.init().pipe(Effect.provide(testLayers)))
    const exit = await Effect.runPromiseExit(info.execute({ value: "x" }, ctx as any).pipe(Effect.provide(testLayers)))

    if (exit._tag === "Failure") {
      const { Cause } = await import("effect")
      const error = Cause.squash(exit.cause)
      expect((error as Error).message).not.toBe("undefined")
      expect((error as Error).message).toBe("real message")
    }
  })
})
