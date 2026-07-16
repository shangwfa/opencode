import { NamedError } from "@opencode-ai/core/util/error"
import { ConfigErrorV1 } from "@opencode-ai/core/v1/config/error"
import { Cause, Effect, Option } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse, HttpServerRequest } from "effect/unstable/http"

function extractSessionID(url: string): string | undefined {
  const m = url.match(/\/session\/([^/?]+)/)
  return m ? m[1] : undefined
}

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const req = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    const sessionID = Option.isSome(req) ? extractSessionID(req.value.url) : undefined
    return yield* effect.pipe(
      Effect.catchCause((cause) => {
        const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
          if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
          if (HttpServerError.isHttpServerError(reason.defect)) return false
          if (HttpServerRespondable.isRespondable(reason.defect)) return false
          return true
        })
        if (!defect) return Effect.failCause(cause)

        const error = defect.defect
        if (
          ConfigErrorV1.JsonError.isInstance(error) ||
          ConfigErrorV1.InvalidError.isInstance(error) ||
          ConfigErrorV1.FrontmatterError.isInstance(error) ||
          ConfigErrorV1.DirectoryTypoError.isInstance(error)
        ) {
          return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
        }

        if (error instanceof SyntaxError) {
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { name: "BadRequest", data: { message: "Invalid JSON body" } },
              { status: 400 },
            ),
          )
        }

        const ref = `err_${crypto.randomUUID().slice(0, 8)}`

        return Effect.logError("failed", { ref, ...(sessionID ? { sessionID } : {}), error, cause: Cause.pretty(cause) }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              new NamedError.Unknown({
                message: "Unexpected server error. Check server logs for details.",
                ref,
              }).toObject(),
              { status: 500 },
            ),
          ),
        )
      }),
    )
  })
).layer
