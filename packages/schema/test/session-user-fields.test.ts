import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionInbox } from "../src/session-inbox.js"
import { SessionMessage } from "../src/session-message.js"

test("user identity fields are optional, validated strings, and round-trip on inbox payloads", () => {
  const decode = Schema.decodeUnknownSync(SessionInbox.UserPayload)
  const encode = Schema.encodeSync(SessionInbox.UserPayload)

  expect(encode(decode({ text: "hello" }))).toEqual({ text: "hello" })
  expect(
    encode(
      decode({
        text: "hello",
        userName: "alice",
        userId: "user-123",
      }),
    ),
  ).toEqual({ text: "hello", userName: "alice", userId: "user-123" })
  expect(() => decode({ text: "hello", userName: 42 })).toThrow()
  expect(() => decode({ text: "hello", userId: null })).toThrow()
})

test("user identity fields round-trip on persisted session messages and omit when absent", () => {
  const decode = Schema.decodeUnknownSync(SessionMessage.User)
  const encode = Schema.encodeSync(SessionMessage.User)
  const base = { id: "msg_user", type: "user" as const, text: "hello", time: { created: 123 } }

  expect(encode(decode(base))).toEqual(base)
  expect(
    encode(
      decode({
        ...base,
        userName: "alice",
        userId: "user-123",
      }),
    ),
  ).toEqual({ ...base, userName: "alice", userId: "user-123" })
  expect(() => decode({ ...base, userId: 123 })).toThrow()
})
