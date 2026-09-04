import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"

import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { SessionMcp } from "@/mcp/session-mcp"
import { SessionLoadDotOpencode } from "@/config/session-load-dot-opencode"
import { Schema, Struct } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
  WorkspaceRoutingQueryFields,
} from "../middleware/workspace-routing"
import { ApiNotFoundError, PermissionNotFoundError, SessionBusyError } from "../errors"
import { described } from "./metadata"
import { QueryBoolean } from "./query"
import { ProviderV2 } from "@opencode-ai/core/provider"

export class SkillCreateError extends Schema.ErrorClass<SkillCreateError>("SkillCreateError")(
  {
    name: Schema.Literal("SkillCreateError"),
    data: Schema.Struct({ message: Schema.String }),
  },
  { httpApiStatus: 400 },
) {}
import { ModelV2 } from "@opencode-ai/core/model"
import { ToolAttachment } from "@/tool/attachment"

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
  appId: Schema.optional(Schema.String),
  roots: Schema.optional(QueryBoolean),
  start: Schema.optional(Schema.NumberFromString),
  search: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.NumberFromString),
})
export const DiffQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  ...Struct.omit(SessionSummary.DiffInput.fields, ["sessionID"]),
})
export const MessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  limit: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  before: Schema.optional(Schema.String),
})
export const StatusMap = Schema.Record(Schema.String, SessionStatus.Info)
export const UpdatePayload = Schema.Struct({
  title: Schema.optional(Schema.String),
  directory: Schema.optional(Schema.String),
  metadata: Schema.optional(Session.Metadata),
  permission: Schema.optional(PermissionV1.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Session.ArchivedTimestamp),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const InitPayload = Schema.Struct({
  modelID: ModelV2.ID,
  providerID: ProviderV2.ID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: PermissionV1.Reply,
})
export const SkillCreatePayload = Skill.CreateInput
export const SkillLoadPayload = Schema.Struct({
  path: Schema.String,
})
export const AgentCreatePayload = Agent.CreateInput
export const AgentsMdCreatePayload = Schema.Struct({
  content: Schema.String,
})
export const SessionLoadDotOpencodeResult = Schema.Struct({
  loaded: Schema.Array(Schema.String),
  skipped: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      reason: Schema.String,
    }),
  ),
})

export const ToolCreatePayload = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  code: Schema.String,
})

export const PluginCreatePayload = Schema.Union([
  Schema.Struct({
    name: Schema.NonEmptyString,
    source: Schema.optional(Schema.Literal("code")),
    description: Schema.optional(Schema.String),
    code: Schema.NonEmptyString,
    enabled: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    name: Schema.NonEmptyString,
    source: Schema.Literal("npm"),
    spec: Schema.NonEmptyString,
    description: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
  }),
])

export const CommandCreatePayload = Schema.Struct({
  name: Schema.String,
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.optional(Schema.Array(Schema.String)),
})

export const McpCreatePayload = Schema.Union([
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("local"),
    command: Schema.NonEmptyArray(Schema.String),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    enabled: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("remote"),
    url: Schema.String,
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    enabled: Schema.optional(Schema.Boolean),
  }),
]).annotate({ discriminator: "type" })

