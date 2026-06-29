import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { MessageV2 } from "../../src/session/message-v2"
import { User } from "@opencode-ai/core/v1/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Session } from "@/session/session"
import { SessionV2 } from "../../src/v2/session"
import { Database } from "@/storage/db"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { SessionMessage } from "@opencode-ai/core/session/message"

const sessionID = SessionID.make("session")

describe("session.user-fields message-v2 schema", () => {
  test("User schema accepts userName and userId", () => {
    const decoded = Schema.decodeUnknownSync(User)({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      userName: "alice",
      userId: "user-123",
    })
    expect(decoded.userName).toBe("alice")
    expect(decoded.userId).toBe("user-123")
  })

  test("User schema works without userName and userId", () => {
    const decoded = Schema.decodeUnknownSync(User)({
      id: MessageID.ascending(),
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    })
    expect(decoded.userName).toBeUndefined()
    expect(decoded.userId).toBeUndefined()
  })

  test("User schema round-trips userName and userId through encoding", () => {
    const input = {
      id: MessageID.ascending(),
      sessionID,
      role: "user" as const,
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      userName: "bob",
      userId: "user-456",
    }
    const encoded = Schema.encodeSync(User)(input)
    const decoded = Schema.decodeUnknownSync(User)(encoded)
    expect(decoded.userName).toBe("bob")
    expect(decoded.userId).toBe("user-456")
  })
})

describe("session.user-fields SessionMessage schema", () => {
  test("SessionMessage.User schema accepts userName and userId", () => {
    const decoded = Schema.decodeUnknownSync(SessionMessage.User)({
      id: "msg-1",
      type: "user",
      time: { created: Date.now() },
      text: "hello",
      files: [],
      agents: [],
      references: [],
      userName: "alice",
      userId: "user-123",
    })
    expect(decoded.userName).toBe("alice")
    expect(decoded.userId).toBe("user-123")
  })

  test("SessionMessage.User schema works without userName and userId", () => {
    const decoded = Schema.decodeUnknownSync(SessionMessage.User)({
      id: "msg-1",
      type: "user",
      time: { created: Date.now() },
      text: "hello",
      files: [],
      agents: [],
      references: [],
    })
    expect(decoded.userName).toBeUndefined()
    expect(decoded.userId).toBeUndefined()
  })
})
