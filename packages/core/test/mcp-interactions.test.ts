import { expect } from "bun:test"
import { Effect, Fiber, Layer, Queue } from "effect"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { TestLLM } from "@opencode/ai/testing"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"
import { Form } from "../src/form"
import { HitlLedger } from "../src/hitl/ledger"
import { McpInteractions } from "../src/session/mcp-interactions"
import { ModelResolver } from "../src/model-resolver"
import { Model } from "../src/model"
import { Provider } from "../src/provider"
import { testEffect } from "./lib/effect"
import { ensureSession, removeIfCreated } from "./lib/session"

const info = Model.Info.default(Provider.ID.make("test"), Model.ID.make("selected-model"))
const ref = Model.Ref.make({ providerID: info.providerID, id: info.id })
const runtime = LanguageModel.make({ id: info.id, provider: info.providerID, route: OpenAIChat.route })
const dependencies = Layer.mergeAll(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Form.node])),
  Layer.mock(ModelResolver.Service, {
    resolve: () =>
      Effect.succeed({ ref, model: runtime, limit: info.limit, cost: info.cost, capabilities: info.capabilities }),
  }),
  TestLLM.testLayer({ fallback: TestLLM.text("SAMPLED-中文", "sampling") }),
)
const it = testEffect(McpInteractions.layer.pipe(Layer.provideMerge(dependencies)))
const signal = () => new AbortController().signal
const params = {
  message: "请输入",
  requestedSchema: { type: "object" as const, properties: { name: { type: "string" as const } }, required: ["name"] },
}
const sampling = {
  maxTokens: 9000,
  temperature: 0.2,
  stopSequences: ["END"],
  systemPrompt: "Only these messages",
  messages: [{ role: "user" as const, content: { type: "text" as const, text: "Generate" } }],
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const { session, created } = yield* ensureSession(db)
  yield* Effect.addFinalizer(() => removeIfCreated(db, session, created))
  const events = yield* Queue.unbounded<Form.Info>()
  const bus = yield* Bus.Service
  const unsubscribe = yield* bus.listen((event) =>
    event.type === Form.Event.Created.type
      ? Queue.offer(events, (event.data as { form: Form.Info }).form).pipe(Effect.asVoid)
      : Effect.void,
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  return {
    sessionID: session.id,
    forms: yield* Form.Service,
    interactions: yield* McpInteractions.Service,
    events,
    db,
    llm: yield* TestLLM.Test,
  }
})

for (const action of ["accept", "decline", "cancel"] as const) {
  it.effect(`session elicitation ${action} preserves its owner and terminal form`, () =>
    Effect.gen(function* () {
      const { sessionID, forms, interactions, events, db } = yield* setup
      const fiber = yield* interactions.elicitation
        .create({ server: "test", sessionID, params, signal: signal() })
        .pipe(Effect.forkScoped)
      const form = yield* Queue.take(events)
      expect(form.sessionID).toBe(sessionID)
      expect(form.metadata?.kind).toBe("mcp-elicitation")
      if (action === "cancel") yield* forms.cancel(form.id)
      else
        yield* forms.reply({
          id: form.id,
          answer: { _mcp_action: action, ...(action === "accept" ? { name: "中文" } : {}) },
        })
      expect(yield* Fiber.join(fiber)).toEqual(action === "accept" ? { action, content: { name: "中文" } } : { action })
      expect((yield* forms.state(form.id)).status).toBe(action === "cancel" ? "cancelled" : "answered")
      if ((yield* Database.Service).dialect === "postgres") {
        expect(yield* HitlLedger.make(db).get(form.id)).toMatchObject({
          sessionID,
          kind: "form",
          decision: action === "cancel" ? "cancelled" : "answered",
          ...(action === "cancel" ? {} : { result: { _mcp_action: action } }),
        })
      }
    }),
  )
}

it.effect("URL elicitation consent does not falsely complete the external workflow", () =>
  Effect.gen(function* () {
    const { sessionID, forms, interactions, events } = yield* setup
    const fiber = yield* interactions.elicitation
      .create({
        server: "test",
        sessionID,
        signal: signal(),
        params: { mode: "url", url: "https://example.com/consent", elicitationId: "external-1", message: "Approve" },
      })
      .pipe(Effect.forkScoped)
    const form = yield* Queue.take(events)
    yield* interactions.elicitation.complete({ server: "test", elicitationID: "external-1" })
    expect((yield* forms.state(form.id)).status).toBe("pending")
    yield* forms.reply({ id: form.id, answer: { _mcp_action: "accept" } })
    expect(yield* Fiber.join(fiber)).toEqual({ action: "accept" })
  }),
)

it.effect("empty schemas still require consent and reserved field collisions remain answerable", () =>
  Effect.gen(function* () {
    const { sessionID, forms, interactions, events } = yield* setup
    const schemas: Array<Record<string, { type: "string" }>> = [{}, { _mcp_action: { type: "string" } }]
    for (const properties of schemas) {
      const fiber = yield* interactions.elicitation
        .create({
          server: "test",
          sessionID,
          signal: signal(),
          params: { message: "Consent", requestedSchema: { type: "object", properties } },
        })
        .pipe(Effect.forkScoped)
      const form = yield* Queue.take(events)
      const key = form.fields[0].key
      yield* forms.reply({
        id: form.id,
        answer: { [key]: "accept", ...("_mcp_action" in properties ? { _mcp_action: "payload" } : {}) },
      })
      expect(yield* Fiber.join(fiber)).toEqual({
        action: "accept",
        content: "_mcp_action" in properties ? { _mcp_action: "payload" } : {},
      })
    }
  }),
)

