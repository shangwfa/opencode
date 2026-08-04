import { Scheduler } from "@/scheduler"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { SchedulerRootApi } from "../api"

function apiError(error: { readonly _tag: string }) {
  if (error._tag === "Scheduler.NotFound") return new HttpApiError.NotFound({})
  if (error._tag === "Scheduler.InvalidCron" || error._tag === "ParseError") return new HttpApiError.BadRequest({})
  return new HttpApiError.ServiceUnavailable({})
}

const transport = <A, E extends { readonly _tag: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(apiError))

export const schedulerHandlers = HttpApiBuilder.group(SchedulerRootApi, "scheduler", (handlers) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Service

    return handlers
      .handle("create", (ctx) => transport(scheduler.create(ctx.payload)))
      .handle("list", (ctx) => transport(scheduler.list(ctx.query.ownerType, ctx.query.ownerId)))
      .handle("get", (ctx) => transport(scheduler.get(ctx.params.scheduleID)))
      .handle("update", (ctx) => transport(scheduler.update(ctx.params.scheduleID, ctx.payload)))
      .handle("remove", (ctx) => transport(scheduler.remove(ctx.params.scheduleID)))
      .handle("createTaskSchedule", (ctx) =>
        transport(
          scheduler.create({
            ownerType: "task",
            ownerId: ctx.params.taskID,
            cron: ctx.payload.cron,
            payload: ctx.payload.payload,
          }),
        ),
      )
      .handle("listTaskSchedules", (ctx) => transport(scheduler.list("task", ctx.params.taskID)))
      .handle("removeTaskSchedule", (ctx) => transport(scheduler.remove(ctx.params.scheduleID)))
  }),
)
