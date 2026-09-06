import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { expect, beforeAll, afterAll } from "bun:test"
import { tool } from "ai"
import postgres from "postgres"
import { Effect, Fiber, Layer, Stream } from "effect"
import path from "path"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { LLMEvent } from "@opencode-ai/llm"
import { pgDatabaseLayer } from "@/storage/db-core-bridge"

// The core SQLite baseline lags the PG schema (session.pvc_mode etc.), so this
// suite runs on the SaaS PG bridge instead. Point OPENCODE_DATABASE_URL at a
// disposable local database (opencode_test) — same convention as watchdog-pg.
const DB_URL = process.env.OPENCODE_DATABASE_URL
const pgEnabled = (() => {
  if (!DB_URL) return false
  const url = new URL(DB_URL)
  return ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/opencode_test"
})()

const cleanup: string[] = []

if (pgEnabled) {
  beforeAll(async () => {
    const { initialize } = await import("../../src/storage/db")
    await initialize()
  })
  afterAll(async () => {
    if (cleanup.length === 0) return
    const client = postgres(DB_URL!)
    await client`DELETE FROM part WHERE session_id = ANY(${cleanup})`
    await client`DELETE FROM message WHERE session_id = ANY(${cleanup})`
    await client`DELETE FROM session WHERE id = ANY(${cleanup})`
    await client.end()
  })
}

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ModelV2.ID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const chunk = (delta: Record<string, unknown>, finish?: string) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
})

const toolStart = (index: number, id: string, name: string) =>
  chunk({ tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] })

const toolArgs = (index: number, value: string) =>
  chunk({ tool_calls: [{ index, function: { arguments: value } }] })

const finish = (reason: string) => chunk({}, reason)

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const lookupTool = tool({
  description: "Look up information",
  inputSchema: z.object({ query: z.string() }),
  execute: async (input) => ({
    title: "Weather lookup",
    output: `result:${input.query}`,
    metadata: { source: "test" },
  }),
})

type RawDelta = { seq: number; partID: string; delta: string }

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  const events = yield* EventV2Bridge.Service
  return { processors, session, provider, events }
})

const root = LayerNode.group([
  SessionProcessor.node,
  Session.node,
  SessionProjector.node,
  Provider.node,
  Database.node,
  EventV2Bridge.node,
  SessionStatus.node,
  CrossSpawnSpawner.node,
])
const replacements = [
  [LocationServiceMap.node, locationServiceMapLayer],
  [Database.node, pgDatabaseLayer],
  [SessionSummary.node, summary],
  [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
] as const
const env = LayerNode.compile(
  LayerNode.group([root, LayerNode.make({ service: TestLLMServer, layer: TestLLMServer.layer, deps: [] })]),
  replacements,
)

const it = testEffect(env)
const live = pgEnabled ? it.live : it.live.skip

const providerToolLLM = Layer.succeed(
  LLM.Service,
  LLM.Service.of({
    stream: () =>
      Stream.make(
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolInputStart({ id: "call-1", name: "lookup" }),
        LLMEvent.toolInputEnd({ id: "call-1", name: "lookup" }),
        LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {}, providerExecuted: true }),
        LLMEvent.toolResult({
          id: "call-1",
          name: "lookup",
          result: {
            type: "json",
            value: { title: "Executed", output: "provider did it", metadata: {} },
          },
          providerExecuted: true,
        }),
        LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        LLMEvent.finish({ reason: "stop" }),
      ),
  }),
)
const providerToolEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, providerToolLLM],
])
const itProviderTool = testEffect(providerToolEnv)
const liveProviderTool = pgEnabled ? itProviderTool.live : itProviderTool.live.skip

