import { Vcs } from "@opencode/core/vcs"
import { ServiceUnavailableError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const unavailable = (message: string) => new ServiceUnavailableError({ service: "vcs", message })

// Location-scoped routes over the server's own filesystem. Session sandboxes
// are served by the session-vcs group instead.
export const VcsHandler = HttpApiBuilder.group(Api, "server.vcs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle("vcs.get", () =>
        response(
          Effect.gen(function* () {
            const vcs = yield* Vcs.Service
            return yield* vcs.info()
          }),
        ),
      )
      .handle("vcs.base", () =>
        response(
          Effect.gen(function* () {
            const vcs = yield* Vcs.Service
            return yield* vcs.base().pipe(Effect.mapError((error) => unavailable(error.message)))
          }),
        ),
      )
      .handle("vcs.status", () =>
        response(
          Effect.gen(function* () {
            const vcs = yield* Vcs.Service
            return yield* vcs.status()
          }),
        ),
      )
      .handle("vcs.branch.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const vcs = yield* Vcs.Service
            return yield* vcs.branches({ search: ctx.query.search, limit: Math.min(ctx.query.limit ?? 50, 100) })
          }),
        ),
      )
      .handle("vcs.diff", (ctx) =>
        response(
          Effect.gen(function* () {
            const vcs = yield* Vcs.Service
            return yield* vcs
              .diff(ctx.query.mode, { context: ctx.query.context, base: ctx.query.base })
              .pipe(Effect.mapError((error) => unavailable(error.message)))
          }),
        ),
      )
  }),
)
