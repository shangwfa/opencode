export * as BrowserWorkspace from "./browser-workspace.js"

import { Schema } from "effect"

export interface SessionInfo extends Schema.Schema.Type<typeof SessionInfo> {}
export const SessionInfo = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  ownerId: Schema.String,
  timeCreated: Schema.Number,
}).annotate({ identifier: "BrowserWorkspace.SessionInfo" })

export interface Target extends Schema.Schema.Type<typeof Target> {}
export const Target = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
  type: Schema.String,
}).annotate({ identifier: "BrowserWorkspace.Target" })

export interface ScriptInfo extends Schema.Schema.Type<typeof ScriptInfo> {}
export const ScriptInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  visibility: Schema.Literals(["private", "public"]),
  ownerId: Schema.String,
  version: Schema.Int,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
}).annotate({ identifier: "BrowserWorkspace.ScriptInfo" })

export interface Version extends Schema.Schema.Type<typeof Version> {}
export const Version = Schema.Struct({
  scriptId: Schema.String,
  version: Schema.Int,
  content: Schema.String,
  changelog: Schema.String,
  timeCreated: Schema.Number,
}).annotate({ identifier: "BrowserWorkspace.Version" })
