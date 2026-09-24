import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { PvcMode } from "../src/session-pvc-mode.js"
import { Session } from "../src/session.js"
import { SessionEvent } from "../src/session-event.js"

const decodeInfo = Schema.decodeUnknownSync(Schema.toEncoded(Session.Info))

const baseInfo = {
  id: "ses_test",
  projectID: "prj_test",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: "/tmp" },
}

describe("Session.PvcMode contract", () => {
  test("accepts session and app literals", () => {
    expect(Schema.decodeUnknownSync(PvcMode)("session")).toBe("session")
    expect(Schema.decodeUnknownSync(PvcMode)("app")).toBe("app")
  })

  test("rejects values outside the closed set", () => {
    for (const value of ["global", "none", "", "Session"]) {
      expect(() => Schema.decodeUnknownSync(PvcMode)(value)).toThrow()
    }
  })

  test("Info carries pvcMode optionally and omits undefined keys when encoded", () => {
    expect(decodeInfo(baseInfo).pvcMode).toBeUndefined()
    expect(decodeInfo({ ...baseInfo, pvcMode: "app" }).pvcMode).toBe("app")
    expect(() => decodeInfo({ ...baseInfo, pvcMode: "global" })).toThrow()
    const encoded = Schema.encodeSync(Schema.toEncoded(Session.Info))(decodeInfo(baseInfo))
    expect("pvcMode" in encoded).toBe(false)
    expect("appId" in encoded).toBe(false)
  })

  test("Created event carries pvcMode as an optional field", () => {
    expect("pvcMode" in SessionEvent.Created.data.fields).toBe(true)
    const decode = Schema.decodeUnknownSync(Schema.toEncoded(SessionEvent.Created))
    const base = {
      type: "session.created",
      id: "evt_test",
      created: 0,
      durable: { aggregateID: "ses_test", seq: 1, version: 1 },
      data: {
        sessionID: "ses_test",
        projectID: "prj_test",
        location: { directory: "/tmp" },
        slug: "s",
        version: "1",
      },
    }
    expect(decode(base).data.pvcMode).toBeUndefined()
    expect("pvcMode" in decode(base).data).toBe(false)
    expect(decode({ ...base, data: { ...base.data, pvcMode: "session" } }).data.pvcMode).toBe("session")
  })
})
