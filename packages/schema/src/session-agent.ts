export * as SessionAgent from "./session-agent.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { ConfigAgent } from "./config/agent.js"
import { optional, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("sagent_")).pipe(
  Schema.brand("SessionAgent.ID"),
  statics((schema) => ({ create: () => schema.make(`sagent_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Literals(["global", "session", "sandbox"])

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  agent: Agent.Info,
  source: Source,
  sourcePath: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionAgent.Info" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({
  id: Agent.ID,
  config: ConfigAgent.Info,
}).annotate({ identifier: "SessionAgent.Payload" })

export const MaxContentBytes = 256 * 1024

export class ContentTooLargeError extends Schema.TaggedError<ContentTooLargeError>()(
  "SessionAgentContentTooLargeError",
  {
    actualBytes: Schema.Int,
    maxBytes: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {}
