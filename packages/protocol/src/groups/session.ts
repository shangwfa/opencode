import { SessionMessage } from "@opencode/schema/session-message"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { PromptInput } from "@opencode/schema/prompt-input"
import { Session } from "@opencode/schema/session"
import { SessionStats } from "@opencode/schema/session-stats"
import { InstructionEntry } from "@opencode/schema/instruction-entry"
import { Project } from "@opencode/schema/project"
import {
  AbsolutePath,
  DateTimeUtcFromMillis,
  NonNegativeInt,
  PositiveInt,
  RelativePath,
  statics,
} from "@opencode/schema/schema"
import { Event } from "@opencode/schema/event"
import { Context, Effect, Encoding, Result, Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  CommandExecutionError,
  CommandNotFoundError,
  FormAlreadySettledError,
  FormInvalidAnswerError,
  FormNotFoundError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
  SessionNotFoundError,
  SkillNotFoundError,
  UnknownError,
} from "../errors.js"
import { Agent } from "@opencode/schema/agent"
import { Skill } from "@opencode/schema/skill"
import { Model } from "@opencode/schema/model"
import { Permission } from "@opencode/schema/permission"
import { Location } from "@opencode/schema/location"
import { Workspace } from "@opencode/schema/workspace"
import { SessionEvent } from "@opencode/schema/session-event"
import { EventLog } from "@opencode/schema/event-log"
import { FileDiff } from "@opencode/schema/file-diff"
import { Form } from "@opencode/schema/form"
import { SandboxResource } from "@opencode/schema/sandbox-resource"
import { PublicSessionMessage } from "./message.js"

const ParentIDFilter = Schema.Union([
  Session.ID,
  Schema.Null.pipe(
    Schema.encodeTo(Schema.Literal("null"), {
      decode: SchemaGetter.transform(() => null),
      encode: SchemaGetter.transform(() => "null" as const),
    }),
  ),
]).annotate({
  description: "Filter by parent session. Use null to return only root sessions.",
})

