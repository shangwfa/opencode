import { SaasTask } from "@/saas-task"
import { Session } from "@/session/session"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const root = "/saas/task"
const errors = [HttpApiError.BadRequest, HttpApiError.NotFound, HttpApiError.ServiceUnavailable] as const

export const SaasTaskApi = HttpApi.make("saas-task").add(
  HttpApiGroup.make("saasTask")
    .add(
      HttpApiEndpoint.post("create", root, {
        payload: SaasTask.CreateInput,
        success: described(SaasTask.Info, "Created SaaS task"),
        error: errors,
      }),
      HttpApiEndpoint.get("list", root, {
        success: described(Schema.Array(SaasTask.Info), "SaaS tasks"),
        error: errors,
      }),
      HttpApiEndpoint.get("get", `${root}/:taskID`, {
        params: { taskID: SaasTask.ID },
        success: described(SaasTask.Info, "SaaS task"),
        error: errors,
      }),
      HttpApiEndpoint.patch("update", `${root}/:taskID`, {
        params: { taskID: SaasTask.ID },
        payload: SaasTask.UpdateInput,
        success: described(SaasTask.Info, "Updated SaaS task"),
        error: errors,
      }),
      HttpApiEndpoint.delete("remove", `${root}/:taskID`, {
        params: { taskID: SaasTask.ID },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listAgents", `${root}/:taskID/agents`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(SaasTask.AgentInfo), "Task agents"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertAgent", `${root}/:taskID/agents/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        payload: SaasTask.AgentInput,
        success: described(SaasTask.AgentInfo, "Task agent"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeAgent", `${root}/:taskID/agents/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listSkills", `${root}/:taskID/skills`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(SaasTask.SkillInfo), "Task skills"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertSkill", `${root}/:taskID/skills/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        payload: SaasTask.SkillInput,
        success: described(SaasTask.SkillInfo, "Task skill"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeSkill", `${root}/:taskID/skills/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listMcps", `${root}/:taskID/mcps`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(SaasTask.McpInfo), "Task MCP servers"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertMcp", `${root}/:taskID/mcps/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        payload: SaasTask.McpInput,
        success: described(SaasTask.McpInfo, "Task MCP server"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeMcp", `${root}/:taskID/mcps/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("getAgentsMd", `${root}/:taskID/agents-md`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Struct({ content: Schema.String }), "Task AGENTS.md"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertAgentsMd", `${root}/:taskID/agents-md`, {
        params: { taskID: SaasTask.ID },
        payload: Schema.Struct({ content: Schema.String }),
        success: described(Schema.Struct({ content: Schema.String }), "Task AGENTS.md"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeAgentsMd", `${root}/:taskID/agents-md`, {
        params: { taskID: SaasTask.ID },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listCommands", `${root}/:taskID/commands`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(SaasTask.CommandInfo), "Task commands"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertCommand", `${root}/:taskID/commands/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        payload: SaasTask.CommandInput,
        success: described(SaasTask.CommandInfo, "Task command"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeCommand", `${root}/:taskID/commands/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listTools", `${root}/:taskID/tools`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(SaasTask.ToolInfo), "Task tools"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertTool", `${root}/:taskID/tools/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        payload: SaasTask.ToolInput,
        success: described(SaasTask.ToolInfo, "Task tool"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeTool", `${root}/:taskID/tools/:name`, {
        params: { taskID: SaasTask.ID, name: SaasTask.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listSessions", `${root}/:taskID/sessions`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(Session.Info), "Task sessions"),
        error: errors,
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "SaaS Task", description: "SaaS task control plane." })),
)
