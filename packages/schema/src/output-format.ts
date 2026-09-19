export * as OutputFormat from "./output-format.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { NonNegativeInt } from "./schema.js"

/** Plain-text replies; no structured-output tool is injected. */
export interface Text extends Schema.Schema.Type<typeof Text> {}
export const Text = Schema.Struct({
  type: Schema.Literal("text"),
}).annotate({ identifier: "OutputFormat.Text" })

/**
 * Forces a structured reply: the runner injects a `StructuredOutput` tool
 * whose input schema is the requested JSON Schema and requires the model to
 * call it; the captured arguments land on the assistant message's
 * `structured` field.
 */
export interface JsonSchemaFormat extends Schema.Schema.Type<typeof JsonSchemaFormat> {}
export const JsonSchemaFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  schema: Schema.Record(Schema.String, Schema.Unknown).annotate({ identifier: "JSONSchema" }),
  retryCount: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "OutputFormat.JsonSchema" })

export const Format = Schema.Union([Text, JsonSchemaFormat]).annotate({
  discriminator: "type",
  identifier: "OutputFormat",
})
export type Format = Schema.Schema.Type<typeof Format>