const SessionsQueryFields = {
  appId: Schema.String.pipe(Schema.optional).annotate({
    description: "Only return sessions created with this business application id.",
  }),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
  parentID: ParentIDFilter.pipe(Schema.optional),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

const SessionsProjectQuery = Schema.Struct({
  ...SessionsQueryFields,
  project: Project.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsProjectQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)
const invalidCursor = "Invalid cursor" as const

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionsCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionActive = Schema.Struct({
  type: Schema.Literal("running"),
}).annotate({ identifier: "SessionActive" })

const PublicSessionInfo = Schema.Struct({
  ...Struct.omit(Session.Info.fields, ["location"]),
  // SaaS: expose the bound workspace so clients can address sandbox files via
  // the fs endpoints (x-opencode-workspace). Upstream's PublicRef omits it.
  location: Location.Ref,
}).annotate({ identifier: "Session.Info" })

const PublicSessionTransfer = Schema.Struct({
  info: PublicSessionInfo,
  messages: Schema.Array(PublicSessionMessage),
}).annotate({ identifier: "SessionTransfer.Data" })

const PublicMovePayload = Schema.Struct({
  ...Struct.omit(SessionInbox.MovePayload.fields, ["location"]),
  location: Location.PublicRef,
}).annotate({ identifier: "Session.Inbox.MovePayload" })

const PublicMove = Schema.Struct({
  ...Struct.omit(SessionInbox.Move.fields, ["payload"]),
  payload: PublicMovePayload,
}).annotate({ identifier: "Session.Inbox.Move" })

const PublicInboxInfo = Schema.Union([
  SessionInbox.User,
  SessionInbox.Synthetic,
  SessionInbox.Compaction,
  PublicMove,
]).annotate({ identifier: "Session.Inbox.Info" })

const FormCreatePayload = Schema.Struct({
  id: Form.ID.pipe(Schema.optional),
  title: Form.Info.fields.title,
  metadata: Form.Info.fields.metadata,
  fields: Form.Info.fields.fields,
}).annotate({ identifier: "Form.CreatePayload" })

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  project: Project.ID.pipe(Schema.optional),
  subpath: RelativePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const makeSessionGroup = <
  I extends HttpApiMiddleware.AnyId,
  S,
  FormI extends HttpApiMiddleware.AnyId,
  FormS,
  LI extends HttpApiMiddleware.AnyId,
  LS,
>(
  sessionLocationMiddleware: Context.Key<I, S>,
  formLocationMiddleware: Context.Key<FormI, FormS>,
  locationMiddleware: Context.Key<LI, LS>,
) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(PublicSessionInfo),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.stats", "/api/experimental/session/stats", {
        query: Schema.Struct({
          from: Schema.NumberFromString.pipe(Schema.optional),
          to: Schema.NumberFromString.pipe(Schema.optional),
          project: Project.ID.pipe(Schema.optional),
          timezone: Schema.String.pipe(Schema.optional),
          tools: SessionStats.ToolMode.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionStats.Info }),
        error: InvalidRequestError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.stats",
          summary: "Get session statistics",
          description: "Aggregate local session activity, usage, and tool reliability for a time range.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.status", "/api/session/status", {
        success: Schema.Struct({
          data: Schema.Struct({
            active: Schema.Array(Session.ID),
          }).annotate({ identifier: "SessionStatusResponse" }),
        }).annotate({ identifier: "SessionActiveStatus" }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.status",
          summary: "Get session status",
          description:
            "Snapshot the sessions whose execution this process currently owns (the busy set; everything else is idle).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.exec", "/api/session/:sessionID/exec", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          command: Schema.String,
          workingDirectory: Schema.String.pipe(Schema.optional),
          timeoutSeconds: Schema.Number.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          exitCode: Schema.Number,
          stdout: Schema.String,
          stderr: Schema.String,
          signal: Schema.String.pipe(Schema.optional),
          oomSuspected: Schema.Boolean.pipe(Schema.optional),
        }).annotate({ identifier: "SessionExecResult" }),
        error: [SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.exec",
            summary: "Run a command in the session sandbox",
            description:
              "Executes a shell command inside the session's sandbox workspace (created on demand). Synchronous: waits for exit.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.execAsync", "/api/session/:sessionID/exec/async", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          command: Schema.String,
          workingDirectory: Schema.String.pipe(Schema.optional),
          timeoutSeconds: Schema.Number.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          execId: Schema.String,
          status: Schema.Literals(["running"]),
        }).annotate({ identifier: "SessionExecAsyncStarted" }),
        error: [ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.execAsync",
            summary: "Start a detached sandbox command",
            description:
              "Starts a shell command inside the session's sandbox and returns immediately. Stream logs via /exec/:execID/stream or poll /exec/:execID.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.execStatus", "/api/session/:sessionID/exec/:execID", {
        params: { sessionID: Session.ID, execID: Schema.String },
        success: Schema.Struct({
          id: Schema.String,
          command: Schema.String,
          status: Schema.Literals(["running", "completed", "failed", "killed", "timed_out"]),
          exitCode: Schema.Number.pipe(Schema.optional),
          stdout: Schema.String.pipe(Schema.optional),
          stderr: Schema.String.pipe(Schema.optional),
          workingDirectory: Schema.String.pipe(Schema.optional),
          startedAt: Schema.Number,
          finishedAt: Schema.Number.pipe(Schema.optional),
        }).annotate({ identifier: "SessionExecStatus" }),
        error: [ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.execStatus",
            summary: "Query a detached command",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.execs", "/api/session/:sessionID/execs", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          execs: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              command: Schema.String,
              status: Schema.Literals(["running", "completed", "failed", "killed", "timed_out"]),
              exitCode: Schema.Number.pipe(Schema.optional),
              startedAt: Schema.Number,
              finishedAt: Schema.Number.pipe(Schema.optional),
            }),
          ),
        }).annotate({ identifier: "SessionExecList" }),
        error: [ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.execList",
            summary: "List detached commands",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.execKill", "/api/session/:sessionID/exec/:execID/kill", {
        params: { sessionID: Session.ID, execID: Schema.String },
        success: Schema.Struct({ killed: Schema.Boolean }).annotate({ identifier: "SessionExecKillResult" }),
        error: [ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.execKill",
            summary: "Kill a detached command",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.execStream", "/api/session/:sessionID/exec/:execID/stream", {
        params: { sessionID: Session.ID, execID: Schema.String },
        success: HttpApiSchema.StreamSse({
          data: Schema.Struct({
            event: Schema.Literals(["stdout", "stderr", "done"]),
            text: Schema.String.pipe(Schema.optional),
            status: Schema.String.pipe(Schema.optional),
            exitCode: Schema.Number.pipe(Schema.optional),
          }),
        }),
        error: [ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.execStream",
            summary: "Stream a detached command's output",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.keepAlive", "/api/session/:sessionID/keep-alive", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          enabled: Schema.Boolean,
          boot: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({
          keepAlive: Schema.Boolean,
          workspaceID: Workspace.ID.pipe(Schema.optional),
        }).annotate({ identifier: "SessionKeepAliveResult" }),
        error: [SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.keepAlive.set",
            summary: "Keep the session sandbox alive (v1 parity)",
            description:
              "Marks the session's sandbox as exempt from idle suspension. With boot=true the sandbox is provisioned immediately.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.keepAliveGet", "/api/session/:sessionID/keep-alive", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ keepAlive: Schema.Boolean }).annotate({ identifier: "SessionKeepAliveStatus" }),
        error: [SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.keepAlive.get",
            summary: "Query the keep-alive flag",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.sandbox", "/api/session/:sessionID/sandbox", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          workspaceID: Workspace.ID.pipe(Schema.optional),
        }).annotate({ identifier: "SessionSandboxStatus" }),
        error: [SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.sandbox.get",
            summary: "Query the session sandbox",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.snapshot", "/api/session/:sessionID/snapshot", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          snapshotId: Schema.String,
        }).annotate({ identifier: "SessionSnapshotResult" }),
        error: [ServiceUnavailableError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.snapshot",
            summary: "Snapshot the session sandbox",
            description:
              "Creates a snapshot of the sandbox's current state without killing it. The sandbox stays running; the binding records the snapshot for later restore.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.killSandbox", "/api/session/:sessionID/kill-sandbox", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          workspaceID: Workspace.ID.pipe(Schema.optional),
          destroyed: Schema.Boolean,
        }).annotate({ identifier: "SessionKillSandboxResult" }),
        error: [SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.killSandbox",
            summary: "Destroy the session sandbox",
            description:
              "Destroys the session's sandbox workspace. The next tool execution or exec provisions a fresh sandbox (v1 kill-sandbox parity).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          title: Schema.String.pipe(Schema.optional),
          /** Business-side application identifier; 1-128 chars of [a-zA-Z0-9_-.]. */
          appId: Schema.String.check(Schema.isPattern(/^[\w\-.]{1,128}$/)).pipe(Schema.optional),
          /** Derives a fresh summary of this source session into the new session (v1 summaryFrom). */
          summaryFrom: Session.ID.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          location: Location.PublicRef.pipe(Schema.optional),
          metadata: Session.Metadata.pipe(Schema.optional),
          permissions: Permission.Ruleset.pipe(Schema.optional),
          sandbox: SandboxResource.Resource.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: PublicSessionInfo }),
      })
        .middleware(locationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Create session",
          description: "Create a session at the requested location.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.import", "/api/experimental/session/import", {
        payload: Schema.Struct({
          ...PublicSessionTransfer.fields,
          location: Location.PublicRef.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: PublicSessionInfo }),
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.import",
          summary: "Import session",
          description:
            "Import a projected session transcript at the requested location. If parentID is supplied, the parent session must already exist; import parents before children.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.export", "/api/experimental/session/:sessionID/export", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({ sanitize: BooleanFromString.pipe(Schema.optional) }),
        success: Schema.Struct({ data: PublicSessionTransfer }),
        error: [SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "experimental.session.export",
          summary: "Export session",
          description: "Export a complete projected session transcript.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.active",
          summary: "List active sessions",
          description:
            "Retrieve foreground Session drains currently owned by this OpenCode process. Sessions absent from the result are inactive.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: PublicSessionInfo }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.get",
          summary: "Get session",
          description: "Retrieve a session by ID.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("session.remove", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
        OpenApi.annotations({
          identifier: "session.remove",
          summary: "Delete session",
          description: "Delete a session and its child sessions.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.fork", "/api/session/:sessionID/fork", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ before: SessionMessage.ID.pipe(Schema.optional) }),
        success: Schema.Struct({ data: PublicSessionInfo }),
        error: [SessionNotFoundError, MessageNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description:
              "Create a child session by copying projected history before a message. Omit before to copy the full history.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.switchModel",
            summary: "Switch session model",
            description: "Switch the model used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("session.update", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          title: Schema.String.pipe(Schema.optional),
          permissions: Permission.Ruleset.pipe(Schema.optional),
          sandbox: SandboxResource.Resource.pipe(Schema.optional),
          recreate: Schema.Boolean.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Update session",
            description: "Update mutable session properties.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.move", "/api/session/:sessionID/move", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ ...Location.PublicRef.fields, delivery: SessionInbox.Delivery.pipe(Schema.optional) }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.move",
          summary: "Move session",
          description: "Move a session to another project directory at the requested delivery boundary.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          ...PromptInput.Prompt.fields,
          metadata: SessionInbox.UserPayload.fields.metadata,
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInbox.User }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.promptStream", "/api/session/:sessionID/prompt_stream", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          ...PromptInput.Prompt.fields,
          metadata: SessionInbox.UserPayload.fields.metadata,
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
        }),
        success: HttpApiSchema.StreamSse({ data: Schema.Unknown }),
        error: [ConflictError, InvalidRequestError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_stream",
            summary: "Send message and stream the turn",
            description:
              "Admit one session input and stream that session's events until the turn settles (execution succeeded/failed/interrupted), then close the stream.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          name: Schema.String,
          ...PromptInput.Prompt.fields,
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, CommandNotFoundError, CommandExecutionError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Run command",
            description: "Execute a slash command callback immediately.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.skill", "/api/experimental/session/:sessionID/skill", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: Skill.ID,
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SkillNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.skill",
            summary: "Activate skill",
            description: "Activate a skill for a session by appending a skill message and resuming execution.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.synthetic", "/api/session/:sessionID/synthetic", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          text: Schema.String,
          description: Schema.String.pipe(Schema.optional),
          metadata: SessionMessage.Synthetic.fields.metadata,
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInbox.Synthetic }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.synthetic",
            summary: "Add synthetic message",
            description: "Durably admit synthetic session input and schedule execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          command: Schema.String,
        }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description:
              "Execute one shell command in the session's working directory. Emits a shell.started event before execution and a shell.ended event with the merged output after.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          delivery: SessionInbox.Delivery.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInbox.Compaction }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.compact",
            summary: "Compact session",
            description:
              "Durably admit a session compaction request. Steers by default: it runs at the next step boundary instead of waiting behind queued prompts.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/experimental/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.wait",
            summary: "Wait for session",
            description: "Wait for a session agent loop to become idle.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Session.Revert }),
        error: [MessageNotFoundError, SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.revert.clear", "/api/session/:sessionID/revert", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, SessionBusyError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(PublicSessionMessage) }),
        error: [SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.context",
          summary: "Get session context",
          description: "Retrieve the active context messages for a session (all messages after the last compaction).",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.diff", "/api/session/:sessionID/diff", {
        params: { sessionID: Session.ID },
        query: Schema.Struct({
          from: Schema.optional(SessionMessage.ID).annotate({
            description: "User message whose turn to diff. Defaults to the turn of the newest user message.",
          }),
          to: Schema.optional(SessionMessage.ID).annotate({
            description: "Later user message whose turn ends the range. Defaults to the turn of `from` alone.",
          }),
          context: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional).annotate({
            description: "Unchanged lines around each hunk. Omit for full-file patches.",
          }),
        }),
        success: Schema.Struct({ data: Schema.Array(FileDiff.Info) }),
        error: [InvalidRequestError, MessageNotFoundError, SessionNotFoundError, UnknownError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.diff",
          summary: "Diff session turns",
          description:
            "Structured per-file diffs of the files a turn changed. A turn runs from the first prompt after the session was last idle until its next idle marker, so prompts steered in while it was busy belong to the same turn; `to` extends the range through a later turn. Compares the range's first recorded snapshot with its last; a step still running in the active session compares against the working copy. Ranges that span a location change are rejected. In sessions without any idle marker, a prompt's turn spans until the next user message.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.inbox.list", "/api/session/:sessionID/inbox", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(PublicInboxInfo) }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.inbox.list",
          summary: "List session inbox",
          description:
            "List durable enqueued session work not yet delivered, ordered by enqueue sequence. Includes user, synthetic, compaction, and move items.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.delete("session.inbox.cancel", "/api/session/:sessionID/inbox/:inboxID", {
        params: { sessionID: Session.ID, inboxID: SessionMessage.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.inbox.cancel",
          summary: "Cancel inbox input",
          description: "Cancel an inbox item that has not yet been delivered. Unavailable items are a no-op.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.patch("session.inbox.update", "/api/session/:sessionID/inbox/:inboxID", {
        params: { sessionID: Session.ID, inboxID: SessionMessage.ID },
        payload: Schema.Struct({ delivery: SessionInbox.Delivery }),
        success: HttpApiSchema.NoContent,
        error: [ConflictError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.inbox.update",
          summary: "Update inbox item",
          description: "Change a pending inbox item's delivery mode. Steering wakes session execution.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get(
        "session.instructions.entry.list",
        "/api/experimental/session/:sessionID/instructions/entries",
        {
          params: { sessionID: Session.ID },
          success: Schema.Struct({ data: Schema.Array(InstructionEntry.Info) }),
          error: SessionNotFoundError,
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.instructions.entry.list",
            summary: "List instruction entries",
            description: "List API-managed instruction entries attached to the session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put(
        "session.instructions.entry.put",
        "/api/experimental/session/:sessionID/instructions/entries/:key",
        {
          params: { sessionID: Session.ID, key: InstructionEntry.Key },
          payload: Schema.Struct({ value: Schema.Json }),
          success: HttpApiSchema.NoContent,
          error: [SessionNotFoundError, InstructionEntry.ValueTooLargeError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.instructions.entry.put",
            summary: "Put instruction entry",
            description:
              "Attach or replace one durable instruction entry. Changes announce as updates at the next step boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete(
        "session.instructions.entry.remove",
        "/api/experimental/session/:sessionID/instructions/entries/:key",
        {
          params: { sessionID: Session.ID, key: InstructionEntry.Key },
          success: HttpApiSchema.NoContent,
          error: SessionNotFoundError,
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.instructions.entry.remove",
            summary: "Remove instruction entry",
            description:
              "Remove one instruction entry; the removal is announced to the model at the next step boundary.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.generate", "/api/session/:sessionID/generate", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ prompt: Schema.String }),
        success: Schema.Struct({
          data: Schema.Struct({ text: Schema.String }),
        }).annotate({ identifier: "SessionGenerateResponse" }),
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.generate",
            summary: "Generate text from session context",
            description: "Generate transient text from the current session context without mutating session history.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.log", "/api/experimental/session/:sessionID/log", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(Event.Seq), Schema.optional),
          follow: BooleanFromString.pipe(Schema.optional),
        },
        success: HttpApiSchema.StreamSse({
          data: Schema.Union([SessionEvent.Durable, EventLog.Synced]).annotate({ identifier: "SessionLogItem" }),
        }),
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.log",
          summary: "Read the session log",
          description:
            "Experimental durable session event log. Reads events after an exclusive aggregate sequence and continues with live events when follow=true.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        query: { resume: BooleanFromString.pipe(Schema.optional) },
        success: Schema.Struct({
          interrupted: Schema.Boolean.annotate({
            description: "Whether an active execution owned by this OpenCode process was interrupted.",
          }),
        }).annotate({ identifier: "SessionInterruptResponse" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.interrupt",
            summary: "Interrupt session execution",
            description:
              "Interrupt active execution owned by this OpenCode process. Returns interrupted=true when an active execution was interrupted and false for the idle no-op. When resume=true, execution resumes pending steering input and next-in-line control items (manual compaction, moves) while queued prompts remain parked.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.background", "/api/session/:sessionID/background", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.background",
            summary: "Background blocking session tools",
            description:
              "Move active foreground backgroundable tools for this session into background observation. Idle requests are a no-op.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: PublicSessionMessage }),
        error: [SessionNotFoundError, MessageNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.message.get",
          summary: "Get session message",
          description: "Retrieve one projected message owned by the Session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.form.list", "/api/session/:sessionID/form", {
        params: { sessionID: Schema.String },
        success: Schema.Struct({ data: Schema.Array(Form.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.list",
            summary: "List session forms",
            description: "Retrieve pending forms for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.form.create", "/api/session/:sessionID/form", {
        params: { sessionID: Schema.String },
        payload: FormCreatePayload,
        success: Schema.Struct({ data: Form.Info }),
        error: [SessionNotFoundError, ConflictError, InvalidRequestError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.create",
            summary: "Create session form",
            description: "Create a form for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.form.get", "/api/session/:sessionID/form/:formID", {
        params: { sessionID: Schema.String, formID: Form.ID },
        success: Schema.Struct({ data: Form.Detail }),
        error: [SessionNotFoundError, FormNotFoundError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.get",
            summary: "Get session form",
            description: "Retrieve a form and its current state for a session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.form.reply", "/api/session/:sessionID/form/:formID/reply", {
        params: { sessionID: Schema.String, formID: Form.ID },
        payload: Form.Reply,
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, FormAlreadySettledError, FormInvalidAnswerError, FormNotFoundError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.reply",
            summary: "Reply to form",
            description: "Submit an answer to a pending form.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.form.cancel", "/api/session/:sessionID/form/:formID", {
        params: { sessionID: Schema.String, formID: Form.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, FormAlreadySettledError, FormNotFoundError],
      })
        .middleware(formLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.form.cancel",
            summary: "Cancel form",
            description: "Cancel a pending form.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.put("session.environment", "/api/session/:sessionID/environment", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ variables: Schema.Record(Schema.String, Schema.String) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.environment",
          summary: "Set session environment",
          description: "Replace the process environment used by local shell commands for this session.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.view", "/api/session/:sessionID/view", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ idle: DateTimeUtcFromMillis }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.view",
          summary: "View session",
          description: "Mark the idle transition observed by the viewer as viewed.",
        }),
      ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session",
        description: "Experimental session routes.",
      }),
    )
