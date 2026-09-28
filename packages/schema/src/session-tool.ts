export * as SessionTool from "./session-tool.js"

import { Schema } from "effect"
import { statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("stl_")).pipe(
  Schema.brand("SessionTool.ID"),
  statics((schema) => ({ create: () => schema.make(`stl_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

/** Tool names reach the model catalog directly, so keep them namespace-safe and non-empty. */
export const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)).pipe(
  Schema.brand("SessionTool.Name"),
)
export type Name = typeof Name.Type

export const MaxCodeBytes = 256 * 1024

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Name,
  description: Schema.String,
  code: Schema.String,
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "SessionTool.Info" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({
  name: Name,
  description: Schema.String,
  code: Schema.String.check(Schema.isMaxLength(MaxCodeBytes)).annotate({
    description: "ToolDefinition source for the session tool; loaded per unique code content.",
  }),
}).annotate({ identifier: "SessionTool.Payload" })