it.effect("sampling requires request and result approval, limits tokens and preserves generation parameters", () =>
  Effect.gen(function* () {
    const { sessionID, forms, interactions, events, llm } = yield* setup
    const fiber = yield* interactions.sampling
      .create({ server: "test", sessionID, params: sampling, signal: signal() })
      .pipe(Effect.forkScoped)
    const request = yield* Queue.take(events)
    expect(request.metadata?.kind).toBe("mcp-sampling-request")
    expect(yield* llm.requests()).toHaveLength(0)
    yield* forms.reply({ id: request.id, answer: { decision: "accept" } })
    const result = yield* Queue.take(events)
    expect(result.metadata?.kind).toBe("mcp-sampling-result")
    expect(result.metadata?.message).toBe("SAMPLED-中文")
    const [generated] = yield* llm.requests()
    expect(generated?.generation).toMatchObject({ maxTokens: 4096, temperature: 0.2, stop: ["END"] })
    expect(generated?.messages).toHaveLength(1)
    expect(generated?.tools).toHaveLength(0)
    yield* forms.reply({ id: result.id, answer: { decision: "accept" } })
    expect(yield* Fiber.join(fiber)).toEqual({
      role: "assistant",
      model: "selected-model",
      content: { type: "text", text: "SAMPLED-中文" },
      stopReason: "endTurn",
    })
  }),
)

for (const stage of ["request", "result"] as const) {
  for (const action of ["decline", "cancel"] as const) {
    it.effect(`sampling ${stage} ${action} never releases an unapproved result`, () =>
      Effect.gen(function* () {
        const { sessionID, forms, interactions, events, llm } = yield* setup
        const fiber = yield* interactions.sampling
          .create({ server: "test", sessionID, params: sampling, signal: signal() })
          .pipe(Effect.flip, Effect.forkScoped)
        let form = yield* Queue.take(events)
        if (stage === "result") {
          yield* forms.reply({ id: form.id, answer: { decision: "accept" } })
          form = yield* Queue.take(events)
        }
        if (action === "cancel") yield* forms.cancel(form.id)
        else yield* forms.reply({ id: form.id, answer: { decision: "decline" } })
        expect(yield* Fiber.join(fiber)).toMatchObject({ code: -1 })
        expect(yield* llm.requests()).toHaveLength(stage === "request" ? 0 : 1)
      }),
    )
  }
}

for (const action of ["decline", "cancel"] as const) {
  it.effect(`URL elicitation ${action} needs no external acknowledgement`, () =>
    Effect.gen(function* () {
      const { sessionID, forms, interactions, events } = yield* setup
      const fiber = yield* interactions.elicitation
        .create({
          server: "test",
          sessionID,
          signal: signal(),
          params: {
            mode: "url",
            url: "https://example.com/consent",
            elicitationId: "url-decision",
            message: "Authorize",
          },
        })
        .pipe(Effect.forkScoped)
      const form = yield* Queue.take(events)
      if (action === "cancel") yield* forms.cancel(form.id)
      else yield* forms.reply({ id: form.id, answer: { _mcp_action: "decline" } })
      expect(yield* Fiber.join(fiber)).toEqual({ action })
    }),
  )
}

it.effect("sampling rejects unadvertised tools/context, invalid tokens and requests outside a tool call", () =>
  Effect.gen(function* () {
    const { sessionID, interactions, llm } = yield* setup
    for (const params of [
      { ...sampling, tools: [] },
      { ...sampling, includeContext: "allServers" as const },
      { ...sampling, maxTokens: 0 },
      { ...sampling, maxTokens: 1.5 },
    ]) {
      expect(
        yield* interactions.sampling.create({ server: "test", sessionID, params, signal: signal() }).pipe(Effect.flip),
      ).toMatchObject({ code: -32602 })
    }
    expect(
      yield* interactions.sampling.create({ server: "test", params: sampling, signal: signal() }).pipe(Effect.flip),
    ).toMatchObject({ code: -1 })
    expect(
      yield* interactions.elicitation.create({ server: "test", params, signal: signal() }).pipe(Effect.flip),
    ).toMatchObject({ code: -1 })
    expect(yield* llm.requests()).toHaveLength(0)
  }),
)

it.effect("cancelled interaction fibers settle the session form instead of leaving pending PG work", () =>
  Effect.gen(function* () {
    const { sessionID, forms, interactions, events } = yield* setup
    const fiber = yield* interactions.elicitation
      .create({ server: "test", sessionID, params, signal: signal() })
      .pipe(Effect.forkScoped)
    const form = yield* Queue.take(events)
    yield* Fiber.interrupt(fiber)
    expect((yield* forms.state(form.id)).status).toBe("cancelled")
  }),
)
