import { SessionV1 } from "@opencode-ai/core/v1/session"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "@/event-v2-bridge"
import { expect, beforeAll, afterAll } from "bun:test"
import postgres from "postgres"
import { Effect, Layer, Stream } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Provider } from "@/provider/provider"

import { Session } from "@/session/session"
import { LLM } from "../../src/session/llm"
import { AntiLoop } from "../../src/session/anti-loop"
import { MessageV2 } from "@/session/message-v2"
import { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { LLMEvent } from "@opencode-ai/llm"
import { pgDatabaseLayer } from "@/storage/db-core-bridge"

// Same convention as processor-tool-input-stream.test.ts: the core SQLite
// baseline lags the PG schema, so this suite runs on the SaaS PG bridge.
// Point OPENCODE_DATABASE_URL at a disposable local database (opencode_test).
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

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

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

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
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

// Emulates the wire shape produced when tools.ts invoke throws LoopAbortedError
// (anti-loop fatal): AI SDK emits tool-error with the original error instance.
const toolErrorLLM = (error: unknown) =>
  Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: () =>
        Stream.make(
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-1", name: "probe" }),
          LLMEvent.toolInputEnd({ id: "call-1", name: "probe" }),
          LLMEvent.toolCall({ id: "call-1", name: "probe", input: { q: "x" } }),
          LLMEvent.toolError({
            id: "call-1",
            name: "probe",
            message: "tool failed",
            error,
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ),
    }),
  )

const abortedErrorEnv = LayerNode.compile(root, [
  ...replacements,
  [
    LLM.node,
    toolErrorLLM(new AntiLoop.LoopAbortedError({ reason: "anti-loop: re-issued blocked call" })),
  ],
])
const itAborted = testEffect(abortedErrorEnv)
const liveAborted = pgEnabled ? itAborted.live : itAborted.live.skip

const plainErrorEnv = LayerNode.compile(root, [
  ...replacements,
  [LLM.node, toolErrorLLM(new Error("ordinary tool failure"))],
])
const itPlain = testEffect(plainErrorEnv)
const livePlain = pgEnabled ? itPlain.live : itPlain.live.skip

// CorrectedError is the permission "deny with feedback" affordance: upstream
// keeps the run alive so the model can act on the feedback. Locks the boundary
// against accidentally routing it into the run-stopping path.
const correctedErrorEnv = LayerNode.compile(root, [
  ...replacements,
  [
    LLM.node,
    toolErrorLLM(new PermissionV1.CorrectedError({ feedback: "use a different approach" })),
  ],
])
const itCorrected = testEffect(correctedErrorEnv)
const liveCorrected = pgEnabled ? itCorrected.live : itCorrected.live.skip

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

liveAborted("LoopAbortedError from a tool fails the call and stops the run", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        cleanup.push(chat.id)
        const parent = yield* user(chat.id, "anti-loop aborted")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
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
          messages: [{ role: "user", content: "anti-loop aborted" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("stop")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).toContain("anti-loop: re-issued blocked call")
        }
      }),
    { config: cfg },
  ),
)

liveAborted(
  "LoopAbortedError stops the run even with continue_loop_on_deny enabled",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { processors, session, provider } = yield* boot()

          const chat = yield* session.create({})
          cleanup.push(chat.id)
          const parent = yield* user(chat.id, "anti-loop aborted deny-continue")
          const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
          const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
          const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

          const value = yield* handle.process({
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
            messages: [{ role: "user", content: "anti-loop aborted deny-continue" }],
            tools: {},
          })

          // With continue_loop_on_deny a permission RejectedError would keep the
          // loop running (shouldBreak=false); an anti-loop abort must still stop.
          expect(value).toBe("stop")
        }),
      { config: { ...cfg, experimental: { continue_loop_on_deny: true } } as typeof cfg },
    ),
)

livePlain("an ordinary tool error fails the call but keeps the run going", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        cleanup.push(chat.id)
        const parent = yield* user(chat.id, "anti-loop plain")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
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
          messages: [{ role: "user", content: "anti-loop plain" }],
          tools: {},
        })

        expect(value).toBe("continue")
        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(call?.state.status).toBe("error")
        if (call?.state.status === "error") {
          expect(call.state.error).not.toContain("anti-loop")
        }
      }),
    { config: cfg },
  ),
)

liveCorrected("a permission CorrectedError (deny with feedback) keeps the run alive", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        const chat = yield* session.create({})
        cleanup.push(chat.id)
        const parent = yield* user(chat.id, "anti-loop corrected")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({ assistantMessage: msg, sessionID: chat.id, model: mdl })

        const value = yield* handle.process({
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
          messages: [{ role: "user", content: "anti-loop corrected" }],
          tools: {},
        })

        const parts = yield* MessageV2.parts(msg.id)
        const call = parts.find((part): part is SessionV1.ToolPart => part.type === "tool")

        expect(value).toBe("continue")
        expect(call?.state.status).toBe("error")
      }),
    { config: cfg },
  ),
)
