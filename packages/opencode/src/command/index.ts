import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { EffectBridge } from "@/effect/bridge"
import type { InstanceContext } from "@/project/instance-context"
import { Effect, Layer, Context, Schema, Option } from "effect"
import { Config } from "@/config/config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_CODEX_REVIEW from "./template/codex-review.txt"
import { LegacyEvent } from "@opencode-ai/schema/legacy-event"
import { SessionCommand } from "./session-command"
import { Flag } from "@/flag/flag"
import type { SessionID } from "@/session/schema"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: LegacyEvent.CommandExecuted,
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
  // Some command templates are lazy promises from MCP prompt resolution.
  template: Schema.Unknown,
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
}).annotate({ identifier: "Command" })

export type Info = Omit<Schema.Schema.Type<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

function rowToInfo(row: SessionCommand.Row): Info {
  return {
    name: row.name,
    description: row.description ?? undefined,
    agent: row.agent ?? undefined,
    model: row.model ?? undefined,
    source: "command",
    template: row.template,
    subtask: row.subtask ?? undefined,
    hints: row.hints,
  }
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
  CODEX_REVIEW: "codex-review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
  readonly sessionList: (session: SessionID) => Effect.Effect<Info[]>
  readonly sessionGet: (name: string, session?: SessionID) => Effect.Effect<Info | undefined>
  readonly sessionCreate: (session: SessionID, input: SessionCommand.Input) => Effect.Effect<Info>
  readonly sessionRemove: (session: SessionID, name: string) => Effect.Effect<void>
  readonly sessionClear: (session: SessionID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service
    const sessionCommandSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionCommand.Service))

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }
      commands[Default.CODEX_REVIEW] = {
        name: Default.CODEX_REVIEW,
        description: "structured code review with priority levels and merge verdict (codex-style)",
        source: "command",
        get template() {
          return PROMPT_CODEX_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_CODEX_REVIEW),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        const dir = item.location === "<built-in>" ? undefined : path.dirname(item.location)
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            if (!dir) return item.content
            return [
              item.content,
              "",
              `Base directory for this skill: ${dir}`,
              "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
            ].join("\n")
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    const sessionList = Effect.fn("Command.sessionList")(function* (session: SessionID) {
      const s = yield* InstanceState.get(state)
      const base = Object.values(s.commands)
      if (!sessionCommandSvc || !Flag.OPENCODE_DATABASE_URL) return base
      const rows = yield* sessionCommandSvc.list(session).pipe(Effect.catch(() => Effect.succeed([])))
      if (rows.length === 0) return base
      const overlay = new Map(rows.map((r) => [r.name, rowToInfo(r)]))
      return base
        .map((c) => overlay.get(c.name) ?? c)
        .concat([...overlay.values()].filter((c) => !base.some((b) => b.name === c.name)))
    }, Effect.orDie)

    const sessionGet = Effect.fn("Command.sessionGet")(function* (name: string, session?: SessionID) {
      const s = yield* InstanceState.get(state)
      if (!session || !sessionCommandSvc || !Flag.OPENCODE_DATABASE_URL) return s.commands[name]
      const row = yield* sessionCommandSvc
        .get(session, name)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (row) return rowToInfo(row)
      return s.commands[name]
    }, Effect.orDie)

    const sessionCreate = Effect.fn("Command.sessionCreate")(
      function* (session: SessionID, input: SessionCommand.Input) {
        if (!sessionCommandSvc || !Flag.OPENCODE_DATABASE_URL) {
          throw new Error("Session commands are only available in SaaS mode")
        }
        const computedHints = input.hints ?? hints(input.template)
        const row = yield* sessionCommandSvc.upsert(session, { ...input, hints: computedHints })
        return rowToInfo(row)
      },
      Effect.orDie,
    )

    const sessionRemove = Effect.fn("Command.sessionRemove")(function* (session: SessionID, name: string) {
      if (!sessionCommandSvc || !Flag.OPENCODE_DATABASE_URL) {
        throw new Error("Session commands are only available in SaaS mode")
      }
      yield* sessionCommandSvc.remove(session, name)
    }, Effect.orDie)

    const sessionClear = Effect.fn("Command.sessionClear")(function* (session: SessionID) {
      if (!sessionCommandSvc || !Flag.OPENCODE_DATABASE_URL) {
        throw new Error("Session commands are only available in SaaS mode")
      }
      yield* sessionCommandSvc.removeAll(session)
    }, Effect.orDie)

    return Service.of({ get, list, sessionList, sessionGet, sessionCreate, sessionRemove, sessionClear })
  }),
)

const sessionCommandNode = LayerNode.make({
  service: SessionCommand.Service,
  layer: Flag.OPENCODE_DATABASE_URL ? SessionCommand.pgLayer : SessionCommand.noopLayer,
  deps: [],
})

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, MCP.node, Skill.node, sessionCommandNode],
})

export * as Command from "."
