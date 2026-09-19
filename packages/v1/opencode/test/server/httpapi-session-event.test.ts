import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { sessionEventFilter } from "../../src/server/routes/instance/httpapi/handlers/session"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

// Coverage notes: the persisted-session scenarios (stream filtering across two
// sessions, prompt_stream run lifecycle) are exercised end-to-end by the
// httpapi-exercise scenarios (session.event, session.event.missing,
// session.prompt_stream) and docs/test-cases/session/sse.md T9.28-T9.31, since
// the local SQLite baseline lacks the SaaS-only session columns.

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const it = testEffect(httpApiLayer)

describe("sessionEventFilter", () => {
  const event = (data: unknown) => ({ id: "evt_1", type: "test", data }) as unknown as EventV2.Payload

  test("matches events whose properties carry the session id", () => {
    const filter = sessionEventFilter("ses_a" as never)
    expect(filter(event({ sessionID: "ses_a" }))).toBe(true)
    expect(filter(event({ sessionID: "ses_b" }))).toBe(false)
  })

  test("rejects non-session payloads safely", () => {
    const filter = sessionEventFilter("ses_a" as never)
    expect(filter(event(undefined))).toBe(false)
    expect(filter(event("raw"))).toBe(false)
    expect(filter(event({ info: { sessionID: "ses_a" } }))).toBe(false)
  })
})

describe("session event stream HttpApi", () => {
  it.instance(
    "returns 404 for a missing session",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const response = yield* requestInDirectory(
          SessionPaths.event.replace(":sessionID", "ses_httpapi_missing"),
          directory,
        )
        expect(response.status).toBe(404)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
