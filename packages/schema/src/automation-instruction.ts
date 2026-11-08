export * as AutomationInstruction from "./automation-instruction.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { Model } from "./model.js"
import { Parameter } from "./automation-app.js"

/**
 * 指令驱动的自动化应用。
 *
 * 与固定动作应用（AutomationApp.Definition）是两套独立契约：
 * 指令只描述业务目标与约束，由执行时的 AI 在会话中完成，不固化选择器或脚本。
 */

export interface Instruction extends Schema.Schema.Type<typeof Instruction> {}
export const Instruction = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  text: Schema.String,
  /** 标记后，平台要求用户在运行前显式确认，不再只依赖模型自觉。 */
  requiresConfirmation: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "AutomationInstruction.Instruction" })

export interface Verification extends Schema.Schema.Type<typeof Verification> {}
export const Verification = Schema.Struct({
  /** 相对 /workspace 的产物路径，例如 output/report.json。 */
  path: Schema.String,
  contains: Schema.String.pipe(optional),
}).annotate({ identifier: "AutomationInstruction.Verification" })

export interface Definition extends Schema.Schema.Type<typeof Definition> {}
export const Definition = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Array(Parameter),
  instructions: Schema.Array(Instruction),
  verification: Verification.pipe(optional),
  model: Model.Ref.pipe(optional),
}).annotate({ identifier: "AutomationInstruction.Definition" })

export interface Draft extends Schema.Schema.Type<typeof Draft> {}
export const Draft = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  sessionId: Schema.String,
  definition: Definition,
  version: Schema.Int,
  contentHash: Schema.String,
  publishedAppId: Schema.NullOr(Schema.String),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "AutomationInstruction.Draft" })

export interface App extends Schema.Schema.Type<typeof App> {}
export const App = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  definition: Definition,
  version: Schema.Int,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "AutomationInstruction.App" })

/** 运行中的一个业务步骤；每步独立派发，便于逐条核对进度。 */
export interface Step extends Schema.Schema.Type<typeof Step> {}
export const Step = Schema.Struct({
  index: Schema.Int,
  title: Schema.String,
  promptId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["pending", "running", "succeeded", "failed"]),
  output: Schema.NullOr(Schema.String),
}).annotate({ identifier: "AutomationInstruction.Step" })

export interface Run extends Schema.Schema.Type<typeof Run> {}
export const Run = Schema.Struct({
  id: Schema.String,
  appId: Schema.NullOr(Schema.String),
  draftId: Schema.NullOr(Schema.String),
  draftHash: Schema.NullOr(Schema.String),
  ownerId: Schema.String,
  sessionId: Schema.String,
  requestKey: Schema.String,
  appVersion: Schema.Int,
  definition: Definition,
  parameters: Schema.Record(Schema.String, Schema.String),
  promptId: Schema.NullOr(Schema.String),
  /** 逐步执行的进度；promptId 指向当前正在执行的步骤。 */
  steps: Schema.Array(Step),
  status: Schema.Literals(["queued", "running", "regenerating", "paused", "succeeded", "failed"]),
  output: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  regeneratedVersion: Schema.NullOr(Schema.Int),
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "AutomationInstruction.Run" })
