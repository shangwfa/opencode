import { Auth } from "@/auth"
import { getRequestUserId } from "@/auth/request-user"

import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@opencode-ai/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const userId = getRequestUserId(request.headers)
      yield* auth.set(ctx.params.providerID, ctx.payload, userId).pipe(Effect.orDie)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      const userId = getRequestUserId(request.headers)
      yield* auth.remove(ctx.params.providerID, userId).pipe(Effect.orDie)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      const write =
        ctx.payload.level === "debug"
          ? Effect.logDebug
          : ctx.payload.level === "info"
            ? Effect.logInfo
            : ctx.payload.level === "warn"
              ? Effect.logWarning
              : Effect.logError
      yield* write(ctx.payload.message).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
