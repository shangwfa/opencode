import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OutputFormat } from "../src/output-format.js"
import { PromptInput } from "../src/prompt-input.js"
import { SessionInbox } from "../src/session-inbox.js"
import { SessionMessage } from "../src/session-message.js"

const jsonSchema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }

describe("OutputFormat", () => {
  test("accepts text and json_schema only", () => {
    const decode = Schema.decodeUnknownSync(OutputFormat.Format)
    expect(decode({ type: "text" })).toEqual({ type: "text" })
    expect(decode({ type: "json_schema", schema: jsonSchema })).toEqual({ type: "json_schema", schema: jsonSchema })
    // TSO.5 variant 1: an unknown discriminator is a payload error.
    expect(() => decode({ type: "xml" })).toThrow()
    expect(() => decode({ type: "json_schema", schema: 42 })).toThrow()
    expect(() => decode({})).toThrow()
  })

  test("treats retryCount as a non-negative counter", () => {
    const decode = Schema.decodeUnknownSync(OutputFormat.Format)
    expect(decode({ type: "json_schema", schema: jsonSchema, retryCount: 0 })).toMatchObject({ retryCount: 0 })
    expect(decode({ type: "json_schema", schema: jsonSchema, retryCount: 2 })).toMatchObject({ retryCount: 2 })
    expect(() => decode({ type: "json_schema", schema: jsonSchema, retryCount: -1 })).toThrow()
  })

  test("encodes a plain stored object rather than a class instance (V1 400 regression)", () => {
    // V1 modeled this as a Schema.Class union, so HTTP encoding only accepted class instances and
    // a stored JSON object read back as 400. The Struct form must round-trip as-is.
    const stored = { type: "json_schema", schema: jsonSchema } as const
    expect(Schema.decodeUnknownSync(OutputFormat.Format)(stored)).toEqual(stored)
    expect(Schema.encodeSync(OutputFormat.Format)(Schema.decodeUnknownSync(OutputFormat.Format)(stored))).toEqual(
      stored,
    )
  })

  test("carries format on prompts, inbox payloads, and stored user messages, omitting when absent", () => {
    const promptDecode = Schema.decodeUnknownSync(PromptInput.Prompt)
    const promptEncode = Schema.encodeSync(PromptInput.Prompt)
    const inboxDecode = Schema.decodeUnknownSync(SessionInbox.UserPayload)
    const inboxEncode = Schema.encodeSync(SessionInbox.UserPayload)
    const userDecode = Schema.decodeUnknownSync(SessionMessage.User)
    const userEncode = Schema.encodeSync(SessionMessage.User)
    const base = { text: "hello" }

    expect(promptEncode(promptDecode(base))).toEqual(base)
    expect(inboxEncode(inboxDecode(base))).toEqual(base)
    expect(userEncode(userDecode({ id: "msg_user", type: "user", text: "hello", time: { created: 1 } }))).toEqual({
      id: "msg_user",
      type: "user",
      text: "hello",
      time: { created: 1 },
    })

    const format = { type: "json_schema", schema: jsonSchema } as const
    expect(promptEncode(promptDecode({ ...base, format }))).toEqual({ ...base, format })
    expect(inboxEncode(inboxDecode({ ...base, format }))).toEqual({ ...base, format })
    expect(
      userEncode(
        userDecode({
          id: "msg_user",
          type: "user",
          text: "hello",
          format,
          time: { created: 1 },
        }),
      ),
    ).toEqual({ id: "msg_user", type: "user", text: "hello", format, time: { created: 1 } })

    expect(() => promptDecode({ ...base, format: { type: "xml", schema: jsonSchema } })).toThrow()
  })

  test("carries the parsed structured value on assistant messages", () => {
    const decode = Schema.decodeUnknownSync(SessionMessage.Assistant)
    const encode = Schema.encodeSync(SessionMessage.Assistant)
    const base = {
      id: "msg_assistant",
      type: "assistant" as const,
      agent: "build" as const,
      model: { providerID: "p", id: "m" } as SessionMessage.Assistant["model"],
      content: [{ type: "text" as const, text: "ok" }],
      time: { created: 1 },
    }

    expect(encode(decode(base))).toEqual(base)

    const structured = { answer: true, city: "北京" }
    expect(encode(decode({ ...base, structured }))).toEqual({ ...base, structured })
    expect(encode(decode({ ...base, structured: "北京" }))).toEqual({ ...base, structured: "北京" })
    // `Schema.Json` only admits JSON values; the decode target is `unknown`, so these are runtime checks.
    expect(() => decode({ ...base, structured: () => 1 })).toThrow()
    expect(() => decode({ ...base, structured: { createdAt: new Date() } })).toThrow()
  })

  test("narrows json_schema through the predicate", () => {
    expect(OutputFormat.isJsonSchema(undefined)).toBe(false)
    expect(OutputFormat.isJsonSchema({ type: "text" })).toBe(false)
    expect(OutputFormat.isJsonSchema({ type: "json_schema", schema: jsonSchema })).toBe(true)
  })
})
