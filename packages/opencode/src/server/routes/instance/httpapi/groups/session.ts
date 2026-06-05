import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
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

const root = "/session"
export const ListQuery = Schema.Struct({
  ...WorkspaceRoutingQueryFields,
  scope: Schema.optional(Schema.Literals(["project"])),
  path: Schema.optional(Schema.String),
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
  permission: Schema.optional(Permission.Ruleset),
  time: Schema.optional(
    Schema.Struct({
      archived: Schema.optional(Session.ArchivedTimestamp),
    }),
  ),
})
export const ForkPayload = Schema.Struct(Struct.omit(Session.ForkInput.fields, ["sessionID"]))
export const InitPayload = Schema.Struct({
  modelID: ModelID,
  providerID: ProviderID,
  messageID: MessageID,
})
export const SummarizePayload = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
  auto: Schema.optional(Schema.Boolean),
})
export const PromptPayload = Schema.Struct(Struct.omit(SessionPrompt.PromptInput.fields, ["sessionID"]))
export const CommandPayload = Schema.Struct(Struct.omit(SessionPrompt.CommandInput.fields, ["sessionID"]))
export const ShellPayload = Schema.Struct(Struct.omit(SessionPrompt.ShellInput.fields, ["sessionID"]))
export const RevertPayload = Schema.Struct(Struct.omit(SessionRevert.RevertInput.fields, ["sessionID"]))
export const PermissionResponsePayload = Schema.Struct({
  response: Permission.Reply,
})
export const SkillCreatePayload = Skill.CreateInput
export const SkillLoadPayload = Schema.Struct({
  path: Schema.String,
})
export const AgentCreatePayload = Agent.CreateInput

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
  create: root,
  remove: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  fork: `${root}/:sessionID/fork`,
  abort: `${root}/:sessionID/abort`,
  share: `${root}/:sessionID/share`,
  init: `${root}/:sessionID/init`,
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
  mcps: `${root}/:sessionID/mcps`,
  mcpsCreate: `${root}/:sessionID/mcps/create`,
  mcpsDelete: `${root}/:sessionID/mcps/:name`,
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
          success: described(Schema.Array(MessageV2.WithParts), "List of messages"),
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
          success: described(MessageV2.WithParts, "Message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.message",
            summary: "Get message",
            description: "Retrieve a specific message from a session by its message ID.",
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
          payload: Schema.optional(ForkPayload),
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
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
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
          error: [HttpApiError.BadRequest, ApiNotFoundError],
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
          success: described(MessageV2.WithParts, "Created message"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
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
          success: described(MessageV2.WithParts, "Created message"),
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
          params: { sessionID: SessionID, permissionID: PermissionID },
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
          payload: MessageV2.Part,
          success: described(MessageV2.Part, "Successfully updated part"),
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
          success: described(Schema.Array(Skill.Info), "Session skills"),
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
          success: described(Skill.Info, "Created session skill"),
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
          success: described(Schema.Array(Skill.Info), "Loaded session skills"),
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
          success: described(Schema.Void, "Session skill unloaded"),
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
          success: described(Schema.Void, "Session skills cleared"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.skills.clear",
            summary: "Clear session skills",
            description: "Remove all skills attached to a specific OpenCode session.",
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
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.agents.create",
            summary: "Create session agent",
            description: "Create or update an inline agent attached to a specific OpenCode session. Only available in SaaS mode.",
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
