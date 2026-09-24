import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { SessionWatchdog } from "../src/session/watchdog.js"
import { SessionExecution } from "../src/session/execution.js"
import { SessionStore } from "../src/session/store.js"
import type { SessionMessage } from "../src/session/message.js"

// Tool parts are plain structured records at runtime; only the branded
// session/message ids need a cast for the schema types.
const sessionId = (value: string) => value as never

const toolMessage = (tool: {
  readonly id: string
  readonly name: string
  readonly status: "streaming" | "running" | "completed" | "error"
  readonly ran?: number
}): SessionMessage.Info =>
  ({
    id: sessionId(`msg_${tool.id}`),
    type: "assistant",
    agent: sessionId("agent_build"),
    model: { providerID: "p", modelID: "m" },
    cost: { amount: "0", currency: "USD" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [
      {
        type: "tool",
        id: tool.id,
        name: tool.name,
        state: { status: tool.status, ...(tool.status === "running" ? { input: {} } : {}) },
        time: { created: DateTime.makeUnsafe(Date.now() - 400_000), ...(tool.ran !== undefined ? { ran: DateTime.makeUnsafe(tool.ran) } : {}) },
      },
    ],
    time: { created: DateTime.makeUnsafe(Date.now() - 400_000) },
  }) as unknown as SessionMessage.Info

interface Harness {
  readonly calls: Array<{ readonly sessionID: string; readonly reason?: string }>
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly active: ReadonlySet<string>
}

const harnessLayer = (input: Harness) =>
  Layer.mergeAll(
    Layer.succeed(SessionExecution.Service, {
      active: Effect.succeed(new Set(input.active)),
      isActive: (id: string) => Effect.succeed(input.active.has(id)),
      resume: () => Effect.void,
      wake: () => Effect.void,
      interrupt: (sessionID: string, options?: { readonly reason?: string }) =>
        Effect.sync(() => {
          input.calls.push({ sessionID, reason: options?.reason })
          return true
        }),
      awaitIdle: () => Effect.void,
    } as unknown as SessionExecution.Interface),
    Layer.succeed(SessionStore.Service, {
      get: () => Effect.succeed(undefined),
      context: () => Effect.succeed([...input.messages]),
    } as unknown as SessionStore.Interface),
  )

const runScan = async (input: Harness, config?: Partial<SessionWatchdog.Config>) => {
  const watchdog = await Effect.runPromise(
    SessionWatchdog.Service.pipe(Effect.provide(SessionWatchdog.layerWithConfig({
      timeoutMs: 120_000,
      scanInterval: { _tag: "Duration", millis: 60_000 } as never,
      initialDelay: { _tag: "Duration", millis: 10_000 } as never,
      exemptTools: new Set(["subagent", "task"]),
      ...config,
    })), Effect.provide(harnessLayer(input))),
  )
  await Effect.runPromise(watchdog.scanOnce)
  return input.calls
}

describe("SessionWatchdog scanOnce", () => {
  test("marks a running tool past the budget by interrupting with reason watchdog", async () => {
    const calls = await runScan({
      calls: [],
      active: new Set(["ses_stuck"]),
      messages: [toolMessage({ id: "call_1", name: "read", status: "running", ran: Date.now() - 200_000 })],
    })
    expect(calls).toEqual([{ sessionID: "ses_stuck", reason: "watchdog" }])
  })

  test("leaves fresh running tools alone", async () => {
    const calls = await runScan({
      calls: [],
      active: new Set(["ses_fresh"]),
      messages: [toolMessage({ id: "call_1", name: "read", status: "running", ran: Date.now() - 1_000 })],
    })
    expect(calls).toEqual([])
  })

  test("does not touch streaming, completed or error parts", async () => {
    const messages = [
      toolMessage({ id: "call_s", name: "read", status: "streaming" }),
      toolMessage({ id: "call_c", name: "read", status: "completed" }),
      toolMessage({ id: "call_e", name: "read", status: "error" }),
    ]
    const calls = await runScan({ calls: [], active: new Set(["ses_x"]), messages })
    expect(calls).toEqual([])
  })

  test("exempts long-running tools by name", async () => {
    const calls = await runScan({
      calls: [],
      active: new Set(["ses_task"]),
      messages: [toolMessage({ id: "call_1", name: "subagent", status: "running", ran: Date.now() - 600_000 })],
    })
    expect(calls).toEqual([])
  })

  test("ignores running tools without a ran timestamp", async () => {
    const calls = await runScan({
      calls: [],
      active: new Set(["ses_x"]),
      messages: [toolMessage({ id: "call_1", name: "read", status: "running" })],
    })
    expect(calls).toEqual([])
  })

  test("only inspects sessions this process executes", async () => {
    const calls = await runScan({
      calls: [],
      active: new Set([]),
      messages: [toolMessage({ id: "call_1", name: "read", status: "running", ran: Date.now() - 600_000 })],
    })
    expect(calls).toEqual([])
  })

  test("custom exempt tools are honored", async () => {
    const calls = await runScan(
      {
        calls: [],
        active: new Set(["ses_x"]),
        messages: [toolMessage({ id: "call_1", name: "browser", status: "running", ran: Date.now() - 600_000 })],
      },
      { exemptTools: new Set(["browser"]) },
    )
    expect(calls).toEqual([])
  })
})

describe("SessionWatchdog.loadConfig", () => {
  test("applies defaults", () => {
    const config = SessionWatchdog.loadConfig({})
    expect(config.timeoutMs).toBe(120_000)
    expect(config.exemptTools.has("subagent")).toBe(true)
    expect(config.exemptTools.has("task")).toBe(true)
  })

  test("reads env overrides", () => {
    const config = SessionWatchdog.loadConfig({
      OPENCODE_WATCHDOG_TIMEOUT_SEC: "5",
      OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC: "2",
      OPENCODE_WATCHDOG_EXEMPT_TOOLS: "browser, custom",
    })
    expect(config.timeoutMs).toBe(5_000)
    expect([...config.exemptTools]).toEqual(["browser", "custom"])
  })
})
