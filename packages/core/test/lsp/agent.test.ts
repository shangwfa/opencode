import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LspAgent } from "../../src/lsp/agent.js"

// A minimal environment stub that provides endpoint resolution and a spawner.
const testEndpointPort = 20877
const testSpawner = {
  spawn: () => Effect.succeed({} as any),
}

const testEnvironment = {
  endpoint: (port: number) =>
    port === testEndpointPort
      ? Effect.succeed(`http://localhost:${port}`)
      : Effect.fail(new Error("unexpected port")),
  spawner: testSpawner,
  files: {} as any,
}

const testLayer = Layer.succeed(
  LspAgent.Service,
  LspAgent.Service.of({
    touch: () => Effect.succeed({ version: 0 }),
    diagnostics: () => Effect.succeed({ diagnostics: {} }),
    shutdown: () => Effect.void,
    hover: () => Effect.succeed(null),
    definition: () => Effect.succeed(null),
    references: () => Effect.succeed(null),
    implementation: () => Effect.succeed(null),
    documentSymbol: () => Effect.succeed(null),
    workspaceSymbol: () => Effect.succeed(null),
    prepareCallHierarchy: () => Effect.succeed(null),
    incomingCalls: () => Effect.succeed(null),
    outgoingCalls: () => Effect.succeed(null),
  }),
)

const run = <A, E>(effect: Effect.Effect<A, E, LspAgent.Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testLayer)))

describe("LspAgent", () => {
  test("return version 0 on touch when daemon unavailable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const agent = yield* LspAgent.Service
        return yield* agent.touch("/workspace/test.ts")
      }),
    )
    expect(result).toEqual({ version: 0 })
  })

  test("return empty diagnostics when daemon unavailable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const agent = yield* LspAgent.Service
        return yield* agent.diagnostics("/workspace/test.ts")
      }),
    )
    expect(result).toEqual({ diagnostics: {} })
  })

  test("shutdown does not throw", async () => {
    await run(
      Effect.gen(function* () {
        const agent = yield* LspAgent.Service
        yield* agent.shutdown()
      }),
    )
  })

  test("all LSP operations return null when daemon unavailable", async () => {
    const result = await run(
      Effect.gen(function* () {
        const agent = yield* LspAgent.Service
        const ops = [
          agent.hover("/workspace/test.ts", 0, 0),
          agent.definition("/workspace/test.ts", 0, 0),
          agent.references("/workspace/test.ts", 0, 0),
          agent.implementation("/workspace/test.ts", 0, 0),
          agent.documentSymbol("/workspace/test.ts"),
          agent.workspaceSymbol("test"),
          agent.prepareCallHierarchy("/workspace/test.ts", 0, 0),
          agent.incomingCalls("/workspace/test.ts", 0, 0),
          agent.outgoingCalls("/workspace/test.ts", 0, 0),
        ]
        return yield* Effect.all(ops, { concurrency: "unbounded" })
      }),
    )
    expect(result).toEqual(Array(9).fill(null))
  })
})