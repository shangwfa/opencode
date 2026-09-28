export * as SessionMcp from "./session-mcp.js"

import { Schema } from "effect"
import { Mcp } from "./mcp.js"
import { optional, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("smcp_")).pipe(
  Schema.brand("SessionMcp.ID"),
  statics((schema) => ({ create: () => schema.make(`smcp_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

/** Stable server names keep generated MCP Tool namespaces unambiguous. */
export const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)).pipe(Schema.brand("SessionMcp.Name"))
export type Name = typeof Name.Type

/**
 * Session MCPs are isolated connection overlays. OAuth is intentionally owned by the Location-wide
 * Integration domain, so private entries use anonymous or header authentication only.
 */
export class RemoteConfig extends Schema.Class<RemoteConfig>("SessionMcp.RemoteConfig")({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional),
  oauth: Schema.Literal(false),
  disabled: Schema.Boolean.pipe(optional),
  codemode: Schema.Boolean.pipe(optional),
  timeout: Mcp.TimeoutConfig.pipe(optional),
  protocol: Mcp.Protocol.pipe(optional),
}) {}

export const Config = Schema.Union([Mcp.LocalConfig, RemoteConfig]).pipe(Schema.toTaggedUnion("type"))
export type Config = typeof Config.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Name,
  config: Config,
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "SessionMcp.Info" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({
  name: Name,
  config: Config,
}).annotate({ identifier: "SessionMcp.Payload" })
