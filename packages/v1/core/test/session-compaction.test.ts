import { expect, test } from "bun:test"
import { LLM, LLMEvent, Message, Model } from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { DateTime, Effect, Stream } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { EventV2 } from "@opencode-ai/core/event"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

const created = DateTime.makeUnsafe(0)
const modelRef = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const assistant = (content: SessionMessage.Assistant["content"]) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build",
    model: modelRef,
    content,
    time: { created, completed: created },
  })
const tool = (output: string) =>
  SessionMessage.AssistantTool.make({
    type: "tool",
    id: "tool-1",
    name: "shell",
    state: SessionMessage.ToolStateCompleted.make({
      status: "completed",
      input: { command: "cat huge.txt" },
      content: [{ type: "text", text: output }],
      structured: {},
    }),
    time: { created, completed: created },
  })

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction writes the compacted history to a file and reports historyPath", async () => {
  const historyDir = await mkdtemp(join(tmpdir(), "opencode-compaction-"))
  const writes = new Map<string, string>()
  const fs = {
    ensureDir: () => Effect.void,
    writeFileString: (file: string, text: string) =>
      Effect.sync(() => {
        writes.set(file, text)
      }),
  } as unknown as FSUtil.Interface

  let ended: { reason: string; text: string; recent: string; historyPath: string | undefined } | undefined
  const events = {
    publish: (definition: { type: string }, data: unknown) =>
      Effect.sync(() => {
        if (definition.type === "session.next.compaction.ended") ended = data as typeof ended
      }),
  } as unknown as EventV2.Interface

  const llm = {
    stream: () => Stream.succeed(LLMEvent.textDelta({ id: "t-1", text: "## Objective\n- test summary" })),
  }

  const model = Model.make({
    id: "fake-model",
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context: 500_000, output: 500 } }),
  })
  const entries = Array.from({ length: 12 }, (_, i) => ({
    seq: i + 1,
    message: SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: `Message ${i} ` + "x".repeat(4_000),
      time: { created: DateTime.makeUnsafe(0) },
    }),
  }))

  const result = await Effect.runPromise(
    SessionCompaction.make({
      events,
      llm,
      config: [],
      fs,
      historyDir,
    }).compactAfterOverflow({
      sessionID: SessionSchema.ID.make("ses_test"),
      entries,
      model,
      request: LLM.request({ model, messages: [Message.user("test")], generation: { maxTokens: 500 } }),
    }),
  )

  expect(result).toBe(true)
  expect(ended).toBeDefined()
  expect(ended!.historyPath).toBeDefined()
  expect(ended!.historyPath!.startsWith(historyDir)).toBe(true)
  expect(ended!.historyPath).toMatch(/tool_history_msg_.+\.md$/)
  const text = writes.get(ended!.historyPath!)
  expect(text).toBeDefined()
  expect(text).toContain("## msg_")
  expect(text).toContain("[User]: Message 0")
  expect(text).not.toContain("Message 11")
  expect(ended!.recent).toContain("Message 11")
})

test("compaction links the prior history file when compacted repeatedly", async () => {
  const historyDir = await mkdtemp(join(tmpdir(), "opencode-compaction-"))
  const writes = new Map<string, string>()
  const fs = {
    ensureDir: () => Effect.void,
    writeFileString: (file: string, text: string) =>
      Effect.sync(() => {
        writes.set(file, text)
      }),
  } as unknown as FSUtil.Interface
  let historyPath: string | undefined
  const events = {
    publish: (definition: { type: string }, data: { historyPath?: string }) =>
      Effect.sync(() => {
        if (definition.type === "session.next.compaction.ended") historyPath = data.historyPath
      }),
  } as unknown as EventV2.Interface
  const model = Model.make({
    id: "fake-model",
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context: 500_000, output: 500 } }),
  })
  const previousHistoryPath = "/data/tool-output/tool_history_msg_previous.md"
  const entries = [
    {
      seq: 1,
      message: SessionMessage.Compaction.make({
        id: SessionMessage.ID.create(),
        type: "compaction",
        reason: "auto",
        summary: "previous summary",
        recent: "previous recent context",
        historyPath: previousHistoryPath,
        time: { created },
      }),
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      seq: index + 2,
      message: SessionMessage.User.make({
        id: SessionMessage.ID.create(),
        type: "user",
        text: `Message ${index} ${"x".repeat(20_000)}`,
        time: { created },
      }),
    })),
  ]

  const result = await Effect.runPromise(
    SessionCompaction.make({
      events,
      llm: { stream: () => Stream.succeed(LLMEvent.textDelta({ id: "t-1", text: "## Objective\n- test summary" })) },
      config: [],
      fs,
      historyDir,
    }).compactAfterOverflow({
      sessionID: SessionSchema.ID.make("ses_test"),
      entries,
      model,
      request: LLM.request({ model, messages: [Message.user("test")], generation: { maxTokens: 500 } }),
    }),
  )

  expect(result).toBe(true)
  expect(historyPath).toBeDefined()
  expect(writes.get(historyPath!)).toContain(previousHistoryPath)
})

