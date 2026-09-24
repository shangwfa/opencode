import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionStructuredOutput } from "../src/session/structured-output"
import { Tool } from "../src/tool"

const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
const created = DateTime.makeUnsafe(1)

const message = (type: "user" | "assistant", extra: Record<string, unknown> = {}): SessionMessage.Info =>
  ({
    id: SessionMessage.ID.make(type === "user" ? "msg_user" : "msg_assistant"),
    type,
    text: "hi",
    time: { created },
    ...extra,
  }) as unknown as SessionMessage.Info

const jsonSchemaFormat = { type: "json_schema", schema }

describe("SessionStructuredOutput.requestedJsonSchema", () => {
  test("reads the schema from the most recent user message", () => {
    expect(
      SessionStructuredOutput.requestedJsonSchema([
        message("user", { format: jsonSchemaFormat }),
        message("assistant"),
      ]),
    ).toEqual(schema)
  })

  test("is absent without a json_schema request", () => {
    expect(SessionStructuredOutput.requestedJsonSchema([])).toBeUndefined()
    expect(SessionStructuredOutput.requestedJsonSchema([message("assistant")])).toBeUndefined()
    expect(
      SessionStructuredOutput.requestedJsonSchema([message("user", { format: { type: "text" } })]),
    ).toBeUndefined()
  })

  test("does not leak a previous round's schema into a plain follow-up", () => {
    expect(
      SessionStructuredOutput.requestedJsonSchema([
        message("user", { format: jsonSchemaFormat }),
        message("assistant"),
        message("user"),
      ]),
    ).toBeUndefined()
  })
})

describe("SessionStructuredOutput.withTool", () => {
  const executeCall = (name: string, input: unknown) => {
    const tools = SessionStructuredOutput.withTool(
      {
        definitions: [],
        execute: () => Effect.succeed({ content: [{ type: "text" as const, text: "passed through" }] }),
      },
      schema,
    )
    return tools.execute({
      sessionID: Session.ID.make("ses_structured_test"),
      agent: Agent.ID.make("build"),
      messageID: SessionMessage.ID.make("msg_assistant"),
      call: { type: "tool-call", id: "call_1", name, input },
    })
  }

  test("advertises the forced tool alongside the existing definitions", () => {
    const tools = SessionStructuredOutput.withTool(
      { definitions: [], execute: () => Effect.succeed({ content: [] }) },
      schema,
    )
    expect(tools.definitions.map((definition) => definition.name)).toContain(
      SessionStructuredOutput.ToolName,
    )
    expect(tools.definitions.at(-1)?.inputSchema).toEqual(schema)
  })

  test("carries V1's tool contract and strips $schema from the input", () => {
    const tools = SessionStructuredOutput.withTool(
      { definitions: [], execute: () => Effect.succeed({ content: [] }) },
      { $schema: "http://json-schema.org/draft-07/schema#", ...schema },
    )
    const definition = tools.definitions.at(-1)
    expect(definition?.name).toBe("StructuredOutput")
    expect(definition?.description).toContain("call this tool exactly once at the end")
    expect(definition?.inputSchema).toEqual(schema)
    expect(definition?.inputSchema).not.toHaveProperty("$schema")
  })

  test("pins the system prompt to the same tool name", () => {
    expect(SessionStructuredOutput.SystemPrompt).toContain(SessionStructuredOutput.ToolName)
    expect(SessionStructuredOutput.SystemPrompt).toContain("MUST")
    expect(SessionStructuredOutput.SystemPrompt).toContain("Do NOT respond with plain text")
  })

  test("answers the structured call with its arguments as JSON", () => {
    const result = Effect.runSync(executeCall(SessionStructuredOutput.ToolName, { city: "北京" }))
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ city: "北京" }) }])
  })

  test("passes every other tool through untouched", () => {
    const tools = SessionStructuredOutput.withTool(
      { definitions: [], execute: () => Effect.succeed({ content: [{ type: "text" as const, text: "ok" }] }) },
      schema,
    )
    const result = Effect.runSync(
      tools.execute({
        sessionID: Session.ID.make("ses_structured_test"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_assistant"),
        call: { type: "tool-call", id: "call_2", name: "shell", input: { command: "ls" } },
      }),
    )
    expect(result.content).toEqual([{ type: "text", text: "ok" }])
  })

  test("exposes the tool name used by the projection step", () => {
    expect(SessionStructuredOutput.ToolName).toBe("StructuredOutput")
    expect(SessionStructuredOutput.isTool("StructuredOutput")).toBe(true)
    expect(SessionStructuredOutput.isTool("structured_output")).toBe(false)
    expect(SessionStructuredOutput.isTool("shell")).toBe(false)
  })
})

// Keep Tool imported for the Snapshot type in the helpers above.
const _snapshotShape: Pick<Tool.Snapshot, "definitions" | "execute"> | undefined = undefined
void _snapshotShape
