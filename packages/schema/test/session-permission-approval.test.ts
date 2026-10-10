import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionPermissionApproval } from "../src/session-permission-approval.js"
import { SessionPermissionApproval as RootApproval } from "../src/index.js"

describe("SessionPermissionApproval contract", () => {
  test("canonical root export and ID use the same schema", () => {
    expect(RootApproval.Info).toBe(SessionPermissionApproval.Info)
    expect(Schema.is(SessionPermissionApproval.ID)(SessionPermissionApproval.ID.create())).toBe(true)
    expect(Schema.is(SessionPermissionApproval.ID)("spa_test")).toBe(true)
    expect(Schema.is(SessionPermissionApproval.ID)("spatest")).toBe(false)
    expect(Schema.is(SessionPermissionApproval.ID)("psv_test")).toBe(false)
  })
  test("optional audit source is omitted on the wire", () => {
    const decoded = Schema.decodeUnknownSync(SessionPermissionApproval.Info)({
      id: "spa_test",
      sessionID: "ses_test",
      action: "shell",
      resource: "pwd",
      time: { created: 1, updated: 1 },
    })
    const encoded = Schema.encodeSync(SessionPermissionApproval.Info)(decoded)
    expect(Object.hasOwn(encoded, "sourceRequestID")).toBe(false)
    expect(encoded.time).toEqual({ created: 1, updated: 1 })
  })
})
