export * as Log from "./log.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { optional, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("log")).pipe(
  Schema.brand("Log.ID"),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "log_" + ascending()) })),
)
export type ID = typeof ID.Type

/**
 * Session-scoped mutating operations recorded by the HTTP control plane,
 * covering the whole Session lifecycle. This is the write-audit surface;
 * read-side history stays in `session_message` and the durable `event` log.
 */
export const Source = Schema.Literals([
  // Session lifecycle
  "session.create",
  "session.update",
  "session.move",
  "session.fork",
  "session.import",
  "session.interrupt",
  "session.background",
  "session.killSandbox",
  "session.keepAlive",
  "session.snapshot.create",
  "session.view",
  "session.environment",
  "session.permissions",
  // Turn entry points
  "session.prompt",
  "session.synthetic",
  "session.command",
  "session.skill",
  "session.shell",
  "session.compact",
  // Revert
  "session.revert.stage",
  "session.revert.commit",
  "session.revert.clear",
  // Definition CRUD
  "session.agentDefinition.create",
  "session.agentDefinition.delete",
  "session.agentDefinition.clear",
  "session.agentDefinition.permissionPreset",
  "session.commandDefinition.create",
  "session.commandDefinition.delete",
  "session.commandDefinition.clear",
  "session.toolDefinition.create",
  "session.toolDefinition.delete",
  "session.toolDefinition.clear",
  "session.skillDefinition.create",
  "session.skillDefinition.delete",
  "session.skillDefinition.clear",
  "session.mcpDefinition.create",
  "session.mcpDefinition.delete",
  "session.mcpDefinition.clear",
  // Instruction documents
  "session.agentsMd.update",
  "session.agentsMd.remove",
  // Interaction responses
  "permission.respond",
  "session.form.reply",
  "session.form.cancel",
  "session.inbox.update",
  "session.inbox.cancel",
  // Selections
  "session.agent.select",
  "session.model.select",
])
export type Source = typeof Source.Type

/** Payload context for an audit entry. Oversized payloads degrade to a truncation marker. */
export const Detail = Schema.Record(Schema.String, Schema.Unknown)
export type Detail = typeof Detail.Type

export const MaxDetailBytes = 8192

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  source: Source,
  detail: Detail.pipe(optional),
  time: Schema.Struct({ created: Schema.Number }).annotate({
    description: "Epoch milliseconds at which the audited operation completed.",
  }),
}).annotate({ identifier: "Log.Info" })