export const SessionPaths = {
  list: root,
  status: `${root}/status`,
  get: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  todo: `${root}/:sessionID/todo`,
  diff: `${root}/:sessionID/diff`,
  messages: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  attachment: `${root}/:sessionID/attachment/:attachmentID`,
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
  loadDotOpencode: `${root}/:sessionID/dot-opencode/load`,
  snapshot: `${root}/:sessionID/snapshot`,
  summarize: `${root}/:sessionID/summarize`,
  prompt: `${root}/:sessionID/message`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  command: `${root}/:sessionID/command`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permissions: `${root}/:sessionID/permissions/:permissionID`,
  deleteMessage: `${root}/:sessionID/message/:messageID`,
  deletePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  updatePart: `${root}/:sessionID/message/:messageID/part/:partID`,
  skills: `${root}/:sessionID/skills`,
  skillsCreate: `${root}/:sessionID/skills/create`,
  skillsLoad: `${root}/:sessionID/skills/load`,
  skillsDelete: `${root}/:sessionID/skills/:name`,
  agents: `${root}/:sessionID/agents`,
  agentsCreate: `${root}/:sessionID/agents/create`,
  agentsDelete: `${root}/:sessionID/agents/:name`,
  agentsMd: `${root}/:sessionID/agents-md`,
  agentsMdCreate: `${root}/:sessionID/agents-md/create`,
  mcps: `${root}/:sessionID/mcps`,
  mcpsCreate: `${root}/:sessionID/mcps/create`,
  mcpsDelete: `${root}/:sessionID/mcps/:name`,
  tools: `${root}/:sessionID/tools`,
  toolsCreate: `${root}/:sessionID/tools/create`,
  toolsDelete: `${root}/:sessionID/tools/:name`,
  commands: `${root}/:sessionID/commands`,
  commandsCreate: `${root}/:sessionID/commands/create`,
  commandsDelete: `${root}/:sessionID/commands/:name`,
  plugins: `${root}/:sessionID/plugins`,
  pluginsCreate: `${root}/:sessionID/plugins/create`,
  pluginsDelete: `${root}/:sessionID/plugins/:name`,
} as const

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: ListQuery,
          success: described(Schema.Array(Session.Info), "List of sessions"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.list",
            summary: "List sessions",
            description: "Get a list of all OpenCode sessions, sorted by most recently updated.",
          }),
        ),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: described(StatusMap, "Get session status"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.status",
            summary: "Get session status",
            description: "Retrieve the current status of all sessions, including active, idle, and completed states.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Get session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get",
            summary: "Get session",
            description: "Retrieve detailed information about a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Session.Info), "List of children"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.children",
            summary: "Get session children",
            description: "Retrieve all child sessions that were forked from the specified parent session.",
          }),
        ),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Todo.Info), "Todo list"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.todo",
            summary: "Get session todos",
            description: "Retrieve the todo list associated with a specific session, showing tasks and action items.",
          }),
        ),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: { sessionID: SessionID },
          query: DiffQuery,
          success: described(Schema.Array(Snapshot.FileDiff), "Successfully retrieved diff"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.diff",
            summary: "Get message diff",
            description: "Get the file changes (diff) that resulted from a specific user message in the session.",
          }),
        ),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: { sessionID: SessionID },
          query: MessagesQuery,
          success: described(Schema.Array(SessionV1.WithParts), "List of messages"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.messages",
            summary: "Get session messages",
            description: "Retrieve all messages in a session, including user prompts and AI responses.",
          }),
        ),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(SessionV1.WithParts, "Message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
          }),
        ),
        HttpApiEndpoint.get("attachment", SessionPaths.attachment, {
          params: { sessionID: SessionID, attachmentID: ToolAttachment.ID },
          query: WorkspaceRoutingQuery,
          success: Schema.String.pipe(HttpApiSchema.asText({ contentType: "application/octet-stream" })),
          error: [ApiNotFoundError, HttpApiError.InternalServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.attachment",
            summary: "Download session attachment",
            description: "Stream a managed tool attachment associated with a session.",
          }),
        ),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, Session.CreateInput],
          success: described(Session.Info, "Successfully created session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.create",
            summary: "Create session",
            description: "Create a new OpenCode session for interacting with AI assistants and managing conversations.",
          }),
        ),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.delete",
            summary: "Delete session",
            description: "Delete a session and permanently remove all associated data, including messages and history.",
          }),
        ),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: UpdatePayload,
          success: described(Session.Info, "Successfully updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.update",
            summary: "Update session",
            description: "Update properties of an existing session, such as title or other metadata.",
          }),
        ),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: [HttpApiSchema.NoContent, ForkPayload],
          success: described(Session.Info, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.fork",
            summary: "Fork session",
            description: "Create a new session by forking an existing session at a specific message point.",
          }),
        ),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Aborted session"),
          error: HttpApiError.BadRequest,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.abort",
            summary: "Abort session",
            description: "Abort an active session and stop any ongoing AI processing or command execution.",
          }),
        ),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: InitPayload,
          success: described(Schema.Boolean, "200"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.init",
            summary: "Initialize session",
            description:
              "Analyze the current application and create an AGENTS.md file with project-specific agent configurations.",
          }),
        ),
        HttpApiEndpoint.post("loadDotOpencode", SessionPaths.loadDotOpencode, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(SessionLoadDotOpencodeResult, "Loaded project .opencode configuration"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.load_dot_opencode",
            summary: "Load project .opencode configuration",
            description: "Load the current project's .opencode configuration into the session.",
          }),
        ),
        HttpApiEndpoint.post("snapshot", SessionPaths.snapshot, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Struct({
              snapshotId: Schema.optional(Schema.String),
              state: Schema.String,
              reason: Schema.optional(Schema.NullOr(Schema.String)),
            }),
            "Snapshot creation accepted (async) or latest snapshot state",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.snapshot",
            summary: "Create sandbox snapshot for session",
            description:
              "Create a snapshot of the session sandbox filesystem (async; poll state via GET). Snapshot id can be used as sandbox.snapshotId to derive new sessions.",
          }),
        ),
        HttpApiEndpoint.get("getSnapshot", SessionPaths.snapshot, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(
            Schema.Struct({
              snapshotId: Schema.optional(Schema.String),
              state: Schema.String,
              reason: Schema.optional(Schema.NullOr(Schema.String)),
            }),
            "Latest snapshot state for the session",
          ),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.get_snapshot",
            summary: "Get latest sandbox snapshot state",
          }),
        ),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully shared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.share",
            summary: "Share session",
            description: "Create a shareable link for a session, allowing others to view the conversation.",
          }),
        ),
        HttpApiEndpoint.delete("unshare", SessionPaths.share, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Successfully unshared session"),
          error: [HttpApiError.InternalServerError, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unshare",
            summary: "Unshare session",
            description: "Remove the shareable link for a session, making it private again.",
          }),
        ),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SummarizePayload,
          success: described(Schema.Boolean, "Summarized session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.summarize",
            summary: "Summarize session",
            description: "Generate a concise summary of the session using AI compaction to preserve key information.",
          }),
        ),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, HttpApiError.ServiceUnavailable, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt",
            summary: "Send message",
            description: "Create and send a new message to a session, streaming the AI response.",
          }),
        ),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PromptPayload,
          success: described(HttpApiSchema.NoContent, "Prompt accepted"),
          error: [HttpApiError.BadRequest, HttpApiError.ServiceUnavailable, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.prompt_async",
            summary: "Send async message",
            description:
              "Create and send a new message to a session asynchronously, starting the session if needed and returning immediately.",
          }),
        ),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, HttpApiError.ServiceUnavailable, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.command",
            summary: "Send command",
            description: "Send a new command to a session for execution by the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ShellPayload,
          success: described(SessionV1.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shell",
            summary: "Run shell command",
            description: "Execute a shell command within the session context and return the AI's response.",
          }),
        ),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: RevertPayload,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.revert",
            summary: "Revert message",
            description:
              "Revert a specific message in a session, undoing its effects and restoring the previous state.",
          }),
        ),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Session.Info, "Updated session"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.unrevert",
            summary: "Restore reverted messages",
            description: "Restore all previously reverted messages in a session.",
          }),
        ),
        HttpApiEndpoint.post("permissionRespond", SessionPaths.permissions, {
          params: { sessionID: SessionID, permissionID: PermissionV1.ID },
          query: WorkspaceRoutingQuery,
          payload: PermissionResponsePayload,
          success: described(Schema.Boolean, "Permission processed successfully"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.respond",
            summary: "Respond to permission",
            description: "Approve or deny a permission request from the AI assistant.",
            deprecated: true,
          }),
        ),
        HttpApiEndpoint.delete("deleteMessage", SessionPaths.deleteMessage, {
          params: { sessionID: SessionID, messageID: MessageID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.deleteMessage",
            summary: "Delete message",
            description:
              "Permanently delete a specific message and all of its parts from a session without reverting file changes.",
          }),
        ),
        HttpApiEndpoint.delete("deletePart", SessionPaths.deletePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "Successfully deleted part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.delete",
            description: "Delete a part from a message.",
          }),
        ),
        HttpApiEndpoint.patch("updatePart", SessionPaths.updatePart, {
          params: { sessionID: SessionID, messageID: MessageID, partID: PartID },
          query: WorkspaceRoutingQuery,
          payload: SessionV1.Part,
          success: described(SessionV1.Part, "Successfully updated part"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "part.update",
            description: "Update a part in a message.",
          }),
        ),
        HttpApiEndpoint.get("skills", SessionPaths.skills, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Skill.PublicInfo), "Session skills"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.skills",
            summary: "List session skills",
            description: "Get skills attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.post("skillsCreate", SessionPaths.skillsCreate, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SkillCreatePayload,
          success: described(Skill.PublicInfo, "Created session skill"),
          error: [SkillCreateError, HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.skills.create",
            summary: "Create session skill",
            description: "Create or update an inline skill attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.post("skillsLoad", SessionPaths.skillsLoad, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: SkillLoadPayload,
          success: described(Schema.Array(Skill.PublicInfo), "Loaded session skills"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.skills.load",
            summary: "Load session skills",
            description: "Import skills from a local directory as snapshots attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.delete("skillsDelete", SessionPaths.skillsDelete, {
          params: { sessionID: SessionID, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(HttpApiSchema.NoContent, "Session skill unloaded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.skills.unload",
            summary: "Unload session skill",
            description: "Remove a skill from a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.delete("skillsClear", SessionPaths.skills, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(HttpApiSchema.NoContent, "Session skills cleared"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.skills.clear",
            summary: "Clear session skills",
            description: "Remove all skills attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("agentsMd", SessionPaths.agentsMd, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.NullOr(Schema.Unknown), "Session AGENTS.md"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents-md",
            summary: "Get session AGENTS.md",
            description: "Get the AGENTS.md instructions attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.post("agentsMdCreate", SessionPaths.agentsMdCreate, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AgentsMdCreatePayload,
          success: described(Schema.Unknown, "Created session AGENTS.md"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents-md.create",
            summary: "Create session AGENTS.md",
            description: "Create or replace the AGENTS.md instructions attached to a specific session.",
          }),
        ),
        HttpApiEndpoint.delete("agentsMdDelete", SessionPaths.agentsMd, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session AGENTS.md cleared"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents-md.clear",
            summary: "Clear session AGENTS.md",
            description: "Remove the AGENTS.md instructions attached to a specific session.",
          }),
        ),
        HttpApiEndpoint.get("agents", SessionPaths.agents, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Agent.Info), "Session agents"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents",
            summary: "List session agents",
            description: "Get agents attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.post("agentsCreate", SessionPaths.agentsCreate, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: AgentCreatePayload,
          success: described(Agent.Info, "Created session agent"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents.create",
            summary: "Create session agent",
            description:
              "Create or update an inline agent attached to a specific OpenCode session. Only available in SaaS mode.",
          }),
        ),
        HttpApiEndpoint.delete("agentsDelete", SessionPaths.agentsDelete, {
          params: { sessionID: SessionID, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session agent unloaded"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents.unload",
            summary: "Unload session agent",
            description: "Remove an agent from a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.delete("agentsClear", SessionPaths.agents, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session agents cleared"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents.clear",
            summary: "Clear session agents",
            description: "Remove all agents attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("mcps", SessionPaths.mcps, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Schema.Unknown), "Session MCPs"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mcps",
            summary: "List session MCPs",
            description: "Get MCP servers attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.post("mcpsCreate", SessionPaths.mcpsCreate, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: McpCreatePayload,
          success: described(Schema.Unknown, "Created session MCP"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mcps.create",
            summary: "Create session MCP",
            description: "Create or update a session-level MCP server. Only available in SaaS mode.",
          }),
        ),
        HttpApiEndpoint.delete("mcpsDelete", SessionPaths.mcpsDelete, {
          params: { sessionID: SessionID, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session MCP removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mcps.delete",
            summary: "Delete session MCP",
            description: "Remove a session-level MCP server.",
          }),
        ),
        HttpApiEndpoint.delete("mcpsClear", SessionPaths.mcps, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session MCPs cleared"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.mcps.clear",
            summary: "Clear session MCPs",
            description: "Remove all MCP servers attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("tools", SessionPaths.tools, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Schema.Unknown), "Session tools"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.tools",
            summary: "List session tools",
            description: "Get custom tools attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.post("toolsCreate", SessionPaths.toolsCreate, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ToolCreatePayload,
          success: described(Schema.Unknown, "Created session tool"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.tools.create",
            summary: "Create session tool",
            description:
              "Create or update a custom tool attached to a specific OpenCode session. Only available in SaaS mode.",
          }),
        ),
        HttpApiEndpoint.delete("toolsDelete", SessionPaths.toolsDelete, {
          params: { sessionID: SessionID, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session tool removed"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.tools.delete",
            summary: "Delete session tool",
            description: "Remove a custom tool from a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.delete("toolsClear", SessionPaths.tools, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session tools cleared"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.tools.clear",
            summary: "Clear session tools",
            description: "Remove all custom tools attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("commands", SessionPaths.commands, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Schema.Unknown), "Session commands"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.commands",
            summary: "List session commands",
            description:
              "Get custom commands attached to a specific OpenCode session, merged with instance-level commands.",
          }),
        ),
        HttpApiEndpoint.post("commandsCreate", SessionPaths.commandsCreate, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: CommandCreatePayload,
          success: described(Schema.Unknown, "Created session command"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.commands.create",
            summary: "Create session command",
            description:
              "Create or update a custom command attached to a specific OpenCode session. Only available in SaaS mode.",
          }),
        ),
        HttpApiEndpoint.delete("commandsDelete", SessionPaths.commandsDelete, {
          params: { sessionID: SessionID, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session command removed"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.commands.delete",
            summary: "Delete session command",
            description: "Remove a custom command from a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.delete("commandsClear", SessionPaths.commands, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session commands cleared"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.commands.clear",
            summary: "Clear session commands",
            description: "Remove all custom commands attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.get("plugins", SessionPaths.plugins, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Array(Schema.Unknown), "Session plugins"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.plugins",
            summary: "List session plugins",
            description: "List custom plugins attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.post("pluginsCreate", SessionPaths.pluginsCreate, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: PluginCreatePayload,
          success: described(Schema.Unknown, "Created session plugin"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.plugins.create",
            summary: "Create session plugin",
            description: "Create or update a plugin attached to a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.delete("pluginsDelete", SessionPaths.pluginsDelete, {
          params: { sessionID: SessionID, name: Schema.String },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session plugin removed"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.plugins.delete",
            summary: "Delete session plugin",
            description: "Remove a plugin from a specific OpenCode session.",
          }),
        ),
        HttpApiEndpoint.delete("pluginsClear", SessionPaths.plugins, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(Schema.Void, "Session plugins cleared"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.plugins.clear",
            summary: "Clear session plugins",
            description: "Remove all plugins from a specific OpenCode session.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session",
          description: "Experimental HttpApi session routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
