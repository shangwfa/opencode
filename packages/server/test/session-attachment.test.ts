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

it.live("serves managed attachments with byte ranges, ETags, and 416 responses", () =>
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

      const cached = yield* Effect.promise(() =>
        handler(new Request(url, { headers: { "If-None-Match": ranged.headers.get("etag")! } })),
      )
      expect(cached.status).toBe(304)

      const unsatisfiable = yield* Effect.promise(() => handler(new Request(url, { headers: { Range: "bytes=20-" } })))
      expect(unsatisfiable.status).toBe(416)
      expect(unsatisfiable.headers.get("content-range")).toBe(`bytes */${bytes.length}`)
    } finally {
      yield* Effect.promise(() =>
        handler(new Request(`http://opencode.local/api/session/${sessionID}`, { method: "DELETE" })),
      )
      yield* Effect.promise(() => fs.rm(path.join(Global.Path.data, "tool-attachments", sessionID), { recursive: true, force: true }))
    }
  }).pipe(Effect.scoped),
)
