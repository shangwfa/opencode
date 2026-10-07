export * as SessionCommand from "./session-command.js"

import { Schema } from "effect"
import { ConfigModel } from "./config/model.js"
import { optional } from "./schema.js"

export const Source = Schema.Literals(["sandbox", "session", "builtin"])

/** The template renders into prompts like the sibling instruction surfaces; the limit is UTF-8 bytes. */
export const MaxTemplateBytes = 256 * 1024

export class TemplateTooLargeError extends Schema.TaggedError<TemplateTooLargeError>()(
  "SessionCommandTemplateTooLargeError",
  {
    actualBytes: Schema.Int,
    maxBytes: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {}

export interface Definition extends Schema.Schema.Type<typeof Definition> {}
export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  template: Schema.String.pipe(optional),
  agent: Schema.String.pipe(optional),
  model: ConfigModel.Selection.pipe(optional),
  subagent: Schema.Boolean.pipe(optional),
  subtask: Schema.Boolean.pipe(optional),
  hints: Schema.Array(Schema.String),
  source: Source,
  sourcePath: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionCommand.Definition" })

export interface CreatePayload extends Schema.Schema.Type<typeof CreatePayload> {}
export const CreatePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  template: Schema.String,
  agent: Schema.String.pipe(optional),
  model: ConfigModel.Selection.pipe(optional),
  subagent: Schema.Boolean.pipe(optional),
  subtask: Schema.Boolean.pipe(optional),
  hints: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "SessionCommand.CreatePayload" })
