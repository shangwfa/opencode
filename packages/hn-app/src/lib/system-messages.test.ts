import { describe, expect, test } from "vitest"
import { isLegacyShellText, isSystemMessage, isSystemMessageID } from "./system-messages"
import type { Message } from "@/types/opencode"

const user = (id: string, text = "hi"): Message =>
  ({
    id,
    sessionID: "ses_1",
    role: "user",
    agent: "build",
    model: { providerID: "p", modelID: "m" },
    time: { created: 1 },
  }) as Message

const assistant = (id: string, parentID: string): Message =>
  ({
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID,
    agent: "build",
    modelID: "m",
    providerID: "p",
    time: { created: 2 },
  }) as Message

describe("system-messages", () => {
  test("matches the prepare prefix only", () => {
    expect(isSystemMessageID("msg_prepare_abc")).toBe(true)
    expect(isSystemMessageID("msg_abc")).toBe(false)
    expect(isSystemMessageID(undefined)).toBe(false)
  })

  test("hides the orchestration message and its reply", () => {
    expect(isSystemMessage(user("msg_prepare_abc"))).toBe(true)
    expect(isSystemMessage(assistant("msg_reply", "msg_prepare_abc"))).toBe(true)
    expect(isSystemMessage(assistant("msg_reply", "msg_user"))).toBe(false)
    expect(isSystemMessage(user("msg_user"))).toBe(false)
  })

  test("recognises the legacy shell sentinel exactly", () => {
    expect(isLegacyShellText("The following tool was executed by the user")).toBe(true)
    expect(isLegacyShellText("  The following tool was executed by the user\n")).toBe(true)
    expect(isLegacyShellText("Please run this")).toBe(false)
    expect(isLegacyShellText(undefined)).toBe(false)
  })
})
