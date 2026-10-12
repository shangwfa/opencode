import { ConnectorConnection } from "@opencode/schema/connector-connection"
import { SessionMcp } from "@opencode/schema/session-mcp"
import { PositiveInt } from "@opencode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Session } from "@opencode/schema/session"
import {
  ConflictError,
  ConnectorNotFoundError,
  InvalidRequestError,
  ServiceUnavailableError,
  UnknownError,
} from "../errors.js"

export const ConnectorGroup = HttpApiGroup.make("server.connector")
  .add(
    HttpApiEndpoint.post("connector.connection.create", "/api/session/:sessionID/connector/connections", {
      params: { sessionID: Session.ID },
      payload: ConnectorConnection.CreatePayload,
      success: ConnectorConnection.Info,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.connection.create",
          summary: "Associate a connector connection",
          description: "Creates an engine connection and associates it with the session's resource domain.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("connector.connection.list", "/api/session/:sessionID/connector/connections", {
      params: { sessionID: Session.ID },
      success: ConnectorConnection.ListResult,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.connection.list",
          summary: "List connector connections",
          description: "Lists the connections associated with the session's resource domain.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("connector.connection.remove", "/api/session/:sessionID/connector/connections/:connectionID", {
      params: { sessionID: Session.ID, connectionID: ConnectorConnection.ID },
      success: HttpApiSchema.NoContent,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.connection.remove",
          summary: "Remove a connector connection",
          description: "Deletes the engine connection and its association. The caller must own the session resource domain.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("connector.mcp.attach", "/api/session/:sessionID/connector/mcp", {
      params: { sessionID: Session.ID },
      success: SessionMcp.Payload,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.mcp.attach",
          summary: "Attach the connector MCP",
          description: "Issues a session-scoped runtime token and returns a session MCP registration for this session's connections.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("connector.mcp.call", "/api/connector/mcp", {
      payload: Schema.Json,
      headers: { authorization: Schema.String },
      success: ConnectorConnection.McpCallResult,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.mcp.call",
          summary: "Connector MCP transport",
          description: "Stateless JSON MCP passthrough to the embedded engine; authenticates with a session-scoped engine token.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("connector.oauth.start", "/api/session/:sessionID/connector/connections/oauth", {
      params: { sessionID: Session.ID },
      payload: Schema.Struct({
        service: Schema.String,
        alias: Schema.String.pipe(Schema.optional),
        authorizationOptionIds: Schema.Array(Schema.String).pipe(Schema.optional),
      }),
      success: ConnectorConnection.OAuthStart,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.oauth.start",
          summary: "Start an OAuth connection request",
          description: "Returns the authorization URL to visit; the engine stores request state in PG so any pod can complete it.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("connector.oauth.complete", "/api/session/:sessionID/connector/connections/oauth/:connectionRequestID/complete", {
      params: { sessionID: Session.ID, connectionRequestID: Schema.String },
      payload: Schema.Struct({ alias: Schema.String.pipe(Schema.optional) }),
      success: ConnectorConnection.OAuthComplete,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.oauth.complete",
          summary: "Complete an OAuth connection request",
          description: "Polls the request; once connected, associates the engine connection with the session resource domain.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("connector.oauth.client", "/api/connector/oauth/clients/:service", {
      params: { service: Schema.String },
      payload: ConnectorConnection.OAuthClientPayload,
      success: HttpApiSchema.NoContent,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.oauth.client",
          summary: "Configure an OAuth client",
          description: "Stores the OAuth client credentials a service needs before OAuth connection requests can start.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("connector.oauth.callback", "/connector/oauth/callback", {
      success: HttpApiSchema.NoContent,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.oauth.callback",
          summary: "OAuth callback passthrough",
          description: "Public provider callback forwarded to the embedded engine; the engine validates state and completes the flow.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post(
      "connector.connection.reconnect",
      "/api/session/:sessionID/connector/connections/:connectionID/reconnect",
      {
        params: { sessionID: Session.ID, connectionID: ConnectorConnection.ID },
        success: ConnectorConnection.ReconnectStart,
        error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
      },
    ).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.connection.reconnect",
        summary: "Re-authorize a connection",
        description:
          "Restarts the OAuth flow for one of the session's connections; visit the returned URL and finish with the existing OAuth complete endpoint.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("connector.runs", "/api/connector/runs", {
      query: Schema.Struct({
        cursor: Schema.String.pipe(Schema.optional),
        limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
      }),
      success: ConnectorConnection.RunsResult,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.runs",
        summary: "List recent engine action runs",
        description: "Admin-plane passthrough of the engine's action run log, newest first.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("connector.providers", "/api/connector/providers", {
      query: Schema.Struct({
        service: Schema.String.pipe(Schema.optional),
        authType: ConnectorConnection.ProviderAuthType.pipe(Schema.optional),
      }),
      success: ConnectorConnection.ProviderCatalog,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.providers",
        summary: "List connectable providers",
        description:
          "Admin-plane passthrough of the engine's provider directory; optional service/authType filters narrow the entries.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("connector.proxy", "/api/connector/proxy/:service", {
      params: { service: Schema.String },
      payload: Schema.Struct({
        sessionID: Session.ID,
        endpoint: Schema.String.annotate({ description: "Relative provider path starting with /." }),
        method: Schema.String,
        query: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
        headers: Schema.Record(Schema.String, Schema.String).pipe(Schema.optional),
        body: Schema.Json.pipe(Schema.optional),
        connectionID: ConnectorConnection.ID.pipe(Schema.optional),
      }),
      success: Schema.Json,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.proxy",
        summary: "Provider proxy passthrough",
        description:
          "Forwards one relative request to the provider API through the session's (or the no-auth sentinel) scoped token.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("connector.file.upload", "/api/connector/files", {
      payload: Schema.Struct({
        sessionID: Session.ID,
        name: ConnectorConnection.FileUploadPayload.fields.name,
        mimeType: ConnectorConnection.FileUploadPayload.fields.mimeType,
        data: ConnectorConnection.FileUploadPayload.fields.data,
      }),
      success: ConnectorConnection.FileUpload,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.file.upload",
        summary: "Upload a transit file",
        description: "Stores one transit file in the engine; the returned downloadUrl points at the SaaS download endpoint.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("connector.file.download", "/api/connector/files/:fileID", {
      params: { fileID: Schema.String },
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.file.download",
        summary: "Download a transit file",
        description: "Streams one engine transit file back through the SaaS endpoint (Basic auth).",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("connector.trigger.create", "/api/session/:sessionID/connector/triggers", {
      params: { sessionID: Session.ID },
      payload: ConnectorConnection.TriggerCreatePayload,
      success: ConnectorConnection.TriggerInfo,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.trigger.create",
        summary: "Create a trigger",
        description:
          "Mints a per-schedule engine token, registers the engine webhook subscription (callback under OPENCODE_CONNECTOR_WEBHOOK_URL), and records the binding.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("connector.trigger.list", "/api/session/:sessionID/connector/triggers", {
      params: { sessionID: Session.ID },
      success: ConnectorConnection.TriggerListResult,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.trigger.list",
        summary: "List triggers",
        description: "Lists the session's trigger schedules including the latest observed engine result.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("connector.trigger.cancel", "/api/session/:sessionID/connector/triggers/:triggerID", {
      params: { sessionID: Session.ID, triggerID: ConnectorConnection.TriggerID },
      success: HttpApiSchema.NoContent,
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.trigger.cancel",
        summary: "Cancel a trigger",
        description: "Deactivates the engine subscription (best-effort), revokes the schedule token, and cancels the row.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("connector.trigger.webhook", "/connector/webhook/:scheduleID", {
      params: { scheduleID: ConnectorConnection.TriggerID },
      success: HttpApiSchema.NoContent,
      // Any failure before the durable commit answers 500 so the provider redelivers.
      error: [ConnectorNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "connector.trigger.webhook",
        summary: "Trigger webhook ingress",
        description:
          "Public provider callback forwarded to the engine receive operation; the engine validates the subscription nonce and signature.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("connector.reconcile", "/api/connector/reconcile", {
      success: Schema.Struct({ removed: Schema.Int }),
      error: [ConflictError, ConnectorNotFoundError, InvalidRequestError, ServiceUnavailableError],
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "connector.reconcile",
          summary: "Reconcile orphan engine connections",
          description:
            "Deletes engine connections that no SaaS row references. Do not run while OAuth connection requests are in flight.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "connector" }))
