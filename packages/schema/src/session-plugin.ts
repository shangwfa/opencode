export * as SessionPlugin from "./session-plugin.js"

import { Schema } from "effect"
import { statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("spl_")).pipe(
  Schema.brand("SessionPlugin.ID"),
  statics((schema) => ({ create: () => schema.make(`spl_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

/** Plugin names are user-facing keys, so keep them namespace-safe and non-empty. */
export const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)).pipe(
  Schema.brand("SessionPlugin.Name"),
)
export type Name = typeof Name.Type

export const MaxCodeBytes = 256 * 1024
export const MaxSpecLength = 512

export class CodeTooLargeError extends Schema.TaggedError<CodeTooLargeError>()(
  "SessionPluginCodeTooLargeError",
  {
    actualBytes: Schema.Int,
    maxBytes: Schema.Int,
    message: Schema.String,
  },
  { httpApiStatus: 413 },
) {}

/** SaaS sandbox hook module (not the global `{ id, effect }` Plugin registration API). */
export interface CodeSource extends Schema.Schema.Type<typeof CodeSource> {}
export const CodeSource = Schema.Struct({
  type: Schema.Literal("code"),
  code: Schema.String.annotate({
    description:
      "SaaS session hook factory source; loaded inside the session sandbox. This is not the global `{ id, effect }` Plugin API.",
  }),
}).annotate({ identifier: "SessionPlugin.CodeSource" })

/** Registry plugin source: an npm spec resolved and installed inside the session sandbox. */
export interface NpmSource extends Schema.Schema.Type<typeof NpmSource> {}
export const NpmSource = Schema.Struct({
  type: Schema.Literal("npm"),
  spec: Schema.String.check(Schema.isMaxLength(MaxSpecLength)).annotate({
    description: "npm package spec, e.g. @scope/package or @scope/package@1.2.3.",
  }),
}).annotate({ identifier: "SessionPlugin.NpmSource" })

export const Source = Schema.Union([CodeSource, NpmSource]).pipe(Schema.toTaggedUnion("type"))
export type Source = typeof Source.Type

export const CodeSourceInfo = Schema.Struct({ type: Schema.Literal("code") }).annotate({
  identifier: "SessionPlugin.CodeSourceInfo",
})
export const NpmSourceInfo = NpmSource
export const SourceInfo = Schema.Union([CodeSourceInfo, NpmSourceInfo]).pipe(Schema.toTaggedUnion("type"))
export type SourceInfo = typeof SourceInfo.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  name: Name,
  description: Schema.String,
  source: SourceInfo,
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "SessionPlugin.Info" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({
  name: Name,
  description: Schema.String,
  source: Source,
}).annotate({ identifier: "SessionPlugin.Payload" })
