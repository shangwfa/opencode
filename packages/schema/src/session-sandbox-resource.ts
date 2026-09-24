export * as SessionSandboxResource from "./session-sandbox-resource.js"

import { Schema } from "effect"

export const Info = Schema.Struct({
  cpu: Schema.String,
  memory: Schema.String,
}).annotate({ identifier: "Session.SandboxResource" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
