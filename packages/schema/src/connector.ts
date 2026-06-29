export * as Connector from "./connector"

import { Schema } from "effect"
import { optional } from "./schema"
import { ascending } from "./identifier"
import { statics } from "./schema"
import { define, inventory } from "./event"

export const ID = Schema.String.pipe(Schema.brand("Connector.ID"))
export type ID = typeof ID.Type

export const MethodID = Schema.String.pipe(Schema.brand("Connector.MethodID"))
export type MethodID = typeof MethodID.Type

export const AttemptID = Schema.String.pipe(
  Schema.brand("Connector.AttemptID"),
  statics((schema) => ({ create: () => schema.make("con_" + ascending()) })),
)
export type AttemptID = typeof AttemptID.Type

export interface When extends Schema.Schema.Type<typeof When> {}
export const When = Schema.Struct({
  key: Schema.String,
  op: Schema.Literals(["eq", "neq"]),
  value: Schema.String,
}).annotate({ identifier: "Connector.When" })

export interface TextPrompt extends Schema.Schema.Type<typeof TextPrompt> {}
export const TextPrompt = Schema.Struct({
  type: Schema.Literal("text"),
  key: Schema.String,
  message: Schema.String,
  placeholder: optional(Schema.String),
  when: optional(When),
}).annotate({ identifier: "Connector.TextPrompt" })

export interface SelectPrompt extends Schema.Schema.Type<typeof SelectPrompt> {}
export const SelectPrompt = Schema.Struct({
  type: Schema.Literal("select"),
  key: Schema.String,
  message: Schema.String,
  options: Schema.Array(
    Schema.Struct({
      label: Schema.String,
      value: Schema.String,
      hint: optional(Schema.String),
    }),
  ),
  when: optional(When),
}).annotate({ identifier: "Connector.SelectPrompt" })

export const Prompt = Schema.Union([TextPrompt, SelectPrompt]).pipe(Schema.toTaggedUnion("type"))
export type Prompt = typeof Prompt.Type

export interface OAuthMethod extends Schema.Schema.Type<typeof OAuthMethod> {}
export const OAuthMethod = Schema.Struct({
  id: MethodID,
  type: Schema.Literal("oauth"),
  label: Schema.String,
  prompts: optional(Schema.Array(Prompt)),
}).annotate({ identifier: "Connector.OAuthMethod" })

export interface KeyMethod extends Schema.Schema.Type<typeof KeyMethod> {}
export const KeyMethod = Schema.Struct({
  id: MethodID,
  type: Schema.Literal("key"),
  label: Schema.String,
  prompts: optional(Schema.Array(Prompt)),
}).annotate({ identifier: "Connector.KeyMethod" })

export const Method = Schema.Union([OAuthMethod, KeyMethod])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Connector.Method" })
export type Method = typeof Method.Type

export class Info extends Schema.Class<Info>("Connector.Info")({
  id: ID,
  name: Schema.String,
  methods: Schema.Array(Method),
}) {}

const Updated = define({
  type: "connector.updated",
  schema: {},
})
export const Event = { Updated, Definitions: inventory(Updated) }

const AttemptTime = Schema.Struct({
  created: Schema.Number,
  expires: Schema.Number,
})

export class Attempt extends Schema.Class<Attempt>("Connector.Attempt")({
  attemptID: AttemptID,
  url: Schema.String,
  instructions: Schema.String,
  mode: Schema.Literals(["auto", "code"]),
  time: AttemptTime,
}) {}

export const AttemptStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending"), time: AttemptTime }),
  Schema.Struct({ status: Schema.Literal("complete"), time: AttemptTime }),
  Schema.Struct({ status: Schema.Literal("failed"), message: Schema.String, time: AttemptTime }),
  Schema.Struct({ status: Schema.Literal("expired"), time: AttemptTime }),
])
  .pipe(Schema.toTaggedUnion("status"))
  .annotate({ identifier: "Connector.AttemptStatus" })
export type AttemptStatus = typeof AttemptStatus.Type