/** Collects live raw PartDelta events (field=raw) plus the arrival index of the running-state tool part update. */
function trackToolInput(events: EventV2.Interface) {
  const deltas: RawDelta[] = []
  const runningAt: Record<string, number> = {}
  let seq = 0
  const listen = Effect.gen(function* () {
    const off = yield* events.listen((evt) => {
      const index = ++seq
      if (evt.type === MessageV2.Event.PartDelta.type) {
        const data = evt.data as { partID: string; field: string; delta: string }
        if (data.field === "raw") deltas.push({ seq: index, partID: data.partID, delta: data.delta })
        return Effect.void
      }
      if (evt.type === MessageV2.Event.PartUpdated.type) {
        const part = (evt.data as { part?: SessionV1.Part }).part
        if (part?.type === "tool" && part.state.status === "running") runningAt[part.id] = index
      }
      return Effect.void
    })
    return off
  })
  return { deltas, runningAt, listen }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

live("tool input stream flushes throttled raw deltas and finalizes with parsed input", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider, events } = yield* boot()
        const gate = defer<void>()
        const tracker = trackToolInput(events)

        // head: tool start + 2 arg fragments (first flushes immediately, second buffers)
        // gate: >200ms pause so the third fragment is time-flushed separately
        // tail: last fragment + tool_calls finish
        yield* llm.push(
          raw({
            head: [toolStart(0, "call_1", "lookup"), toolArgs(0, '{"qu'), toolArgs(0, 'ery":')],
            wait: gate.promise,
            tail: [toolArgs(0, '"weather"}'), finish("tool_calls")],
          }),
        )

        const chat = yield* session.create({})
        cleanup.push(chat.id)
        const parent = yield* user(chat.id, "stream tool args")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* tracker.listen
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const run = yield* handle
          .process({
            user: {
              id: parent.id,
              sessionID: chat.id,
              role: "user",
              time: parent.time,
              agent: parent.agent,
              model: { providerID: ref.providerID, modelID: ref.modelID },
            } satisfies SessionV1.User,
            sessionID: chat.id,
            model: mdl,
            agent: agent(),
            system: [],
            messages: [{ role: "user", content: "stream tool args" }],
            tools: { lookup: lookupTool },
          })
          .pipe(Effect.forkChild)

        yield* Effect.sleep("300 millis")
        gate.resolve()
        yield* Fiber.await(run)
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(tracker.deltas.length).toBe(2)
        expect(tracker.deltas.map((d) => d.delta)).toEqual(['{"qu', 'ery":"weather"}'])
        expect(tracker.deltas.every((d) => d.partID === call?.id)).toBe(true)
        expect(tracker.deltas.every((d) => d.seq < (tracker.runningAt[call?.id ?? ""] ?? -1))).toBe(true)
        expect(call?.state.status).toBe("completed")
        if (call?.state.status === "completed") {
          expect(call.state.input).toEqual({ query: "weather" })
          expect(call.state.output).toBe("result:weather")
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

live("tool input stream flushes the buffered tail on tool-input-end", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider, events } = yield* boot()
        const tracker = trackToolInput(events)

        // Six fragments pushed as fast as the mock allows: the first flushes on
        // arrival, the rest buffer under the 200ms window and must be flushed
        // once by tool-input-end, so the concatenated stream stays complete.
        const fragments = ['{"', 'query', '":', '"en', 'dless', '"}']
        yield* llm.push(
          raw({
            head: [toolStart(0, "call_1", "lookup"), ...fragments.map((f) => toolArgs(0, f))],
            tail: [finish("tool_calls")],
          }),
        )

        const chat = yield* session.create({})
        cleanup.push(chat.id)
        const parent = yield* user(chat.id, "tail flush")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* tracker.listen
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "tail flush" }],
          tools: { lookup: lookupTool },
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        const joined = tracker.deltas.map((d) => d.delta).join("")

        expect(tracker.deltas.length).toBeGreaterThanOrEqual(2)
        expect(joined).toBe('{"query":"endless"}')
        expect(call?.state.status).toBe("completed")
        if (call?.state.status === "completed") expect(call.state.input).toEqual({ query: "endless" })
        // Raw stream must not persist: completed parts carry no raw field.
        expect(JSON.stringify(parts)).not.toContain('"raw"')
      }),
    { config: (url) => providerCfg(url) },
  ),
)

live("tool input stream keeps deltas isolated across consecutive tool calls", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider, events } = yield* boot()
        const tracker = trackToolInput(events)

        // Two tool calls in one step, distinguished by tool_calls index.
        yield* llm.push(
          raw({
            head: [
              toolStart(0, "call_1", "lookup"),
              toolArgs(0, '{"query":"a"}'),
              toolStart(1, "call_2", "lookup"),
              toolArgs(1, '{"query":"b"}'),
            ],
            tail: [finish("tool_calls")],
          }),
        )

        const chat = yield* session.create({})
        cleanup.push(chat.id)
        const parent = yield* user(chat.id, "two calls")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* tracker.listen
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "two calls" }],
          tools: { lookup: lookupTool },
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const calls = parts.filter((part): part is SessionV1.ToolPart => part.type === "tool")
        const byPart = new Map(calls.map((part) => [part.id, part.state]))

        expect(calls.length).toBe(2)
        for (const part of calls) {
          const state = byPart.get(part.id)
          expect(state?.status).toBe("completed")
          if (state?.status !== "completed") continue
          const joined = tracker.deltas
            .filter((d) => d.partID === part.id)
            .map((d) => d.delta)
            .join("")
          expect(joined).toBe(JSON.stringify(state.input))
          expect(tracker.deltas.filter((d) => d.partID === part.id).length).toBeGreaterThanOrEqual(1)
        }
      }),
    { config: (url) => providerCfg(url) },
  ),
)

liveProviderTool("tool input stream emits no raw deltas without input fragments", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider, events } = yield* boot()
        const tracker = trackToolInput(events)

        const chat = yield* session.create({})
        cleanup.push(chat.id)
        const parent = yield* user(chat.id, "no fragments")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const off = yield* tracker.listen
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies SessionV1.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "no fragments" }],
          tools: {},
        })
        yield* off

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(tracker.deltas).toEqual([])
        expect(call?.state.status).toBe("completed")
        if (call?.state.status === "completed") expect(call.state.output).toBe("provider did it")
      }),
    { config: cfg },
  ),
)
