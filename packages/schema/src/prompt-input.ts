export * as PromptInput from "./prompt-input.js"

import { Schema } from "effect"
import { AgentAttachment, PromptMention } from "./prompt.js"
import { optional, statics } from "./schema.js"
import { Skill } from "./skill.js"
import { OutputFormat } from "./output-format.js"
import { Permission } from "./permission.js"

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  mention: PromptMention.pipe(optional),
})
  .annotate({ identifier: "PromptInput.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) => schema.make(input),
    })),
  )

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export interface SkillAttachment extends Schema.Schema.Type<typeof SkillAttachment> {}
export const SkillAttachment = Schema.Struct({
  id: Skill.ID,
  mention: PromptMention.pipe(optional),
}).annotate({ identifier: "PromptInput.SkillAttachment" })

export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  skills: Schema.Array(SkillAttachment).pipe(optional),
  /** Output shape for this prompt; `json_schema` forces a structured tool call. */
  format: OutputFormat.Format.pipe(optional),
  /** Optional permission preset for this prompt only; absent means use the Agent's configured rules. */
  preset: Permission.Preset.pipe(optional),
  /** Optional explicit rules for this prompt; explicit rules follow preset rules. */
  permissions: Permission.Ruleset.pipe(optional),
}).annotate({ identifier: "PromptInput" })
