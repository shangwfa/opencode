import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLMEvent } from "@opencode-ai/llm"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { createLLMEventPublisher } from "@opencode-ai/core/session/runner/publish-llm-event"

const sessionID = SessionV2.ID.make("ses_fail_unsettled_test")

const capture = () => {
  const published: Array<{ readonly type: string; readonly data: any }> = []
  const events = EventV2.Service.of({
    publish: (definition, data) =>
      Effect.sync(() => {
        const event = { id: EventV2.ID.create(), type: definition.type, data } as EventV2.Payload<typeof definition>
        published.push({
          type: definition.durable
            ? EventV2.versionedType(definition.type, definition.durable.version)
            : definition.type,
          data,
        })
        return event
      }),
    subscribe: () => Stream.empty,
    all: () => Stream.empty,
    durable: () => Stream.empty,
    listen: () => Effect.succeed(Effect.void),
    project: () => Effect.void,
    replay: () => Effect.void,
    replayAll: () => Effect.succeed(undefined),
    remove: () => Effect.void,
    claim: () => Effect.void,
  })
  return {
    published,
    publisher: createLLMEventPublisher(events, {
      sessionID,
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
    }),
  }
}

const failedEvents = (published: Array<{ readonly type: string; readonly data: any }>) =>
  published.filter((event) => event.type.startsWith("session.next.tool.failed"))

/**
 * Regression for ses_f70e676f1ffe: the provider stream dropped the argument
 * deltas after tool-input-start, the stream then ended successfully, and the
 * never-called write call stayed pending forever. hostedOnly must still fail
 * such calls.
 */
test("hostedOnly fails a tool whose input stream never completed (never called)", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call_dropped", name: "write" })))
  await Effect.runPromise(publisher.publish(LLMEvent.stepFinish({ index: 0, reason: "stop" })))

  await Effect.runPromise(publisher.failUnsettledTools("Provider did not return a tool result", true))

  const failures = failedEvents(published)
  expect(failures).toHaveLength(1)
  expect(failures[0].data).toMatchObject({
    callID: "call_dropped",
    error: { message: "Provider did not return a tool result" },
    provider: { executed: false },
  })
})

test("hostedOnly skips a called host-executed tool awaiting settlement", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolCall({ id: "call_host", name: "bash", input: { command: "ls" } })),
  )
  await Effect.runPromise(publisher.failUnsettledTools("Provider did not return a tool result", true))
  expect(failedEvents(published)).toHaveLength(0)
})

test("hostedOnly fails a called provider-executed tool left without a result", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolCall({ id: "call_hosted", name: "web_search", input: { query: "x" }, providerExecuted: true }),
    ),
  )
  await Effect.runPromise(publisher.failUnsettledTools("Provider did not return a tool result", true))
  const failures = failedEvents(published)
  expect(failures).toHaveLength(1)
  expect(failures[0].data).toMatchObject({ callID: "call_hosted", provider: { executed: true } })
})

test("hostedOnly skips already settled tools", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolCall({ id: "call_done", name: "read", input: { filePath: "/a" } })),
  )
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: "call_done",
        name: "read",
        result: { type: "content", value: [{ type: "text", text: "ok" }] },
      }),
    ),
  )
  await Effect.runPromise(publisher.failUnsettledTools("Provider did not return a tool result", true))
  expect(failedEvents(published)).toHaveLength(0)
})

test("non-hosted mode fails every unsettled tool regardless of call state", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call_uncalled", name: "write" })))
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolCall({ id: "call_host", name: "bash", input: { command: "ls" } })),
  )
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call_uncalled_2", name: "edit" })))
  await Effect.runPromise(publisher.failUnsettledTools("Tool execution interrupted"))

  const failures = failedEvents(published)
  expect(failures).toHaveLength(3)
  expect(new Set(failures.map((event) => event.data.callID))).toEqual(
    new Set(["call_uncalled", "call_host", "call_uncalled_2"]),
  )
})

test("mixed turn: settled read passes through while dropped write is failed", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(
    publisher.publish(LLMEvent.toolCall({ id: "call_read", name: "read", input: { filePath: "/a" } })),
  )
  await Effect.runPromise(
    publisher.publish(
      LLMEvent.toolResult({
        id: "call_read",
        name: "read",
        result: { type: "content", value: [{ type: "text", text: "contents" }] },
      }),
    ),
  )
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call_write", name: "write" })))
  await Effect.runPromise(publisher.failUnsettledTools("Provider did not return a tool result", true))

  const failures = failedEvents(published)
  expect(failures).toHaveLength(1)
  expect(failures[0].data).toMatchObject({ callID: "call_write" })
  expect(published.some((event) => event.type.startsWith("session.next.tool.success"))).toBe(true)
})

test("failure events publish the fallback error text for tools without provider metadata", async () => {
  const { published, publisher } = capture()
  await Effect.runPromise(publisher.publish(LLMEvent.toolInputStart({ id: "call_bare", name: "grep" })))
  await Effect.runPromise(publisher.failUnsettledTools("stream ended", true))
  const failure = failedEvents(published)[0]
  expect(failure.data).toMatchObject({
    sessionID,
    callID: "call_bare",
    error: { type: "unknown", message: "stream ended" },
    provider: { executed: false },
  })
  expect(failure.data.assistantMessageID).toBeTruthy()
})
