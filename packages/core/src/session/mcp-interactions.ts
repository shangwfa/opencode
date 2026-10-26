export * as McpInteractions from "./mcp-interactions.js"

import { ProtocolError } from "@modelcontextprotocol/client"
import { LLM, LLMClient, Message, type ContentPart } from "@opencode/ai"
import { Context, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { Form } from "../form.js"
import { McpClient } from "../mcp/client.js"
import { toElicitationField } from "../mcp/elicitation-field.js"
import { Model } from "../model.js"
import { ModelResolver } from "../model-resolver.js"
import { SessionTable } from "./sql.js"

export interface Interface {
  readonly elicitation: McpClient.ElicitationHandler
  readonly sampling: McpClient.SamplingHandler
}
export class Service extends Context.Service<Service, Interface>()("@opencode/McpInteractions") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const forms = yield* Form.Service
    const db = (yield* Database.Service).db
    const resolver = yield* ModelResolver.Service
    const llm = yield* LLMClient.Service
    const decision = (key: string): Form.Field => ({
      key,
      type: "string",
      title: "MCP request decision",
      required: true,
      custom: false,
      options: [
        { value: "accept", label: "Accept" },
        { value: "decline", label: "Decline" },
      ],
    })
    const approve = Effect.fnUntraced(function* (input: {
      sessionID: string
      server: string
      kind: string
      message: string
    }) {
      const state = yield* forms.ask({
        sessionID: input.sessionID,
        title: `${input.server}: ${input.kind}`,
        metadata: { kind: input.kind, server: input.server, message: input.message },
        fields: [{ ...decision("decision"), description: input.message }],
      })
      if (state.status !== "answered" || state.answer.decision !== "accept")
        return yield* Effect.fail(new ProtocolError(-1, "Sampling request rejected or cancelled"))
    })
    const elicitation: McpClient.ElicitationHandler = {
      sessionScoped: true,
      create: (input) =>
        Effect.gen(function* () {
          if (!input.sessionID)
            return yield* Effect.fail(new ProtocolError(-1, "Elicitation requires an active session tool call"))
          const params = input.params
          const properties = params.mode === "url" ? {} : params.requestedSchema.properties
          let action = "_mcp_action"
          while (action in properties) action += "_"
          const fields: Form.Field[] =
            params.mode === "url"
              ? []
              : Object.entries(properties).map(([key, property]) => ({
                  ...toElicitationField(key, property, params.requestedSchema.required?.includes(key) === true),
                  when: [{ key: action, op: "eq", value: "accept" }],
                }))
          const state = yield* forms.ask({
            sessionID: input.sessionID,
            title: `${input.server} is requesting input`,
            metadata: {
              kind: "mcp-elicitation",
              server: input.server,
              message: params.message,
              mode: params.mode ?? "form",
              ...(params.mode === "url" ? { url: params.url, elicitationID: params.elicitationId } : {}),
            },
            fields: [
              {
                ...decision(action),
                description: params.mode === "url" ? `${params.message}\n\n${params.url}` : params.message,
              },
              ...fields,
            ],
          })
          if (state.status !== "answered") return { action: "cancel" }
          if (state.answer[action] !== "accept") return { action: "decline" }
          // URL acceptance authorizes visiting the URL; it does not complete the external workflow.
          if (params.mode === "url") return { action: "accept" }
          return {
            action: "accept",
            content: Object.fromEntries(
              Object.entries(state.answer)
                .filter(([key]) => key !== action)
                .map(([key, value]) => [key, typeof value === "object" ? Array.from(value) : value]),
            ),
          }
        }),
      complete: () => Effect.void,
    }
    const sampling: McpClient.SamplingHandler = {
      create: (input) =>
        Effect.gen(function* () {
          if (!input.sessionID)
            return yield* Effect.fail(new ProtocolError(-1, "Sampling requires an active session tool call"))
          const params = input.params
          if (
            params.tools !== undefined ||
            params.toolChoice !== undefined ||
            (params.includeContext !== undefined && params.includeContext !== "none")
          )
            return yield* Effect.fail(
              new ProtocolError(-32602, "Sampling tools and additional context are not supported"),
            )
          if (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)
            return yield* Effect.fail(new ProtocolError(-32602, "maxTokens must be a positive integer"))
          const [session] = yield* db
            .select({ model: SessionTable.model })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
          if (!session) return yield* Effect.fail(new ProtocolError(-1, "Sampling session no longer exists"))
          const selected = session.model ? Schema.decodeUnknownSync(Model.Ref)(session.model) : undefined
          const resolved = yield* resolver
            .resolve(selected)
            .pipe(Effect.mapError(() => new ProtocolError(-1, "Sampling model unavailable")))
          if (!resolved) return yield* Effect.fail(new ProtocolError(-1, "Sampling model unavailable"))
          const maxTokens = Math.min(params.maxTokens, 4096)
          const messages: Message.Input[] = []
          for (const message of params.messages) {
            const parts: ContentPart[] = []
            for (const part of Array.isArray(message.content) ? message.content : [message.content]) {
              if (part.type === "text") parts.push({ type: "text", text: part.text })
              else if (part.type === "image" || part.type === "audio")
                parts.push({ type: "media", mediaType: part.mimeType, data: part.data })
              else return yield* Effect.fail(new ProtocolError(-32602, "Unsupported sampling message content"))
            }
            messages.push({ role: message.role, content: parts })
          }
          yield* approve({
            sessionID: input.sessionID,
            server: input.server,
            kind: "mcp-sampling-request",
            message: JSON.stringify({
              model: resolved.ref,
              maxTokens,
              systemPrompt: params.systemPrompt,
              messages: params.messages,
            }),
          })
          const result = yield* llm
            .generate(
              LLM.request({
                model: resolved.model,
                system: params.systemPrompt,
                messages,
                generation: { maxTokens, temperature: params.temperature, stop: params.stopSequences },
              }),
            )
            .pipe(Effect.mapError(() => new ProtocolError(-1, "Sampling generation failed")))
          yield* approve({
            sessionID: input.sessionID,
            server: input.server,
            kind: "mcp-sampling-result",
            message: result.text,
          })
          return {
            role: "assistant",
            model: resolved.ref.id,
            content: { type: "text", text: result.text },
            stopReason: result.finishReason.normalized === "length" ? "maxTokens" : "endTurn",
          }
        }),
    }
    return Service.of({ elicitation, sampling })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Form.node, Database.node, ModelResolver.node, llmClient],
})
