import { SaasProject } from "@/saas-project"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { SaasProjectRootApi } from "../api"

function apiError(error: { readonly _tag: string }) {
  if (error._tag === "SaasProject.NotFound" || error._tag === "SaasProject.ResourceNotFound") {
    return new HttpApiError.NotFound({})
  }
  if (error._tag === "SaasProject.Archived") return new HttpApiError.Conflict({})
  if (
    error._tag === "SaasProject.InvalidRemote" ||
    error._tag === "SaasProject.RepositoryVerification" ||
    error._tag === "ParseError"
  ) {
    return new HttpApiError.BadRequest({})
  }
  return new HttpApiError.ServiceUnavailable({})
}

const transport = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(apiError))

export const saasProjectHandlers = HttpApiBuilder.group(SaasProjectRootApi, "saasProject", (handlers) =>
  Effect.gen(function* () {
    const project = yield* SaasProject.Service
    const session = yield* Session.Service

    return handlers
      .handle("create", (ctx) => transport(project.create(ctx.payload)))
      .handle("list", () => transport(project.list()))
      .handle("get", (ctx) => transport(project.get(ctx.params.projectID)))
      .handle("update", (ctx) => transport(project.update(ctx.params.projectID, ctx.payload)))
      .handle("archive", (ctx) => transport(project.archive(ctx.params.projectID)))
      .handle("verifyRepository", (ctx) => transport(project.verifyRepository(ctx.params.projectID)))
      .handle("updateRepository", (ctx) => transport(project.updateRepository(ctx.params.projectID, ctx.payload)))
      .handle("listAgents", (ctx) => transport(project.listAgents(ctx.params.projectID)))
      .handle("upsertAgent", (ctx) =>
        transport(project.upsertAgent(ctx.params.projectID, ctx.params.name, ctx.payload)),
      )
      .handle("removeAgent", (ctx) => transport(project.removeAgent(ctx.params.projectID, ctx.params.name)))
      .handle("listSkills", (ctx) => transport(project.listSkills(ctx.params.projectID)))
      .handle("upsertSkill", (ctx) =>
        transport(project.upsertSkill(ctx.params.projectID, ctx.params.name, ctx.payload)),
      )
      .handle("removeSkill", (ctx) => transport(project.removeSkill(ctx.params.projectID, ctx.params.name)))
      .handle("listMcps", (ctx) => transport(project.listMcps(ctx.params.projectID)))
      .handle("upsertMcp", (ctx) => transport(project.upsertMcp(ctx.params.projectID, ctx.params.name, ctx.payload)))
      .handle("removeMcp", (ctx) => transport(project.removeMcp(ctx.params.projectID, ctx.params.name)))
      .handle("getAgentsMd", (ctx) =>
        transport(project.getAgentsMd(ctx.params.projectID)).pipe(Effect.map((v) => v ?? { content: "" })),
      )
      .handle("upsertAgentsMd", (ctx) => transport(project.upsertAgentsMd(ctx.params.projectID, ctx.payload.content)))
      .handle("removeAgentsMd", (ctx) => transport(project.removeAgentsMd(ctx.params.projectID)))
      .handle("listCommands", (ctx) => transport(project.listCommands(ctx.params.projectID)))
      .handle("upsertCommand", (ctx) =>
        transport(project.upsertCommand(ctx.params.projectID, ctx.params.name, ctx.payload)),
      )
      .handle("removeCommand", (ctx) => transport(project.removeCommand(ctx.params.projectID, ctx.params.name)))
      .handle("listTools", (ctx) => transport(project.listTools(ctx.params.projectID)))
      .handle("upsertTool", (ctx) => transport(project.upsertTool(ctx.params.projectID, ctx.params.name, ctx.payload)))
      .handle("removeTool", (ctx) => transport(project.removeTool(ctx.params.projectID, ctx.params.name)))
      .handle("listSessions", (ctx) => transport(session.listByProjectId(ctx.params.projectID)))
  }),
)
