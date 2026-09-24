import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { SandboxVcsDiff } from "@opencode/core/sandbox/vcs-diff"
import { Session } from "@opencode/core/session"
import { FileDiff } from "@opencode/schema/file-diff"
import type { Vcs } from "@opencode/schema/vcs"
import { SessionNotFoundError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

type Mode = Schema.Schema.Type<typeof Vcs.Mode>

const DiffRows = Schema.Array(Schema.toEncoded(FileDiff.Info))

const unavailable = (message: string) => new ServiceUnavailableError({ service: "vcs", message })

/**
 * Session-scoped diff: runs git inside the session's sandbox with the
 * session's own working directory as the cwd. The sandbox-mounted workspace
 * is invisible to the location-scoped local git adapter, so this route owns
 * the sandboxed contract (V1 exec semantics).
 */
export const SessionVcsHandler = HttpApiBuilder.group(Api, "server.session-vcs", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    return handlers.handle(
      "session.vcsDiff",
      Effect.fn(function* (ctx) {
        // Resolved per request: the session-location middleware provides the
        // provider bound to this session's location.
        const provider = yield* SandboxProvider.Service
        if (!provider.enabled) return yield* unavailable("Session sandbox is not enabled")
        const info = yield* session.get(ctx.params.sessionID).pipe(
          Effect.catchTag(
            "Session.NotFoundError",
            () =>
              new SessionNotFoundError({
                sessionID: ctx.params.sessionID,
                message: `Session not found: ${ctx.params.sessionID}`,
              }),
          ),
        )
        const result = yield* provider
          .run({
            sessionID: ctx.params.sessionID,
            command: SandboxVcsDiff.vcsDiffCommand({
              mode: ctx.query.mode as Mode,
              base: ctx.query.base,
              context: ctx.query.context,
              directory: info.location.directory,
            }),
            hostWorkdir: info.location.directory,
            cwd: info.location.directory,
            timeoutMs: 30_000,
          })
          .pipe(Effect.mapError((error) => unavailable(`Failed to read sandbox diff: ${error.message}`)))
        const stdout = result.output.trim()
        if (!stdout) return yield* unavailable("Sandbox diff returned no output")
        let parsed: unknown
        try {
          parsed = JSON.parse(stdout)
        } catch {
          return yield* unavailable("Sandbox diff returned invalid JSON")
        }
        const failure = parsed as { error?: unknown }
        if (parsed && typeof parsed === "object" && typeof failure.error === "string") {
          return yield* unavailable(`Sandbox diff failed: ${failure.error}`)
        }
        return yield* Effect.try({
          try: () => ({ data: Schema.decodeUnknownSync(DiffRows)(parsed) }),
          catch: () => unavailable("Sandbox diff returned an unexpected payload"),
        })
      }),
    )
  }),
)
