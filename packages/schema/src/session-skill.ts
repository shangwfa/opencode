export * as SessionSkill from "./session-skill.js"

import { Schema } from "effect"
import { optional, statics } from "./schema.js"
import { Skill } from "./skill.js"

export const ID = Schema.String.check(Schema.isStartsWith("sskill_")).pipe(
  Schema.brand("SessionSkill.ID"),
  statics((schema) => ({ create: () => schema.make(`sskill_${crypto.randomUUID().replaceAll("-", "")}`) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Literals(["global", "session", "sandbox"])
export const ResourceType = Schema.Literals(["doc", "script", "template", "asset"])
export interface Resource extends Schema.Schema.Type<typeof Resource> {}
export const Resource = Schema.Struct({
  path: Schema.String,
  type: ResourceType,
  size: Schema.Int,
  digest: Schema.String,
}).annotate({ identifier: "SessionSkill.Resource" })

export interface ResourceInput extends Schema.Schema.Type<typeof ResourceInput> {}
export const ResourceInput = Schema.Struct({
  path: Schema.String,
  type: ResourceType,
  content: Schema.String,
}).annotate({ identifier: "SessionSkill.ResourceInput" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  skill: Skill.Info,
  source: Source,
  sourcePath: Schema.String.pipe(optional),
  resources: Schema.Array(Resource),
}).annotate({ identifier: "SessionSkill.Info" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({
  id: Skill.ID,
  name: Skill.Name.pipe(optional),
  description: Schema.String.pipe(optional),
  autoinvoke: Schema.Boolean.pipe(optional),
  content: Schema.String,
  resources: Schema.Array(ResourceInput).pipe(optional),
}).annotate({ identifier: "SessionSkill.Payload" })

export const MaxResourceBytes = 256 * 1024
export const MaxResourcesBytes = 1024 * 1024
export const MaxResources = 64

export class ResourceError extends Schema.TaggedError<ResourceError>()("SessionSkillResourceError", {
  message: Schema.String,
  path: Schema.String.pipe(optional),
}, { httpApiStatus: 400 }) {}
