import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { Log } from "@/util/log"

export namespace SystemPrompt {
  const log = Log.create({ service: "system-prompt" })

  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) {
      if (model.api.id.includes("codex")) {
        return [PROMPT_CODEX]
      }
      return [PROMPT_GPT]
    }
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
    return [PROMPT_DEFAULT]
  }

  export interface Interface {
    readonly environment: (model: Provider.Model) => string[]
    readonly skills: (agent: Agent.Info, preload?: string[], session?: string) => Effect.Effect<string | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const skill = yield* Skill.Service

      return Service.of({
        environment(model) {
          const project = Instance.project
          const lines = [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${Instance.directory}`,
            `  Workspace root folder: ${Instance.worktree}`,
            `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ]
          if (Flag.OPENCODE_SANDBOX_ENABLED) {
            lines.push(
              ``,
              `IMPORTANT: You are running in a sandboxed environment. ALL file operations (read, write, clone, download) MUST be performed inside the working directory (${Instance.directory}). Never use /tmp or any path outside the workspace.`,
            )
          }
          return [lines.join("\n")]
        },

        skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info, preload?: string[], session?: string) {
          if (Permission.disabled(["skill"], agent.permission).has("skill")) return

          const list = yield* skill.available(agent, session)

          const parts: string[] = []

          if (preload?.length) {
            for (const name of preload) {
              const info = yield* skill.get(name, session)
              if (!info) {
                log.warn("preload skill not found", { name })
                continue
              }
              parts.push(
                `<skill_content name="${info.name}">`,
                `# Skill: ${info.name}`,
                "",
                info.content.trim(),
                "",
              )
              if (info.resources.length > 0) {
                parts.push(
                  "<resources>",
                  ...info.resources.flatMap((resource) => [
                    `  <resource path="${resource.path}" type="${resource.type}">`,
                    resource.content.trim(),
                    "  </resource>",
                  ]),
                  "</resources>",
                  "",
                )
              }
              parts.push("</skill_content>")
            }
          }

          parts.push(
            "Skills provide specialized instructions and workflows for specific tasks.",
            "Use the skill tool to load a skill when a task matches its description.",
            Skill.fmt(list, { verbose: true }),
          )

          return parts.join("\n")
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))
}
