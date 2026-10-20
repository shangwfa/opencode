export * as ConnectorMcp from "./connector-mcp.js"

import { Schema } from "effect"

export const Selection = Schema.Struct({ actionId: Schema.String, name: Schema.String, contractHash: Schema.String })
export const Selections = Schema.Array(Selection)
export const Create = Schema.Struct({
  name: Schema.String,
  service: Schema.String,
  connectionId: Schema.optional(Schema.String),
  actionIds: Schema.Array(Schema.String),
})
export type Create = typeof Create.Type
export const Update = Schema.Struct({
  revision: Schema.Int,
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "disabled"])),
  actionIds: Schema.optional(Schema.Array(Schema.String)),
  confirmContracts: Schema.optional(Schema.Boolean),
})
export type Update = typeof Update.Type
export const Revision = Schema.Struct({ revision: Schema.Int })
export const Info = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  service: Schema.String,
  connectionId: Schema.NullOr(Schema.String),
  status: Schema.String,
  revision: Schema.Int,
  tools: Selections,
  tokenPrefix: Schema.String,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
})
export type Info = typeof Info.Type
export const Issued = Schema.Struct({ deployment: Info, token: Schema.String })
export const List = Schema.Struct({ deployments: Schema.Array(Info) })
