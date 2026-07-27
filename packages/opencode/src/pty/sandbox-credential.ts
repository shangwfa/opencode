export * as SandboxPtyCredential from "./sandbox-credential"

import { Context, Effect, Layer } from "effect"
import { createHmac } from "node:crypto"
import { Flag } from "@/flag/flag"
import type { SessionID } from "@/session/schema"

export interface Interface {
  readonly token: (root: SessionID) => string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxPtyCredential") {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    if (!Flag.OPENCODE_SANDBOX_API_KEY) throw new Error("OPENCODE_SANDBOX_API_KEY is required for sandbox PTY")
    if (!Flag.OPENCODE_PTY_TICKET_SECRET) throw new Error("OPENCODE_PTY_TICKET_SECRET is required for sandbox PTY")
    return Service.of({
      token: (root) => createHmac("sha256", Flag.OPENCODE_SANDBOX_API_KEY).update(root).digest("hex"),
    })
  }),
)
