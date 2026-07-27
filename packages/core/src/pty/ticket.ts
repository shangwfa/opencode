export * as PtyTicket from "./ticket"

import { WorkspaceV2 } from "../workspace"
import { PtyTicket } from "@opencode-ai/schema/pty-ticket"
import { PtyID } from "./schema"
import { Context, Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { createHmac, timingSafeEqual } from "node:crypto"

const DEFAULT_TTL = Duration.seconds(30)
const DEFAULT_SECRET = process.env.OPENCODE_PTY_TICKET_SECRET || crypto.randomUUID()

export const ConnectToken = PtyTicket.ConnectToken

export type Scope = {
  readonly ptyID: PtyID
  readonly sessionID?: string
  readonly directory?: string
  readonly workspaceID?: WorkspaceV2.ID
}

export interface Interface {
  issue(input: Scope): Effect.Effect<typeof ConnectToken.Type>
  consume(input: Scope & { readonly ticket: string }): Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PtyTicket") {}

function matches(record: Scope, input: Scope) {
  return (
    record.ptyID === input.ptyID &&
    record.sessionID === input.sessionID &&
    record.directory === input.directory &&
    record.workspaceID === input.workspaceID
  )
}

function sign(secret: string, payload: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url")
}

export const make = (ttl: Duration.Input = DEFAULT_TTL, secret = DEFAULT_SECRET) =>
  Effect.sync(() => {
    const duration = Duration.fromInputUnsafe(ttl)
    const expiresIn = Math.max(1, Math.round(Duration.toSeconds(duration)))
    const expiresInMillis = Duration.toMillis(duration)
    return Service.of({
      issue: Effect.fn("PtyTicket.issue")(function* (input) {
        const payload = Buffer.from(JSON.stringify({ scope: input, expiresAt: Date.now() + expiresInMillis })).toString(
          "base64url",
        )
        return { ticket: `${payload}.${sign(secret, payload)}`, expires_in: expiresIn }
      }),
      consume: Effect.fn("PtyTicket.consume")(function* (input) {
        const [payload, signature, extra] = input.ticket.split(".")
        if (!payload || !signature || extra) return false
        const expected = sign(secret, payload)
        if (
          signature.length !== expected.length ||
          !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
        )
          return false
        try {
          const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
            scope?: Scope
            expiresAt?: unknown
          }
          return (
            typeof parsed.expiresAt === "number" &&
            parsed.expiresAt >= Date.now() &&
            !!parsed.scope &&
            matches(parsed.scope, input)
          )
        } catch {
          return false
        }
      }),
    })
  })

const layer = Layer.effect(Service, make())

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })
