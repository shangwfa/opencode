import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import { EffectLogger } from "@/effect/logger"
import { Ripgrep } from "../file/ripgrep"
import { Skill } from "../skill"
import { Tool } from "./tool"

const Parameters = z.object({
  name: z.string().describe("The name of the skill from available_skills"),
  resources: z.array(z.string()).optional().describe("Optional resource paths to load from this skill bundle"),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return () =>
      Effect.gen(function* () {
        const list = yield* skill.available().pipe(Effect.provide(EffectLogger.layer))

        const description =
            list.length === 0
            ? "Load a specialized skill that provides domain-specific instructions and workflows. Session-specific skills may be listed in the system prompt available_skills manifest."
            : [
                "Load a specialized skill that provides domain-specific instructions and workflows.",
                "",
                "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
                "",
                "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
                "",
                'Tool output includes a `<skill_content name="...">` block with the loaded content.',
                "",
                "The following skills provide specialized sets of instructions for particular tasks",
                "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
                "",
                Skill.fmt(list, { verbose: false }),
              ].join("\n")

        return {
          description,
          parameters: Parameters,
          execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
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

              const requested = new Set(params.resources ?? [])
              const selected = params.resources
                ? info.resources.filter((item) => requested.has(item.path))
                : []
              const missing = params.resources?.filter((item) => !info.resources.some((resource) => resource.path === item)) ?? []

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
                    info.resources.length > 0 ? "<resources>" : undefined,
                    ...(params.resources
                      ? selected.flatMap((resource) => [
                          `  <resource path="${resource.path}" type="${resource.type}">`,
                          resource.content.trim(),
                          "  </resource>",
                        ])
                      : info.resources.map((resource) =>
                          `  <resource path="${resource.path}" type="${resource.type}" size="${Buffer.byteLength(resource.content)}" />`,
                        )),
                    ...missing.map((item) => `  <missing_resource path="${item}" />`),
                    info.resources.length > 0 ? "</resources>" : undefined,
                    "</skill_content>",
                  ].filter((line) => line !== undefined).join("\n"),
                  metadata: {
                    name: info.name,
                    dir: info.location,
                    resources: selected.map((item) => item.path),
                  },
                }
              }

              // file-based skill: always output Base directory + skill_files (original behaviour)
              // additionally append resource manifest if resources were loaded, so the model
              // can call skill(name, resources:[...]) for on-demand content
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

              const resourcesBlock = info.resources.length > 0
                ? [
                    "",
                    "<resources>",
                    ...(params.resources
                      ? selected.flatMap((resource) => [
                          `  <resource path="${resource.path}" type="${resource.type}">`,
                          resource.content.trim(),
                          "  </resource>",
                        ])
                      : info.resources.map((resource) =>
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
      })
  }),
)
