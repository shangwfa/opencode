export * as SessionCommand from "./command.js"

import type { PromptInput } from "@opencode/schema/prompt-input"
import type { Session } from "@opencode/schema/session"
import type { SessionInbox } from "@opencode/schema/session-inbox"
import { Effect } from "effect"
import { Command } from "../command.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { SessionCommands } from "./commands.js"
import type { SandboxProvider } from "../sandbox/provider.js"
import type { RuntimeActions } from "./commands.js"

export const execute = Effect.fn("SessionCommand.execute")(function* (input: {
  session: Session.Info
  actions: RuntimeActions
  sandbox: SandboxProvider.Interface
  command: string
  text: string
  files?: PromptInput.Prompt["files"]
  agents?: PromptInput.Prompt["agents"]
  skills?: PromptInput.Prompt["skills"]
  delivery?: SessionInbox.Delivery
}) {
  const instances = yield* Instance.Service
  const commands = yield* Plugin.awaitActivation.pipe(Effect.andThen(Command.Service), instances.provide(input.session))
  const definition = yield* SessionCommands.get(input.session, input.command).pipe(
    Effect.mapError(
      (error) => new Command.ExecutionError({ command: input.command, message: error instanceof Error ? error.message : String(error) }),
    ),
  )
  if (!definition)
    return yield* new Command.NotFoundError({
      command: input.command,
      message: `Command not found: ${input.command}`,
    })
  const override = definition.source === "builtin"
    ? undefined
    : SessionCommands.executable(input.session, definition, input.actions, input.sandbox)
  yield* commands.execute({
    name: input.command,
    ...(override ? { definition: override } : {}),
    invocation: {
      sessionID: input.session.id,
      prompt: {
        text: input.text,
        files: input.files,
        agents: input.agents,
        skills: input.skills,
      },
      delivery: input.delivery ?? "steer",
    },
  })
})
