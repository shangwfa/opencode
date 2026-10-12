import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Stream } from "effect"
import { LLM, LLMRequest, Message, TransportError, HttpOptions, mergeHttpOptions } from "../src/index.js"

import { model as anthropicModel } from "../src/providers/anthropic.js"
import { model as openAICompatibleModel } from "../src/providers/openai-compatible.js"
import { it } from "./lib/effect.js"
import { dynamicResponse } from "./lib/http.js"

/** Handler that never produces a response, modelling a hung provider connection. */
const hangingLayer = dynamicResponse(() => Effect.never as never)

describe("provider request timeout", () => {
  test("HttpOptions.timeoutMs merges with finer levels winning", () => {
    const merged = mergeHttpOptions(
      new HttpOptions({ timeoutMs: 1000 }),
      new HttpOptions({ headers: { a: "b" } }),
      new HttpOptions({ timeoutMs: 50 }),
    )
    expect(merged?.timeoutMs).toBe(50)
    expect(mergeHttpOptions(new HttpOptions({ timeoutMs: 1000 }), new HttpOptions({}))?.timeoutMs).toBe(1000)
    expect(mergeHttpOptions(new HttpOptions({}))).toBeUndefined()
  })

  it.effect("openai-compatible and anthropic lower timeoutMs onto the route http options", () =>
    Effect.gen(function* () {
      const oc = openAICompatibleModel("m", { apiKey: "k", baseURL: "http://provider.test/v1", timeoutMs: 50 })
      expect(oc.route.defaults.http?.timeoutMs).toBe(50)

      const an = anthropicModel("m", { apiKey: "k", baseURL: "http://provider.test", timeoutMs: 70 })
      expect(an.route.defaults.http?.timeoutMs).toBe(70)
    }))

  it.live("a provider that never responds settles as a typed transport timeout within budget", () =>
    Effect.gen(function* () {
      const request = LLM.request({
        model: openAICompatibleModel("m", {
          apiKey: "k",
          baseURL: "http://hang.test/v1",
          timeoutMs: 60,
        }),
        messages: [Message.user("hello")],
      })
      const exit = yield* LLM.stream(request).pipe(
        Stream.runDrain,
        Effect.exit,
        Effect.provide(hangingLayer),
      )
      if (Exit.isSuccess(exit)) throw new Error("expected a typed timeout failure, got success")
      const failure = Cause.squash(exit.cause) as { reason: TransportError }
      const reason = failure.reason
      if (!(reason instanceof TransportError)) throw new Error(`expected TransportError, got ${reason?.constructor?.name}`)
      expect(reason.code).toBe("Timeout")
      expect(reason.transport).toBe("http")
      expect(reason.message).toContain("60ms")
    }))

  it.live("no timeoutMs keeps an unconfigured route on socket defaults", () =>
    Effect.gen(function* () {
      const language = openAICompatibleModel("m", { apiKey: "k", baseURL: "http://provider.test/v1" })
      expect(language.route.defaults.http?.timeoutMs).toBeUndefined()
    }))
})
