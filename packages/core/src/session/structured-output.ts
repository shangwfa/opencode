export * as SessionStructuredOutput from "./structured-output.js"

import { ToolDefinition } from "@opencode/ai"
import { OutputFormat } from "@opencode/schema/output-format"
import { Effect } from "effect"
import { SessionMessage } from "./message.js"
import { Tool } from "../tool.js"

/**
 * Structured output rides on one forced tool call: `json_schema` prompts advertise this tool whose
 * JSON Schema is the caller's schema, and `toolChoice: "required"` plus `SystemPrompt` steer the
 * model to it. `required` (a mode) is deliberate: providers in thinking mode reject a named
 * `tool_choice` object, and V1's proven shape relies on the prompt to pick this tool among the rest.
 * The call arguments are the structured answer, projected onto `Assistant.structured`.
 */
export const ToolName = "StructuredOutput"

export const isTool = (name: string) => name === ToolName

export const Description = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

export const SystemPrompt = `IMPORTANT: The user has requested structured output. You MUST use the ${ToolName} tool to provide your final response. Do NOT respond with plain text - you MUST call the ${ToolName} tool with your answer formatted according to the schema.`

/** The `json_schema` format requested by the most recent user message of the active round. */
export const requestedJsonSchema = (
  messages: ReadonlyArray<SessionMessage.Info>,
): Record<string, unknown> | undefined => {
  const user = messages.findLast((message) => message.type === "user")
  const format = user?.type === "user" ? user.format : undefined
  return OutputFormat.isJsonSchema(format) ? format.schema : undefined
}

/** Advertises `StructuredOutput` and answers the call locally; every other tool passes through. */
export const withTool = (tools: Tool.Snapshot, schema: Record<string, unknown>): Tool.Snapshot => {
  // `$schema` describes the document itself and would only confuse the tool's input contract.
  const { $schema: _ignored, ...inputSchema } = schema
  return {
    ...tools,
    definitions: [
      ...tools.definitions,
      ToolDefinition.make({ name: ToolName, description: Description, inputSchema }),
    ],
    execute: (input) =>
      input.call.name === ToolName
        ? Effect.succeed({ content: [{ type: "text", text: JSON.stringify(input.call.input ?? {}) }] })
        : tools.execute(input),
  }
}
