export * as PtyRuntime from "./pty-runtime"

import { Pty } from "@opencode-ai/core/pty"
import { Location } from "@opencode-ai/core/location"
import { Context, Effect, Layer } from "effect"
import { PtyEnvironment } from "./pty-environment"

export interface Interface {
  readonly requiresTicket?: boolean
  readonly requiresSession?: boolean
  readonly list: (sessionID: string) => Effect.Effect<Pty.Info[]>
  readonly get: (sessionID: string, id: Pty.Info["id"]) => Effect.Effect<Pty.Info, Pty.NotFoundError>
  readonly create: (sessionID: string, input: Pty.CreateInput) => Effect.Effect<Pty.Info>
  readonly update: (
    sessionID: string,
    id: Pty.Info["id"],
    input: Pty.UpdateInput,
  ) => Effect.Effect<Pty.Info, Pty.NotFoundError>
  readonly remove: (sessionID: string, id: Pty.Info["id"]) => Effect.Effect<void, Pty.NotFoundError>
  readonly attach: (
    sessionID: string,
    id: Pty.Info["id"],
    input: Pty.AttachInput,
  ) => Effect.Effect<Pty.Attachment, Pty.NotFoundError | Pty.ExitedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ServerPtyRuntime") {}

export const localLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pty = yield* Pty.Service
    const location = yield* Location.Service
    const environment = yield* PtyEnvironment.Service
    return Service.of({
      requiresTicket: false,
      requiresSession: false,
      list: () => pty.list(),
      get: (_, id) => pty.get(id),
      create: (_, input) => {
        const cwd = input.cwd || location.directory
        return environment
          .get({ directory: location.directory, cwd })
          .pipe(Effect.flatMap((env) => pty.create({ ...input, cwd, env: { ...input.env, ...env } })))
      },
      update: (_, id, input) => pty.update(id, input),
      remove: (_, id) => pty.remove(id),
      attach: (_, id, input) => pty.attach(id, input),
    })
  }),
)
