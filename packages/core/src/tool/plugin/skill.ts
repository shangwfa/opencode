export * as SkillTool from "./skill.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import path from "path"
import { FSUtil } from "@opencode/util/fs-util"
import { Skill } from "../../skill.js"
import { SessionSkills } from "../../session/skills.js"
import { Session } from "../../session.js"
import { Permission } from "../../permission.js"

export const name = "skill"

export const Input = Schema.Struct({
  id: Skill.ID.annotate({ description: "The ID of an available skill or a skill explicitly referenced by the user" }),
})

export const Output = Schema.Struct({
  name: Skill.Name,
  /** Absent for Session-private skills without materialized resources. */
  directory: Schema.String.pipe(Schema.optional),
  output: Schema.String,
})
export const description = [
  "Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.",
  "",
  "The skill ID must match an available skill or a skill explicitly referenced by the user.",
].join("\n")

export const toModelOutput = Skill.toModelOutput

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

export const Plugin = {
  id: "opencode.tool.skill",
  effect: Effect.fn("SkillTool.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const skills = yield* SessionSkills.Service
    const sessions = yield* Session.Service
    const permission = yield* Permission.Service
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const session = yield* sessions
                .get(context.sessionID)
                .pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
              // Authorize the requested identity before overlay resolution can
              // perform remote discovery or initialize resource files.
              yield* permission
                .assert({
                  action: name,
                  resources: [input.id],
                  save: [input.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                .pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
              const resolved = yield* skills.get(session, input.id)
              if (!resolved) return yield* unableToLoad(input.id)
              const skill = resolved.skill
              return yield* Effect.gen(function* () {
                const files = yield* skills.files(session, resolved)
                const resourceDirectory = yield* skills.materialize(session, resolved)
                // Session-private skills have no host directory; without materialized
                // resources there is no base directory to advertise.
                const prepared =
                    resolved.source === "global"
                      ? yield* Skill.prepare(fs, skill)
                      : resolved.source === "sandbox"
                        ? { directory: path.dirname(skill.path), output: Skill.toModelOutput(skill, files) }
                        : {
                            directory: resourceDirectory,
                            output: Skill.toModelOutput(skill, files, resourceDirectory ?? null, resolved.resources),
                          }
                const scriptInstructions =
                  resourceDirectory !== undefined && resolved.resources.some((resource) => resource.type === "script")
                    ? [
                        "",
                        "<script_execution>",
                        "Script resources are files, not automatically executed tools.",
                        "Run a script only when the skill instructions require it. Use the shell tool in the session sandbox.",
                        "Resolve resource paths against resource_directory, not the shell working directory. Quote paths in shell commands.",
                        "Use the interpreter specified by the skill: for example, python3 for .py, node for .js/.mjs, or bash for Bash scripts.",
                        "Do not assume executable permission or run chmod merely to execute a script. Loading a skill does not authorize shell execution.",
                        "Check the exit status and required output or artifacts before reporting success. Report missing dependencies or execution failures.",
                        "</script_execution>",
                      ].join("\n")
                    : ""
                return {
                  name: skill.name,
                  ...(prepared.directory === undefined ? {} : { directory: prepared.directory }),
                  output:
                    resourceDirectory === undefined
                      ? prepared.output
                      : `${prepared.output}\n<resource_directory>${resourceDirectory}</resource_directory>${scriptInstructions}`,
                }
              }).pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.output,
                metadata: {
                  name: output.name,
                  ...(output.directory === undefined ? {} : { directory: output.directory }),
                },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
