import { SaasProject } from "@/saas-project"
import { Session } from "@/session/session"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const root = "/saas/project"
const errors = [
  HttpApiError.BadRequest,
  HttpApiError.NotFound,
  HttpApiError.Conflict,
  HttpApiError.ServiceUnavailable,
] as const

export const SaasProjectApi = HttpApi.make("saas-project").add(
  HttpApiGroup.make("saasProject")
    .add(
      HttpApiEndpoint.post("create", root, {
        payload: SaasProject.CreateInput,
        success: described(SaasProject.Info, "Created SaaS project"),
        error: errors,
      }),
      HttpApiEndpoint.get("list", root, {
        success: described(Schema.Array(SaasProject.Info), "SaaS projects"),
        error: errors,
      }),
      HttpApiEndpoint.get("get", `${root}/:projectID`, {
        params: { projectID: SaasProject.ID },
        success: described(SaasProject.Info, "SaaS project"),
        error: errors,
      }),
      HttpApiEndpoint.patch("update", `${root}/:projectID`, {
        params: { projectID: SaasProject.ID },
        payload: SaasProject.UpdateInput,
        success: described(SaasProject.Info, "Updated SaaS project"),
        error: errors,
      }),
      HttpApiEndpoint.delete("archive", `${root}/:projectID`, {
        params: { projectID: SaasProject.ID },
        success: described(SaasProject.Info, "Archived SaaS project"),
        error: errors,
      }),
      HttpApiEndpoint.post("verifyRepository", `${root}/:projectID/repository/verify`, {
        params: { projectID: SaasProject.ID },
        success: described(SaasProject.Info, "Verified SaaS project repository"),
        error: errors,
      }),
      HttpApiEndpoint.put("updateRepository", `${root}/:projectID/repository`, {
        params: { projectID: SaasProject.ID },
        payload: SaasProject.RepositoryInput,
        success: described(SaasProject.Info, "Updated SaaS project repository"),
        error: errors,
      }),
      HttpApiEndpoint.get("listAgents", `${root}/:projectID/agents`, {
        params: { projectID: SaasProject.ID },
        success: described(Schema.Array(SaasProject.AgentInfo), "Project agents"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertAgent", `${root}/:projectID/agents/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        payload: SaasProject.AgentInput,
        success: described(SaasProject.AgentInfo, "Project agent"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeAgent", `${root}/:projectID/agents/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listSkills", `${root}/:projectID/skills`, {
        params: { projectID: SaasProject.ID },
        success: described(Schema.Array(SaasProject.SkillInfo), "Project skills"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertSkill", `${root}/:projectID/skills/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        payload: SaasProject.SkillInput,
        success: described(SaasProject.SkillInfo, "Project skill"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeSkill", `${root}/:projectID/skills/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listMcps", `${root}/:projectID/mcps`, {
        params: { projectID: SaasProject.ID },
        success: described(Schema.Array(SaasProject.McpInfo), "Project MCP servers"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertMcp", `${root}/:projectID/mcps/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        payload: SaasProject.McpInput,
        success: described(SaasProject.McpInfo, "Project MCP server"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeMcp", `${root}/:projectID/mcps/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("getAgentsMd", `${root}/:projectID/agents-md`, {
        params: { projectID: SaasProject.ID },
        success: described(Schema.Struct({ content: Schema.String }), "Project AGENTS.md"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertAgentsMd", `${root}/:projectID/agents-md`, {
        params: { projectID: SaasProject.ID },
        payload: Schema.Struct({ content: Schema.String }),
        success: described(Schema.Struct({ content: Schema.String }), "Project AGENTS.md"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeAgentsMd", `${root}/:projectID/agents-md`, {
        params: { projectID: SaasProject.ID },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listCommands", `${root}/:projectID/commands`, {
        params: { projectID: SaasProject.ID },
        success: described(Schema.Array(SaasProject.CommandInfo), "Project commands"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertCommand", `${root}/:projectID/commands/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        payload: SaasProject.CommandInput,
        success: described(SaasProject.CommandInfo, "Project command"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeCommand", `${root}/:projectID/commands/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listTools", `${root}/:projectID/tools`, {
        params: { projectID: SaasProject.ID },
        success: described(Schema.Array(SaasProject.ToolInfo), "Project tools"),
        error: errors,
      }),
      HttpApiEndpoint.put("upsertTool", `${root}/:projectID/tools/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        payload: SaasProject.ToolInput,
        success: described(SaasProject.ToolInfo, "Project tool"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeTool", `${root}/:projectID/tools/:name`, {
        params: { projectID: SaasProject.ID, name: SaasProject.ResourceName },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.get("listSessions", `${root}/:projectID/sessions`, {
        params: { projectID: SaasProject.ID },
        success: described(Schema.Array(Session.Info), "Project sessions"),
        error: errors,
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "SaaS Project", description: "SaaS project control plane." })),
)
