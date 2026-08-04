import { Scheduler } from "@/scheduler"
import { SaasTask } from "@/saas-task"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"

const root = "/saas/schedule"
const taskRoot = "/saas/task"
const errors = [HttpApiError.BadRequest, HttpApiError.NotFound, HttpApiError.ServiceUnavailable] as const

export const SchedulerApi = HttpApi.make("saas-scheduler").add(
  HttpApiGroup.make("scheduler")
    .add(
      HttpApiEndpoint.post("create", root, {
        payload: Scheduler.CreateInput,
        success: described(Scheduler.Info, "Created schedule"),
        error: errors,
      }),
      HttpApiEndpoint.get("list", root, {
        query: Schema.Struct({
          ownerType: Schema.String,
          ownerId: Schema.String,
        }),
        success: described(Schema.Array(Scheduler.Info), "Schedules"),
        error: errors,
      }),
      HttpApiEndpoint.get("get", `${root}/:scheduleID`, {
        params: { scheduleID: Scheduler.ID },
        success: described(Scheduler.Info, "Schedule"),
        error: errors,
      }),
      HttpApiEndpoint.patch("update", `${root}/:scheduleID`, {
        params: { scheduleID: Scheduler.ID },
        payload: Scheduler.UpdateInput,
        success: described(Scheduler.Info, "Updated schedule"),
        error: errors,
      }),
      HttpApiEndpoint.delete("remove", `${root}/:scheduleID`, {
        params: { scheduleID: Scheduler.ID },
        success: Schema.Void,
        error: errors,
      }),
      HttpApiEndpoint.post("createTaskSchedule", `${taskRoot}/:taskID/schedule`, {
        params: { taskID: SaasTask.ID },
        payload: Schema.Struct({
          cron: Schema.String,
          payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
        }),
        success: described(Scheduler.Info, "Task schedule"),
        error: errors,
      }),
      HttpApiEndpoint.get("listTaskSchedules", `${taskRoot}/:taskID/schedule`, {
        params: { taskID: SaasTask.ID },
        success: described(Schema.Array(Scheduler.Info), "Task schedules"),
        error: errors,
      }),
      HttpApiEndpoint.delete("removeTaskSchedule", `${taskRoot}/:taskID/schedule/:scheduleID`, {
        params: { taskID: SaasTask.ID, scheduleID: Scheduler.ID },
        success: Schema.Void,
        error: errors,
      }),
    )
    .annotateMerge(OpenApi.annotations({ title: "SaaS Scheduler", description: "SaaS schedule control plane." })),
)
