import { SaasTask } from "@/saas-task"
import { Session } from "@/session/session"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { SaasTaskRootApi } from "../api"

function apiError(error: { readonly _tag: string }) {
  if (error._tag === "SaasTask.NotFound") return new HttpApiError.NotFound({})
  if (error._tag === "ParseError") return new HttpApiError.BadRequest({})
  return new HttpApiError.ServiceUnavailable({})
}

const transport = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(apiError))

export const saasTaskHandlers = HttpApiBuilder.group(SaasTaskRootApi, "saasTask", (handlers) =>
  Effect.gen(function* () {
    const task = yield* SaasTask.Service
    const session = yield* Session.Service

    return handlers
      .handle("create", (ctx) => transport(task.create(ctx.payload)))
      .handle("list", () => transport(task.list()))
      .handle("get", (ctx) => transport(task.get(ctx.params.taskID)))
      .handle("update", (ctx) => transport(task.update(ctx.params.taskID, ctx.payload)))
      .handle("remove", (ctx) => transport(task.remove(ctx.params.taskID)))
      .handle("listAgents", (ctx) => transport(task.listAgents(ctx.params.taskID)))
      .handle("upsertAgent", (ctx) => transport(task.upsertAgent(ctx.params.taskID, ctx.params.name, ctx.payload)))
      .handle("removeAgent", (ctx) => transport(task.removeAgent(ctx.params.taskID, ctx.params.name)))
      .handle("listSkills", (ctx) => transport(task.listSkills(ctx.params.taskID)))
      .handle("upsertSkill", (ctx) => transport(task.upsertSkill(ctx.params.taskID, ctx.params.name, ctx.payload)))
      .handle("removeSkill", (ctx) => transport(task.removeSkill(ctx.params.taskID, ctx.params.name)))
      .handle("listMcps", (ctx) => transport(task.listMcps(ctx.params.taskID)))
      .handle("upsertMcp", (ctx) => transport(task.upsertMcp(ctx.params.taskID, ctx.params.name, ctx.payload)))
      .handle("removeMcp", (ctx) => transport(task.removeMcp(ctx.params.taskID, ctx.params.name)))
      .handle("getAgentsMd", (ctx) =>
        transport(task.getAgentsMd(ctx.params.taskID)).pipe(Effect.map((v) => v ?? { content: "" })),
      )
      .handle("upsertAgentsMd", (ctx) => transport(task.upsertAgentsMd(ctx.params.taskID, ctx.payload.content)))
      .handle("removeAgentsMd", (ctx) => transport(task.removeAgentsMd(ctx.params.taskID)))
      .handle("listCommands", (ctx) => transport(task.listCommands(ctx.params.taskID)))
      .handle("upsertCommand", (ctx) => transport(task.upsertCommand(ctx.params.taskID, ctx.params.name, ctx.payload)))
      .handle("removeCommand", (ctx) => transport(task.removeCommand(ctx.params.taskID, ctx.params.name)))
      .handle("listTools", (ctx) => transport(task.listTools(ctx.params.taskID)))
      .handle("upsertTool", (ctx) => transport(task.upsertTool(ctx.params.taskID, ctx.params.name, ctx.payload)))
      .handle("removeTool", (ctx) => transport(task.removeTool(ctx.params.taskID, ctx.params.name)))
      .handle("listSessions", (ctx) => transport(session.listByTaskId(ctx.params.taskID)))
  }),
)
