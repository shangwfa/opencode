export * as AutomationApp from "./automation-app.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { Model } from "./model.js"

export interface Parameter extends Schema.Schema.Type<typeof Parameter> {}
export const Parameter = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  required: Schema.Boolean,
  defaultValue: Schema.String,
}).annotate({ identifier: "AutomationApp.Parameter" })

export interface BrowserOperation extends Schema.Schema.Type<typeof BrowserOperation> {}
export const BrowserOperation = Schema.Struct({
  type: Schema.Literal("browser"),
  action: Schema.Literals(["navigate", "fill", "click", "wait", "extract"]),
  selector: Schema.String.pipe(optional),
  value: Schema.String.pipe(optional),
}).annotate({ identifier: "AutomationApp.BrowserOperation" })

export interface ScriptOperation extends Schema.Schema.Type<typeof ScriptOperation> {}
export const ScriptOperation = Schema.Struct({
  type: Schema.Literal("script"),
  runtime: Schema.Literals(["python", "javascript"]),
  source: Schema.String,
}).annotate({ identifier: "AutomationApp.ScriptOperation" })

export const Operation = Schema.Union([BrowserOperation, ScriptOperation]).annotate({ identifier: "AutomationApp.Operation" })
export type Operation = typeof Operation.Type

export interface Step extends Schema.Schema.Type<typeof Step> {}
export const Step = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  businessStage: Schema.String.pipe(optional),
  operation: Operation,
}).annotate({ identifier: "AutomationApp.Step" })

export interface Definition extends Schema.Schema.Type<typeof Definition> {}
export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Array(Parameter),
  steps: Schema.Array(Step),
  model: Model.Ref.pipe(optional),
}).annotate({ identifier: "AutomationApp.Definition" })

export interface App extends Schema.Schema.Type<typeof App> {}
export const App = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  definition: Definition,
  version: Schema.Int,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "AutomationApp.App" })

export interface StepResult extends Schema.Schema.Type<typeof StepResult> {}
export const StepResult = Schema.Struct({
  stepId: Schema.String,
  status: Schema.Literals(["running", "succeeded", "paused"]),
  output: Schema.String.pipe(optional),
  error: Schema.String.pipe(optional),
  repairAttempts: Schema.Int,
  repairedOperation: Operation.pipe(optional),
  pauseReason: Schema
    .Literals(["confirmation", "uncertain", "failed", "repair_review", "repair_running"])
    .pipe(optional),
  approved: Schema.Boolean.pipe(optional),
  skipped: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "AutomationApp.StepResult" })

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  id: Schema.String,
  appId: Schema.String,
  ownerId: Schema.String,
  sessionId: Schema.String,
  targetId: Schema.NullOr(Schema.String),
  requestKey: Schema.String,
  appVersion: Schema.Int,
  definition: Definition,
  parameters: Schema.Record(Schema.String, Schema.String),
  status: Schema.Literals(["queued", "running", "paused", "repairing", "succeeded", "failed"]),
  cursor: Schema.Int,
  results: Schema.Array(StepResult),
  error: Schema.NullOr(Schema.String),
  repairApplied: Schema.Boolean,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "AutomationApp.Run" })
