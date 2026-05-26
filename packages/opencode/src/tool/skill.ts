import path from "path"
import { pathToFileURL } from "url"
import { Effect, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
  resources: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional resource paths to load from this skill bundle",
  }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* skill.get(params.name, ctx.sessionID)
          if (!info) {
            const all = yield* skill.all(ctx.sessionID)
            const available = all.map((item) => item.name).join(", ")
            throw new Error(`Skill "${params.name}" not found. Available skills: ${available || "none"}`)
          }

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const resources = info.resources ?? []
          const requested = new Set(params.resources ?? [])
          const selected = params.resources ? resources.filter((item) => requested.has(item.path)) : []
          const missing =
            params.resources?.filter((item) => !resources.some((resource) => resource.path === item)) ?? []

          // session:// and memory:// skills: manifest + on-demand resources only
          if (info.location.startsWith("session://") || info.location.startsWith("memory://")) {
            return {
              title: `Loaded skill: ${info.name}`,
              output: [
                `<skill_content name="${info.name}">`,
                `# Skill: ${info.name}`,
                "",
                info.content.trim(),
                "",
                resources.length > 0 ? "<resources>" : undefined,
                ...(params.resources
                  ? selected.flatMap((resource) => [
                      `  <resource path="${resource.path}" type="${resource.type}">`,
                      resource.content.trim(),
                      "  </resource>",
                    ])
                  : resources.map(
                      (resource) =>
                        `  <resource path="${resource.path}" type="${resource.type}" size="${Buffer.byteLength(resource.content)}" />`,
                    )),
                ...missing.map((item) => `  <missing_resource path="${item}" />`),
                resources.length > 0 ? "</resources>" : undefined,
                "</skill_content>",
              ]
                .filter((line) => line !== undefined)
                .join("\n"),
              metadata: {
                name: info.name,
                dir: info.location,
                resources: selected.map((item) => item.path),
              },
            }
          }

          // file-based skill: always output Base directory + skill_files
          const dir = path.dirname(info.location)
          const base = pathToFileURL(dir).href
          const limit = 10
          const files = yield* rg.files({ cwd: dir, follow: false, hidden: true, signal: ctx.abort }).pipe(
            Stream.filter((file) => !file.includes("SKILL.md")),
            Stream.map((file) => path.resolve(dir, file)),
            Stream.take(limit),
            Stream.runCollect,
            Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
          )

          const resourcesBlock =
            resources.length > 0
              ? [
                  "",
                  "<resources>",
                  ...(params.resources
                    ? selected.flatMap((resource) => [
                        `  <resource path="${resource.path}" type="${resource.type}">`,
                        resource.content.trim(),
                        "  </resource>",
                      ])
                    : resources.map(
                        (resource) =>
                          `  <resource path="${resource.path}" type="${resource.type}" size="${Buffer.byteLength(resource.content)}" />`,
                      )),
                  ...missing.map((item) => `  <missing_resource path="${item}" />`),
                  "</resources>",
                ]
              : []

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${info.name}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files,
              "</skill_files>",
              ...resourcesBlock,
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
              resources: selected.map((item) => item.path),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
