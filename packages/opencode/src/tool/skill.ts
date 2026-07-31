import path from "path"
import { Effect, Option, Schema } from "effect"
import type { Sandbox } from "@alibaba-group/opensandbox"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Skill } from "../skill"
import { SkillResource } from "../skill/resource"
import type { SessionID } from "../session/schema"
import { escapeHtml } from "@/util/html"
import { SandboxProvider } from "./sandbox-provider"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from available_skills" }),
})

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service

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

          // Session skills are durable PG snapshots. Their resources belong in
          // the code-agent filesystem rather than model context.
          if (info.location.startsWith("session://") || info.location.startsWith("memory://")) {
            const dir = yield* materialize(info, ctx)
            return {
              title: `Loaded skill: ${info.name}`,
              output: sessionOutput(info, dir),
              metadata: {
                name: info.name,
                dir: dir ?? info.location,
                resources: resources.map((item) => item.path),
              },
            }
          }

          // file-based skill: always output Base directory + skill_files
          const dir = path.dirname(info.location)
          const base = dir
          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })

          const resourcesBlock =
            resources.length > 0
              ? [
                  "",
                  "<resources>",
                  ...resources.map(
                    (resource) =>
                      `  <resource path="${escapeHtml(resource.path)}" type="${resource.type}" size="${resource.size}" digest="${resource.digest}" />`,
                  ),
                  "</resources>",
                ]
              : []

          return {
            title: `Loaded skill: ${info.name}`,
            output: [
              `<skill_content name="${escapeHtml(info.name)}">`,
              `# Skill: ${info.name}`,
              "",
              info.content.trim(),
              "",
              `Base directory for this skill: ${base}`,
              "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
              "Note: file list is sampled.",
              "",
              "<skill_files>",
              files.map((file) => `<file>${escapeHtml(path.resolve(dir, file.path))}</file>`).join("\n"),
              "</skill_files>",
              ...resourcesBlock,
              "</skill_content>",
            ].join("\n"),
            metadata: {
              name: info.name,
              dir,
              resources: resources.map((item) => item.path),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export function materialize(info: Skill.Info, ctx: Tool.Context) {
  return Effect.gen(function* () {
    const resources = info.resources ?? []
    if (resources.length === 0 || !ctx.sandbox) return undefined
    const sandbox = (yield* Effect.promise(() => ctx.sandbox!)) as Sandbox | null
    if (!sandbox) return undefined
    return yield* writeToSandbox(info, ctx.sessionID, sandbox)
  })
}

function writeToSandbox(info: Skill.Info, sessionID: string, sandbox: Sandbox) {
  return Effect.gen(function* () {
    const resources = info.resources ?? []
    const dir = SkillResource.directory(sessionID, info.name, info.content, resources)
    const manifest = {
      name: info.name,
      description: info.description ?? "",
      snapshot: SkillResource.snapshot(info.content, resources),
      resources: resources.map(SkillResource.metadata),
    }
    const skillMd = info.content.trimStart().startsWith("---")
      ? info.content.trim()
      : [
          "---",
          `name: ${JSON.stringify(info.name)}`,
          `description: ${JSON.stringify(info.description ?? "")}`,
          "---",
          "",
          info.content.trim(),
          "",
        ].join("\n")
    const files = [
      { path: path.posix.join(dir, "SKILL.md"), data: skillMd },
      { path: path.posix.join(dir, "resources.json"), data: JSON.stringify(manifest, null, 2) },
      ...resources.map((resource) => ({ path: path.posix.join(dir, resource.path), data: resource.content })),
    ]
    const directories = [...new Set(files.map((file) => path.posix.dirname(file.path)))]

    yield* Effect.tryPromise(() => sandbox.files.createDirectories(directories.map((item) => ({ path: item }))))
    yield* Effect.tryPromise(() => sandbox.files.writeFiles(files))
    yield* Effect.tryPromise(() => sandbox.commands.run(`find ${dir} -type f -exec chmod 644 {} +`))
    return dir
  })
}

/**
 * Before each model turn, check whether preloaded session skills still have
 * their materialized files in the sandbox. A sandbox rebuild wipes the
 * materialization directory, but AI cache-hits skip the skill tool — so
 * resources would be silently missing. This restores them proactively.
 *
 * Uses `SandboxProvider.get` (never creates a sandbox). If no sandbox exists
 * yet, or the materialization is still intact, this is a no-op.
 */
export const rematerializeIfNeeded = Effect.fn("SkillTool.rematerializeIfNeeded")(function* (
  sessionID: SessionID,
  preload?: string[],
) {
  if (!preload?.length) return
  const maybeProvider = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
  if (!maybeProvider) return

  const sandbox = yield* maybeProvider.get(sessionID).pipe(Effect.catch(() => Effect.succeed(null)))
  if (!sandbox) return

  const skillService = yield* Skill.Service
  for (const name of preload) {
    const info = yield* skillService.get(name, sessionID)
    if (!info) continue
    if (!info.location.startsWith("session://") && !info.location.startsWith("memory://")) continue
    const resources = info.resources ?? []
    if (resources.length === 0) continue

    const dir = SkillResource.directory(sessionID, info.name, info.content, resources)
    const sentinel = path.posix.join(dir, "resources.json")
    const exists = yield* Effect.tryPromise({
      try: async () => {
        const res = await sandbox.commands.run(`test -f ${sentinel} && echo YES`)
        return String(res?.stdout ?? res ?? "").includes("YES")
      },
      catch: () => false,
    })
    if (exists) continue

    yield* writeToSandbox(info, sessionID, sandbox).pipe(Effect.catch(() => Effect.void))
  }
})

export function sessionOutput(info: Skill.Info, dir?: string) {
  const resources = info.resources ?? []
  return [
    `<skill_content name="${escapeHtml(info.name)}">`,
    `# Skill: ${info.name}`,
    "",
    info.content.trim(),
    "",
    dir ? `<resource_directory>${escapeHtml(dir)}</resource_directory>` : undefined,
    !dir && resources.length > 0 ? "<resources_unavailable />" : undefined,
    resources.length > 0 ? "<resources>" : undefined,
    ...resources.map(
      (resource) =>
        `  <resource path="${escapeHtml(resource.path)}" type="${resource.type}" size="${resource.size}" digest="${resource.digest}" />`,
    ),
    resources.length > 0 ? "</resources>" : undefined,
    "</skill_content>",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}
