export * as Command from "./command.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"

const Updated = ephemeral({ type: "command.updated", schema: {} })
const Executed = ephemeral({
  type: "command.executed",
  schema: {
    sessionID: SessionID,
    name: Schema.String,
    arguments: optional(Schema.String),
  },
})

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Command.Info" })

export const Event = {
  Updated,
  Executed,
  Definitions: inventory(Updated, Executed),
}
