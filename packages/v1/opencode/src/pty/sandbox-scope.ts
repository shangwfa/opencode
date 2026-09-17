export * as SandboxPtyScope from "./sandbox-scope"

import { Context, Effect, Layer } from "effect"
import { resolveSandboxOpts, type SandboxOpts } from "@/session/sandbox-opts"
import type { SessionID } from "@/session/schema"
import { Session } from "@/session/session"

export interface Interface {
  readonly resolve: (sessionID: SessionID) => Effect.Effect<SandboxOpts, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxPtyScope") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return Service.of({
      resolve: (sessionID) =>
        sessions.get(sessionID).pipe(Effect.flatMap(() => Effect.promise(() => resolveSandboxOpts(sessionID)))),
    })
  }),
)
