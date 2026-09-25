import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { ToolAttachment } from "@opencode/core/tool/attachment"
import { Global } from "@opencode/util/global"
import fs from "fs/promises"
import path from "path"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
  return handler
})

const setupAuthenticated = Effect.gen(function* () {
  return yield* ServerFetch.make({
    app: { version: "test" },
    password: "attachment-test-secret",
    database: { path: ":memory:" },
    models: { fetch: false },
    fs: { filewatcher: false },
  })
})

it.live("serves managed attachments with MIME-specific headers, ranges, ETags, and integrity", () =>
  Effect.gen(function* () {
    const handler = yield* setup
    const created = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    )
    const session = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => created.json())).data
    const sessionID = Session.ID.descending(session.id)
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const stored = yield* ToolAttachment.storeLocal({ sessionID, filename: "pixel.png", bytes })
    const pdfBytes = new TextEncoder().encode("%PDF-1.7\nmanaged test fixture")
    const pdf = yield* ToolAttachment.storeLocal({ sessionID, filename: "preview.pdf", bytes: pdfBytes })
    const officeBytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    const office = yield* ToolAttachment.storeLocal({ sessionID, filename: "report.docx", bytes: officeBytes })
    try {
      const url = `http://opencode.local${stored.url}`
      const ranged = yield* Effect.promise(() => handler(new Request(url, { headers: { Range: "bytes=2-5" } })))
      expect(ranged.status).toBe(206)
      expect(ranged.headers.get("content-range")).toBe(`bytes 2-5/${bytes.length}`)
      expect(ranged.headers.get("accept-ranges")).toBe("bytes")
      expect(ranged.headers.get("etag")).toBe(`"sha256-${stored.metadata.sha256}"`)
      expect(ranged.headers.get("content-type")).toContain("image/png")
      expect(ranged.headers.get("content-disposition")).toContain("inline")
      expect(ranged.headers.get("x-content-type-options")).toBe("nosniff")
      expect(new Uint8Array(yield* Effect.promise(() => ranged.arrayBuffer()))).toEqual(bytes.slice(2, 6))

      const full = yield* Effect.promise(() => handler(new Request(url)))
      const fullBytes = new Uint8Array(yield* Effect.promise(() => full.arrayBuffer()))
      expect(full.status).toBe(200)
      expect(Buffer.from(fullBytes).toString("hex")).toBe(Buffer.from(bytes).toString("hex"))

      const pdfResponse = yield* Effect.promise(() => handler(new Request(`http://opencode.local${pdf.url}`)))
      expect(pdfResponse.status).toBe(200)
      expect(pdfResponse.headers.get("content-type")).toContain("application/pdf")
      expect(pdfResponse.headers.get("content-disposition")).toContain("inline")
      expect(new TextDecoder().decode(yield* Effect.promise(() => pdfResponse.arrayBuffer())).startsWith("%PDF-")).toBe(true)

      const officeResponse = yield* Effect.promise(() => handler(new Request(`http://opencode.local${office.url}`)))
      expect(officeResponse.status).toBe(200)
      expect(officeResponse.headers.get("content-disposition")).toContain("attachment")
      expect(officeResponse.headers.get("x-content-type-options")).toBe("nosniff")
      expect(new Uint8Array(yield* Effect.promise(() => officeResponse.arrayBuffer()))).toEqual(officeBytes)

      const cached = yield* Effect.promise(() =>
        handler(new Request(url, { headers: { "If-None-Match": ranged.headers.get("etag")! } })),
      )
      expect(cached.status).toBe(304)

      const unsatisfiable = yield* Effect.promise(() => handler(new Request(url, { headers: { Range: "bytes=20-" } })))
      expect(unsatisfiable.status).toBe(416)
      expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${bytes.length}`)

      const malformed = yield* Effect.promise(() => handler(new Request(url, { headers: { Range: "items=0-1" } })))
      expect(malformed.status).toBe(416)

      const missing = yield* Effect.promise(() =>
        handler(new Request(`http://opencode.local/api/session/${sessionID}/attachment/att_missing`)),
      )
      expect(missing.status).toBe(404)
    } finally {
      yield* Effect.promise(() =>
        handler(new Request(`http://opencode.local/api/session/${sessionID}`, { method: "DELETE" })),
      )
      yield* Effect.promise(() => fs.rm(path.join(Global.Path.data, "tool-attachments", sessionID), { recursive: true, force: true }))
    }
  }).pipe(Effect.scoped),
)

it.live("protects attachment downloads with configured server authentication", () =>
  Effect.gen(function* () {
    const handler = yield* setupAuthenticated
    const auth = `Basic ${Buffer.from("opencode:attachment-test-secret").toString("base64")}`
    const created = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json", Authorization: auth },
          body: "{}",
        }),
      ),
    )
    const session = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => created.json())).data
    const sessionID = Session.ID.descending(session.id)
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const stored = yield* ToolAttachment.storeLocal({ sessionID, filename: "secure.png", bytes })
    try {
      const url = `http://opencode.local${stored.url}`
      const denied = yield* Effect.promise(() => handler(new Request(url)))
      expect(denied.status).toBe(401)
      const allowed = yield* Effect.promise(() => handler(new Request(url, { headers: { Authorization: auth } })))
      expect(allowed.status).toBe(200)
      expect(new Uint8Array(yield* Effect.promise(() => allowed.arrayBuffer()))).toEqual(bytes)
    } finally {
      yield* Effect.promise(() =>
        handler(new Request(`http://opencode.local/api/session/${sessionID}`, { method: "DELETE", headers: { Authorization: auth } })),
      )
      yield* Effect.promise(() => fs.rm(path.join(Global.Path.data, "tool-attachments", sessionID), { recursive: true, force: true }))
    }
  }).pipe(Effect.scoped),
)
