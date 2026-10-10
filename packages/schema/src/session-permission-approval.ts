export * as SessionPermissionApproval from "./session-permission-approval.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { Permission } from "./permission.js"
import { DateTimeUtcFromMillis, optional, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("spa_")).pipe(
  Schema.brand("SessionPermissionApproval.ID"),
  statics((schema) => ({ create: () => schema.make("spa_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  action: Schema.String,
  resource: Schema.String,
  sourceRequestID: Permission.ID.pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis, updated: DateTimeUtcFromMillis }),
}).annotate({ identifier: "SessionPermissionApproval.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
