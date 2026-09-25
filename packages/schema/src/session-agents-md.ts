export * as SessionAgentsMd from "./session-agents-md.js"

import { Schema } from "effect"
import { Session } from "./session.js"
import { DateTimeUtcFromMillis, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("sam_")).pipe(
  Schema.brand("SessionAgentsMd.ID"),
  statics((schema) => ({ create: () => schema.make(`sam_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  sessionID: Session.ID,
  content: Schema.String,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
}).annotate({ identifier: "SessionAgentsMd.Info" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({ content: Schema.String }).annotate({ identifier: "SessionAgentsMd.Payload" })

export const MaxContentBytes = 256 * 1024

export class ContentTooLargeError extends Schema.TaggedError<ContentTooLargeError>()(
  "SessionAgentsMdContentTooLargeError",
  {
    actualBytes: Schema.Int,
    maxBytes: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {}
