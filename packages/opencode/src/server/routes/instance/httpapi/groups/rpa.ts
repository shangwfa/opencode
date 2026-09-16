import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { ApiNotFoundError, InvalidRequestError } from "../errors"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"

const root = "/rpa"
const JsonMap = Schema.Record(Schema.String, Schema.Unknown)

export const RpaAppInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  status: Schema.String,
  params_schema: Schema.optional(JsonMap),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "RpaApp" })

export const RpaVersionInfo = Schema.Struct({
  id: Schema.String,
  app_id: Schema.String,
  version: Schema.Number,
  status: Schema.String,
  source: Schema.String,
  script: Schema.String,
  exploration: Schema.optional(Schema.String),
  manifest: Schema.optional(JsonMap),
  note: Schema.optional(Schema.String),
  repair_from_version: Schema.optional(Schema.Number),
  validate_run_id: Schema.optional(Schema.String),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "RpaAppVersion" })

export const RpaRunInfo = Schema.Struct({
  id: Schema.String,
  app_id: Schema.String,
  version_id: Schema.String,
  trigger_type: Schema.String,
  status: Schema.String,
  params: Schema.optional(JsonMap),
  result: Schema.optional(JsonMap),
  error: Schema.optional(Schema.String),
  exit_code: Schema.optional(Schema.Number),
  repair_count: Schema.Number,
  repair_tokens: Schema.Number,
  repair_session_id: Schema.optional(Schema.String),
  repaired_version_id: Schema.optional(Schema.String),
  run_session_id: Schema.optional(Schema.String),
  time_started: Schema.optional(Schema.Number),
  time_finished: Schema.optional(Schema.Number),
  time_created: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "RpaRun" })

// exploration 落库为 text；AI 生成的 pending-app.json 里它常是结构化对象，schema 层兼容两种形态
const Exploration = Schema.Union([Schema.String, JsonMap]).annotate({
  description: "Exploration record (markdown or structured JSON) captured during the AI session",
})

const CreatePayload = Schema.Struct({
  name: Schema.String.annotate({ description: "App name" }),
  description: Schema.optional(Schema.String),
  script: Schema.String.annotate({ description: "agent-browser script content (Node.js ESM)" }),
  exploration: Schema.optional(Exploration),
  params_schema: Schema.optional(JsonMap.annotate({ description: "JSON Schema describing run parameters" })),
  manifest: Schema.optional(JsonMap.annotate({ description: "Execution config, e.g. { timeout_seconds: 300 }" })),
  source: Schema.optional(Schema.Literals(["exploration", "manual"])).annotate({ description: "Defaults to manual" }),
})

const UpdatePayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["active", "disabled"])),
})

const AddVersionPayload = Schema.Struct({
  script: Schema.String,
  source: Schema.Literals(["exploration", "repair", "manual"]),
  exploration: Schema.optional(Exploration),
  manifest: Schema.optional(JsonMap),
  note: Schema.optional(Schema.String),
  repair_from_version: Schema.optional(Schema.Number),
  promote: Schema.optional(Schema.Boolean).annotate({
    description: "Promote to active after insert. Defaults to true",
  }),
})

const RunPayload = Schema.Struct({
  params: Schema.optional(JsonMap),
  trigger_type: Schema.optional(Schema.Literals(["api", "cron", "manual", "validate"])).annotate({
    description: "Defaults to api",
  }),
})

const CreateResponse = Schema.Struct({
  app: RpaAppInfo,
  version: RpaVersionInfo,
})
const GetResponse = Schema.Struct({
  app: RpaAppInfo,
  active_version: Schema.optional(RpaVersionInfo),
  versions: Schema.Array(RpaVersionInfo),
})
const AddVersionResponse = Schema.Struct({
  version: RpaVersionInfo,
})
const RunResponse = Schema.Struct({
  run: RpaRunInfo,
})
const RunsResponse = Schema.Struct({
  runs: Schema.Array(RpaRunInfo),
})
const DeleteResponse = Schema.Struct({ ok: Schema.Boolean })

export const RpaApi = HttpApi.make("rpa").add(
  HttpApiGroup.make("rpa")
    .add(
      HttpApiEndpoint.post("create", `${root}/app`, {
        payload: CreatePayload,
        success: described(CreateResponse, "Created app with its first version (active)"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "rpa.create",
          summary: "Create RPA app",
          description:
            "Persist an explored automation as a reusable app. The script becomes version 1 and is active immediately.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("list", `${root}/app`, {
        query: WorkspaceRoutingQuery,
        success: described(Schema.Struct({ apps: Schema.Array(RpaAppInfo) }), "List of RPA apps"),
      }).annotateMerge(OpenApi.annotations({ identifier: "rpa.list", summary: "List RPA apps" })),
    )
    .add(
      HttpApiEndpoint.get("get", `${root}/app/:appID`, {
        params: { appID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(GetResponse, "App detail with versions"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "rpa.get", summary: "Get RPA app detail" })),
    )
    .add(
      HttpApiEndpoint.patch("update", `${root}/app/:appID`, {
        params: { appID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: UpdatePayload,
        success: described(RpaAppInfo, "Updated app"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "rpa.update", summary: "Update RPA app metadata" })),
    )
    .add(
      HttpApiEndpoint.delete("remove", `${root}/app/:appID`, {
        params: { appID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(DeleteResponse, "Deleted"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "rpa.remove", summary: "Delete RPA app" })),
    )
    .add(
      HttpApiEndpoint.post("addVersion", `${root}/app/:appID/version`, {
        params: { appID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: AddVersionPayload,
        success: described(AddVersionResponse, "New version"),
        error: [ApiNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "rpa.addVersion",
          summary: "Add script version",
          description: "Used by manual edits and the AI repair loop.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("run", `${root}/app/:appID/run`, {
        params: { appID: Schema.String },
        query: WorkspaceRoutingQuery,
        payload: RunPayload,
        success: described(RunResponse, "Created run (executes asynchronously)"),
        error: [ApiNotFoundError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "rpa.run",
          summary: "Trigger app run",
          description: "Runs the active script version in the app sandbox. No LLM involved.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("runs", `${root}/app/:appID/runs`, {
        params: { appID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(RunsResponse, "Run history, newest first"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "rpa.runs", summary: "List app runs" })),
    )
    .add(
      HttpApiEndpoint.get("runDetail", `${root}/run/:runID`, {
        params: { runID: Schema.String },
        query: WorkspaceRoutingQuery,
        success: described(RunResponse, "Run detail"),
        error: [ApiNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "rpa.runDetail", summary: "Get run detail" })),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "rpa",
        description: "RPA automation apps: explore with AI once, replay deterministically without tokens.",
      }),
    )
    .middleware(InstanceContextMiddleware)
    .middleware(WorkspaceRoutingMiddleware)
    .middleware(Authorization),
)