test("serializeHistory includes the complete tool output without truncation", () => {
  const output = "x".repeat(5_000)
  const out = SessionCompaction.serializeHistory(assistant([tool(output)]))

  expect(out).toContain(`[Assistant tool call]: shell({"command":"cat huge.txt"})`)
  expect(out).toContain(output)
  expect(out).not.toContain("[truncated]")
})

test("serialize truncates tool output unless full is requested", () => {
  const output = "y".repeat(5_000)
  const message = assistant([tool(output)])

  const full = SessionCompaction.serialize(message, true)
  const compacted = SessionCompaction.serialize(message)

  expect(full).toContain(output)
  expect(compacted).not.toContain(output)
  expect(compacted).toContain("[truncated]")
})

test("serializeHistory keeps shell output complete", () => {
  const shell = SessionMessage.Shell.make({
    id: SessionMessage.ID.make("msg_sh"),
    type: "shell",
    callID: "sh-1",
    command: "echo hi",
    output: "hi",
    time: { created, completed: created },
  })

  const out = SessionCompaction.serializeHistory(shell)
  expect(out).toContain(`## msg_sh | shell | 1970-01-01T00:00:00.000Z`)
  expect(out).toContain("[Shell]: echo hi\nhi")
})

test("compaction degrades gracefully when writing history fails", async () => {
  const historyDir = await mkdtemp(join(tmpdir(), "opencode-compaction-"))
  const fs = {
    ensureDir: () => Effect.void,
    writeFileString: () => Effect.fail(new Error("disk full")),
  } as unknown as FSUtil.Interface

  let ended: { reason: string; text: string; recent: string; historyPath: string | undefined } | undefined
  const events = {
    publish: (definition: { type: string }, data: unknown) =>
      Effect.sync(() => {
        if (definition.type === "session.next.compaction.ended") ended = data as typeof ended
      }),
  } as unknown as EventV2.Interface

  const llm = {
    stream: () => Stream.succeed(LLMEvent.textDelta({ id: "t-1", text: "## Objective\n- test summary" })),
  }

  const model = Model.make({
    id: "fake-model",
    provider: "fake",
    route: OpenAIChat.route.with({ limits: { context: 500_000, output: 500 } }),
  })
  const entries = Array.from({ length: 12 }, (_, i) => ({
    seq: i + 1,
    message: SessionMessage.User.make({
      id: SessionMessage.ID.create(),
      type: "user",
      text: `Message ${i} ` + "x".repeat(4_000),
      time: { created: DateTime.makeUnsafe(0) },
    }),
  }))

  const result = await Effect.runPromise(
    SessionCompaction.make({
      events,
      llm,
      config: [],
      fs,
      historyDir,
    }).compactAfterOverflow({
      sessionID: SessionSchema.ID.make("ses_test"),
      entries,
      model,
      request: LLM.request({ model, messages: [Message.user("test")], generation: { maxTokens: 500 } }),
    }),
  )

  expect(result).toBe(true)
  expect(ended).toBeDefined()
  expect(ended!.text).toBe("## Objective\n- test summary")
  expect(ended!.historyPath).toBeUndefined()
})

test("message-updater propagates historyPath to the projected compaction message", async () => {
  const state = { messages: [] as SessionMessage.Message[] }
  const adapter = SessionMessageUpdater.memory(state)
  const messageID = SessionMessage.ID.create()
  const sessionID = SessionSchema.ID.make("ses_test")

  await Effect.runPromise(
    SessionMessageUpdater.update(
      adapter,
      SessionEvent.Compaction.Ended.make({
        id: Event.ID.create(),
        type: "session.next.compaction.ended",
        data: {
          sessionID,
          timestamp: created,
          messageID,
          reason: "auto",
          text: "summary",
          recent: "recent context",
          historyPath: "/data/tool-output/tool_history_msg_x.md",
        },
      }),
    ),
  )

  const message = state.messages[0]
  expect(message?.type).toBe("compaction")
  if (message?.type === "compaction") {
    expect(message.historyPath).toBe("/data/tool-output/tool_history_msg_x.md")
  }
})

test("message-updater omits historyPath when the event has none", async () => {
  const state = { messages: [] as SessionMessage.Message[] }
  const adapter = SessionMessageUpdater.memory(state)
  const messageID = SessionMessage.ID.create()
  const sessionID = SessionSchema.ID.make("ses_test")

  await Effect.runPromise(
    SessionMessageUpdater.update(
      adapter,
      SessionEvent.Compaction.Ended.make({
        id: Event.ID.create(),
        type: "session.next.compaction.ended",
        data: {
          sessionID,
          timestamp: created,
          messageID,
          reason: "auto",
          text: "summary",
          recent: "recent context",
        },
      }),
    ),
  )

  const message = state.messages[0]
  expect(message?.type).toBe("compaction")
  if (message?.type === "compaction") {
    expect(message.historyPath).toBeUndefined()
  }
})
