export * as ConnectorTool from "./connector.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Connector } from "@opencode/connector/adapter"
import { ConnectorConnection } from "@opencode/schema/connector-connection"
import type { Tool as ToolSchema } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { Permission } from "../../permission.js"

/**
 * Native connector tools (channel B). Registered only when OPENCODE_CONNECTOR_MODE includes
 * `native` (mcp|native|both, default mcp) and the engine is enabled; MCP remains channel A.
 */

const nativeEnabled = () =>
  process.env.OPENCODE_CONNECTOR_ENABLED === "true" &&
  ["native", "both"].includes(process.env.OPENCODE_CONNECTOR_MODE?.trim() || "mcp")

const failure = (error: unknown) =>
  new ToolFailure({
    message:
      error instanceof Connector.ConflictError
        ? error.message
        : error instanceof Connector.NotFoundError
          ? `Connector connection not found: ${error.connectionID}`
          : error instanceof Error
            ? error.message
            : String(error),
  })

const assert = (permission: Permission.Interface, action: string, context: ToolSchema.Context) =>
  permission.assert({
    action,
    resources: ["*"],
    save: ["*"],
    metadata: {},
    sessionID: context.sessionID,
    agent: context.agent,
    source: { type: "tool", messageID: context.messageID, id: context.id },
  })

export const Plugin = {
  id: "opencode.tool.connector",
  effect: Effect.fn("ConnectorTool.Plugin")(function* (ctx: Context) {
    if (!nativeEnabled()) return
    const permission = yield* Permission.Service
    const connector = yield* Connector.Service

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "list_apps",
        options: { namespace: "connector" },
        description:
          "List third-party apps available through the connector engine. Public no-auth apps are listed without any connection; other apps require an associated connector connection.",
        input: Schema.Struct({ query: Schema.optional(Schema.String) }),
        execute: (_input, context) =>
          Effect.gen(function* () {
            yield* assert(permission, "connector_list_apps", context)
            return { output: yield* connector.apps(context.sessionID) }
          }).pipe(Effect.mapError(failure)),
      })
      editor.add({
        name: "list_connections",
        options: { namespace: "connector" },
        description: "List the connector connections associated with this session.",
        input: Schema.Struct({}),
        execute: (_input, context) =>
          Effect.gen(function* () {
            yield* assert(permission, "connector_list_connections", context)
            return { output: { connections: yield* connector.list(context.sessionID) } }
          }).pipe(Effect.mapError(failure)),
      })
      editor.add({
        name: "search_actions",
        options: { namespace: "connector" },
        description: "Search connector actions across the session's connections.",
        input: Schema.Struct({
          query: Schema.optional(Schema.String),
          service: Schema.optional(Schema.String),
          limit: Schema.optional(Schema.Number),
        }),
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* assert(permission, "connector_search_actions", context)
            return {
              output: yield* connector.searchActions(context.sessionID, {
                query: input.query,
                service: input.service,
                limit: input.limit,
              }),
            }
          }).pipe(Effect.mapError(failure)),
      })
      editor.add({
        name: "get_action_guide",
        options: { namespace: "connector" },
        description: "Get the input schema and usage guide for one connector action.",
        input: Schema.Struct({ actionId: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* assert(permission, "connector_get_action_guide", context)
            return { output: yield* connector.actionGuide(context.sessionID, input.actionId) }
          }).pipe(Effect.mapError(failure)),
      })
      editor.add({
        name: "execute_action",
        options: { namespace: "connector" },
        description:
          "Execute a connector action using this session's connections. Scope to one connection with connectionID. Side effects follow the normal permission flow.",
        input: Schema.Struct({
          actionId: Schema.String.annotate({ description: "Connector action id, e.g. github.create_issue" }),
          connectionID: Schema.optional(Schema.String),
          input: Schema.optional(Schema.Json),
        }),
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* assert(permission, "connector_execute_action", context)
            return {
              output: yield* connector.executeAction(context.sessionID, {
                actionId: input.actionId,
                connectionID: input.connectionID as ConnectorConnection.ID | undefined,
                actionInput: input.input,
              }),
            }
          }).pipe(Effect.mapError(failure)),
      })
    })
  }),
}
