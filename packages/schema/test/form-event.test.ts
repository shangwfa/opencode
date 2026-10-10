import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Form } from "../src/form.js"

const form = {
  id: Form.ID.create(),
  sessionID: "ses_form_event",
  title: "Question",
  fields: [{ key: "answer", type: "string" as const }],
} satisfies Form.Info

describe("Form creation event routing", () => {
  test("encodes the routing owner without changing the embedded form", () => {
    const encoded = Schema.encodeSync(Form.Event.Created.data)({ sessionID: form.sessionID, form })
    expect(encoded).toEqual({ sessionID: form.sessionID, form })
  })

  test("keeps old wire payloads readable and omits an undefined optional owner", () => {
    const decoded = Schema.decodeUnknownSync(Form.Event.Created.data)({ form })
    expect(decoded).toEqual({ form })
    expect(Schema.encodeSync(Form.Event.Created.data)({ form, sessionID: undefined })).toEqual({ form })
  })
})
