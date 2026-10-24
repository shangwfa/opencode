import { expect } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { LLM, Message } from "../../ai/src/index"
import * as OpenAI from "../../ai/src/providers/openai"
import { SessionContextInsights } from "@opencode/core/session/context-insights"
import { SessionContextInsights as Contract } from "@opencode/schema/session-context-insights"
import { Session } from "@opencode/schema/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live(
  "context insight API validates pagination, serves bounded detail and prevents cross-session content reads",
  () =>
    Effect.gen(function* () {
      let current: SessionContextInsights.Interface | undefined
      const handler = yield* ServerFetch.make(
        {
          app: { version: "test" },
          database: { path: ":memory:" },
          fs: { filewatcher: false },
          models: { fetch: false },
        },
        {
          overrides: [
            SessionContextInsights.node.replace(
              SessionContextInsights.node.mapLayer((layer) =>
                layer.pipe(
                  Layer.tap((context) =>
                    Effect.sync(() => {
                      current = Context.get(context, SessionContextInsights.Service)
                    }),
                  ),
                ),
              ),
            ),
          ],
        },
      )
      const request = (method: string, path: string, body?: unknown) =>
        Effect.promise(() =>
          handler(
            new Request(`http://opencode.local${path}`, {
              method,
              headers: { "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          ),
        )
      const create = Effect.gen(function* () {
        const response = yield* request("POST", "/api/session", {})
        expect(response.status).toBe(200)
        const body: unknown = yield* Effect.promise(() => response.json())
        return Schema.decodeUnknownSync(Schema.Struct({ data: Schema.Struct({ id: Session.ID }) }))(body).data.id
      })
      const first = yield* create
      const second = yield* create
      const path = `/api/session/${first}/context-insights`
      const empty = yield* request("GET", path)
      expect(empty.status).toBe(200)
      expect(yield* Effect.promise(() => empty.json())).toEqual({
        data: { capturedRequests: 0, latest: null, history: "captured-requests-only" },
      })
      if (!current) throw new Error("Location-scoped context service was not initialized")
      const service = current
      const stream = yield* request("GET", `/api/session/${first}/event`)
      expect(stream.status).toBe(200)
      const reader = stream.body?.getReader()
      if (!reader) throw new Error("Missing session SSE body")
      yield* Effect.addFinalizer(() => Effect.promise(() => reader.cancel()))
      const decoder = new TextDecoder()
      let buffer = ""
      const readEvent = async (): Promise<unknown> => {
        while (true) {
          const end = buffer.indexOf("\n\n")
          if (end >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const line = frame.split("\n").find((line) => line.startsWith("data: "))
            if (line) return JSON.parse(line.slice(6))
            continue
          }
          const chunk = await reader.read()
          if (chunk.done) throw new Error("SSE closed before the context event")
          buffer += decoder.decode(chunk.value, { stream: true })
        }
      }
      expect(yield* Effect.promise(readEvent)).toMatchObject({ type: "server.connected" })
      const pendingEvent = readEvent()
      const model = OpenAI.configure({ apiKey: "secret" }).chat("test")
      const captured = yield* service.capture({
        sessionID: first,
        kind: "primary",
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("openai") }),
        request: LLM.request({ model, system: "private system", messages: [Message.user("private user")] }),
      })
      const event = yield* Effect.promise(() => pendingEvent).pipe(Effect.timeout("3 seconds"))
      expect(event).toMatchObject({
        type: "session.context.captured",
        data: { sessionID: first, request: { id: captured.id } },
      })
      expect(JSON.stringify(event)).not.toContain("private")
      const listed = yield* request("GET", `${path}/requests?limit=1`)
      expect(listed.status).toBe(200)
      const listBody: unknown = yield* Effect.promise(() => listed.json())
      const page = Schema.decodeUnknownSync(Contract.Page)(listBody)
      expect(page.data.map((row) => row.id)).toEqual([captured.id])
      expect(JSON.stringify(page)).not.toContain("private")
      const detail = yield* request("GET", `${path}/requests/${captured.id}`)
      expect(detail.status).toBe(200)
      expect(yield* Effect.promise(() => detail.json())).toMatchObject({
        data: { request: { id: captured.id }, items: [{ category: "system" }, { category: "user" }] },
      })
      const content = yield* request("GET", `${path}/requests/${captured.id}/items/0`)
      expect(content.status).toBe(200)
      expect(yield* Effect.promise(() => content.json())).toMatchObject({ data: { content: "private system" } })
      for (const query of ["limit=0", "limit=101", "limit=x", "before=-1", "before=1.5"]) {
        expect((yield* request("GET", `${path}/requests?${query}`)).status).toBe(400)
      }
      expect((yield* request("GET", `${path}/requests/${captured.id}/items/-1`)).status).toBe(400)
      expect((yield* request("GET", `${path}/requests/${captured.id}/items/999`)).status).toBe(404)
      expect((yield* request("GET", `${path}/requests/${Contract.RequestID.create()}`)).status).toBe(404)
      expect((yield* request("GET", `/api/session/${second}/context-insights/requests/${captured.id}`)).status).toBe(
        404,
      )
      expect(
        (yield* request("GET", `/api/session/${second}/context-insights/requests/${captured.id}/items/0`)).status,
      ).toBe(404)
      expect((yield* request("GET", "/api/session/ses_missing/context-insights")).status).toBe(404)
      const analysis = yield* request("GET", `${path}/analysis`)
      expect(analysis.status).toBe(200)
      expect(yield* Effect.promise(() => analysis.json())).toMatchObject({ data: { points: [{ request: { id: captured.id }, actual: null, status: "unknown" }], scope: "request-page" } })
      const family = yield* request("GET", `${path}/family`)
      expect(family.status).toBe(200)
      expect(yield* Effect.promise(() => family.json())).toMatchObject({ data: { rootID: first, members: [{ sessionID: first }] } })
      const overview = yield* request("POST", "/api/context-insights/overview", { sessionIDs: [first], from: Date.now() - 10000, to: Date.now() + 10000 })
      expect(overview.status).toBe(200)
      expect(yield* Effect.promise(() => overview.json())).toMatchObject({ data: { sessions: [{ sessionID: first }], attribution: "settlement-utc" } })
      expect((yield* request("POST", "/api/context-insights/overview", { sessionIDs: [], from: 1000, to: 0 })).status).toBe(400)
      expect((yield* request("GET", `${path}/analysis?limit=101`)).status).toBe(400)
      expect((yield* request("DELETE", `/api/session/${first}`)).status).toBe(204)
      expect((yield* request("GET", path)).status).toBe(404)
      yield* request("DELETE", `/api/session/${second}`)
    }),
  60_000,
)
