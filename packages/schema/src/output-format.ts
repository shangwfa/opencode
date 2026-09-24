export * as OutputFormat from "./output-format.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

/**
 * Output shape requested for one prompt. `text` is the plain default; `json_schema` asks the
 * runner to force a single structured tool call whose arguments become `Assistant.structured`.
 *
 * Deliberately modeled as `Schema.Struct` rather than V1's `Schema.Class` union: an HTTP response
 * built from a class union can only encode class instances, so stored JSON objects surfaced as 400s
 * when read back.
 */
export interface Text extends Schema.Schema.Type<typeof Text> {}
export const Text = Schema.Struct({ type: Schema.Literal("text") }).annotate({ identifier: "OutputFormat.Text" })

export interface JsonSchema extends Schema.Schema.Type<typeof JsonSchema> {}
export const JsonSchema = Schema.Struct({
  type: Schema.Literal("json_schema"),
  /** A JSON Schema document is always an object; values are JSON so the request body stays portable. */
  schema: Schema.Record(Schema.String, Schema.Json),
  /**
   * Accepted for V1 wire compatibility only. Retries are not implemented in V2, so this value is
   * never honored and effectively behaves as 0.
   */
  retryCount: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "OutputFormat.JsonSchema" })

export const Format = Schema.Union([Text, JsonSchema]).annotate({ identifier: "OutputFormat" })
export type Format = typeof Format.Type

export const isJsonSchema = (format: Format | undefined): format is typeof JsonSchema.Type =>
  format?.type === "json_schema"
