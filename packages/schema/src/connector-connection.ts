export * as ConnectorConnection from "./connector-connection.js"

import { Schema } from "effect"
import { optional, statics } from "./schema.js"
import { SessionMcp } from "./session-mcp.js"

export const ID = Schema.String.check(Schema.isStartsWith("ccon_")).pipe(
  Schema.brand("ConnectorConnection.ID"),
  statics((schema) => ({ create: () => schema.make(`ccon_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

/** Trigger schedule ids share the connection namespace prefix style but use their own prefix. */
export const TriggerID = Schema.String.check(Schema.isStartsWith("ctrg_")).pipe(
  Schema.brand("ConnectorTrigger.ID"),
  statics((schema) => ({ create: () => schema.make(`ctrg_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type TriggerID = typeof TriggerID.Type

/** Connection kinds creatable through the session-scoped connector API; oauth2 arrives via the OAuth request flow. */
export const AuthType = Schema.Literals(["api_key", "custom_credential", "oauth2"])
export type AuthType = typeof AuthType.Type

/** Direct-create kinds; OAuth connections are created through the request flow instead. */
export const CreateAuthType = Schema.Literals(["api_key", "custom_credential"])
export type CreateAuthType = typeof CreateAuthType.Type

/** Auth kinds a provider advertises in its catalog entry; a superset of connection `AuthType` (adds `no_auth`). */
export const ProviderAuthType = Schema.Literals(["no_auth", "api_key", "custom_credential", "oauth2"])
export type ProviderAuthType = typeof ProviderAuthType.Type

export const Status = Schema.Literals(["creating", "active", "deleting", "deleted"])
export type Status = typeof Status.Type

/** Engine-side lifecycle merged from the engine: active | reauth_required | error | disconnected. */
export const EngineStatus = Schema.String
export type EngineStatus = typeof EngineStatus.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  service: Schema.String,
  alias: Schema.String,
  authType: AuthType,
  status: Status,
  engineConnectionID: Schema.String,
  /** Live engine state; `error`/`disconnected` are synthesized when the engine call fails or no longer knows the connection. */
  engineStatus: EngineStatus,
  /** Provider account display name when the engine reports one. */
  accountLabel: Schema.String.pipe(optional),
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "ConnectorConnection.Info" })

export interface CreatePayload extends Schema.Schema.Type<typeof CreatePayload> {}
export const CreatePayload = Schema.Struct({
  service: Schema.String,
  authType: CreateAuthType,
  /** api_key auth sends the secret as `apiKey` and provider extras alongside; custom_credential sends all fields here. */
  values: Schema.Record(Schema.String, Schema.String),
  alias: Schema.String.pipe(optional),
}).annotate({ identifier: "ConnectorConnection.CreatePayload" })

export interface ListResult extends Schema.Schema.Type<typeof ListResult> {}
export const ListResult = Schema.Struct({
  connections: Schema.Array(Info),
}).annotate({ identifier: "ConnectorConnection.ListResult" })

/** Returned shape is directly registrable via `session.mcpDefinitions.create`. */
export const McpAttachResult = SessionMcp.Payload
export type McpAttachResult = SessionMcp.Payload

export interface OAuthStart extends Schema.Schema.Type<typeof OAuthStart> {}
export const OAuthStart = Schema.Struct({
  authorizationUrl: Schema.String,
  connectionRequestID: Schema.String,
  expiresAt: Schema.String,
}).annotate({ identifier: "ConnectorConnection.OAuthStart" })

/** Re-authorization restart for an existing oauth2 connection; finish via the OAuth complete flow. */
export interface ReconnectStart extends Schema.Schema.Type<typeof ReconnectStart> {}
export const ReconnectStart = Schema.Struct({
  authorizationUrl: Schema.String,
  connectionRequestID: Schema.String,
}).annotate({ identifier: "ConnectorConnection.ReconnectStart" })

/** Admin-plane page of recent engine action runs. */
export interface RunsResult extends Schema.Schema.Type<typeof RunsResult> {}
export const RunsResult = Schema.Struct({
  items: Schema.Array(Schema.Json),
  nextCursor: Schema.String.pipe(optional),
}).annotate({ identifier: "ConnectorConnection.RunsResult" })

/** One catalog entry from the engine's connectable provider directory (admin plane passthrough). */
export interface ProviderSummary extends Schema.Schema.Type<typeof ProviderSummary> {}
export const ProviderSummary = Schema.Struct({
  service: Schema.String,
  displayName: Schema.String,
  description: Schema.String.pipe(optional),
  categories: Schema.Array(Schema.String),
  authTypes: Schema.Array(ProviderAuthType),
  iconUrl: Schema.String.pipe(optional),
  homepageUrl: Schema.String.pipe(optional),
}).annotate({ identifier: "ConnectorConnection.ProviderSummary" })

/** The connectable provider directory; `service`/`authType` filters narrow the entries server-side. */
export interface ProviderCatalog extends Schema.Schema.Type<typeof ProviderCatalog> {}
export const ProviderCatalog = Schema.Struct({
  providers: Schema.Array(ProviderSummary),
}).annotate({ identifier: "ConnectorConnection.ProviderCatalog" })

/** Wire format for transit file bytes: standard base64 (no URL-safe alphabet). */
export const FileDataBase64 = Schema.String.check(
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
).annotate({ identifier: "ConnectorConnection.FileDataBase64" })
export type FileDataBase64 = typeof FileDataBase64.Type

/** Uploads one transit file into the engine; the rewritten download URL points at the SaaS endpoint. */
export interface FileUploadPayload extends Schema.Schema.Type<typeof FileUploadPayload> {}
export const FileUploadPayload = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String.pipe(optional),
  data: FileDataBase64,
}).annotate({ identifier: "ConnectorConnection.FileUploadPayload" })

export interface FileUpload extends Schema.Schema.Type<typeof FileUpload> {}
export const FileUpload = Schema.Struct({
  fileId: Schema.String,
  /** SaaS download endpoint; falls back to a path when no public base URL is configured. */
  downloadUrl: Schema.String,
  sizeBytes: Schema.Int,
  name: Schema.String,
  mimeType: Schema.String,
}).annotate({ identifier: "ConnectorConnection.FileUpload" })

/** Simplified trigger schedule: engine subscription state plus the latest observed poll/webhook result. */
export interface TriggerInfo extends Schema.Schema.Type<typeof TriggerInfo> {}
export const TriggerInfo = Schema.Struct({
  id: TriggerID,
  service: Schema.String,
  triggerId: Schema.String,
  /** active | cancelled */
  status: Schema.String,
  config: Schema.Json,
  nextRunAt: Schema.Int,
  /** Latest engine read/receive outcome; session delivery is not implemented in this slice. */
  lastResult: Schema.Json.pipe(optional),
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "ConnectorConnection.TriggerInfo" })

export interface TriggerCreatePayload extends Schema.Schema.Type<typeof TriggerCreatePayload> {}
export const TriggerCreatePayload = Schema.Struct({
  service: Schema.String,
  triggerId: Schema.String,
  config: Schema.Json.pipe(optional),
  connectionID: ID.pipe(optional),
}).annotate({ identifier: "ConnectorConnection.TriggerCreatePayload" })
export interface TriggerListResult extends Schema.Schema.Type<typeof TriggerListResult> {}
export const TriggerListResult = Schema.Struct({
  triggers: Schema.Array(TriggerInfo),
}).annotate({ identifier: "ConnectorConnection.TriggerListResult" })

export interface OAuthComplete extends Schema.Schema.Type<typeof OAuthComplete> {}
export const OAuthComplete = Schema.Struct({
  /** initiated | connected | failed | expired */
  status: Schema.String,
  errorCode: Schema.String.pipe(optional),
  connection: Info.pipe(optional),
}).annotate({ identifier: "ConnectorConnection.OAuthComplete" })

/** One SaaS-ledger OAuth request for the session; `status` is initiated | connected | failed | expired. */
export interface OAuthRequestInfo extends Schema.Schema.Type<typeof OAuthRequestInfo> {}
export const OAuthRequestInfo = Schema.Struct({
  connectionRequestID: Schema.String,
  service: Schema.String,
  alias: Schema.String.pipe(optional),
  status: Schema.String,
  time: Schema.Struct({ created: Schema.Int, updated: Schema.Int }),
}).annotate({ identifier: "ConnectorConnection.OAuthRequestInfo" })

export interface OAuthClientPayload extends Schema.Schema.Type<typeof OAuthClientPayload> {}
export const OAuthClientPayload = Schema.Struct({
  clientId: Schema.String,
  clientSecret: Schema.String,
  extra: Schema.Record(Schema.String, Schema.String).pipe(optional),
  requestedScopes: Schema.Array(Schema.String).pipe(optional),
}).annotate({ identifier: "ConnectorConnection.OAuthClientPayload" })

export interface McpCallResult extends Schema.Schema.Type<typeof McpCallResult> {}
export const McpCallResult = Schema.Struct({
  status: Schema.Int,
  body: Schema.Json,
}).annotate({ identifier: "ConnectorConnection.McpCallResult" })
