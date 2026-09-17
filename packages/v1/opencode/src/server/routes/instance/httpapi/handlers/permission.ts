import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import { getRequestUserId } from "@/auth/request-user"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http"
import { InstanceHttpApi } from "../api"
import { ConflictError, PermissionNotFoundError } from "../errors"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* svc.list(getRequestUserId(request.headers))
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      yield* svc
        .reply(
          {
            requestID: ctx.params.requestID,
            reply: ctx.payload.reply,
            message: ctx.payload.message,
          },
          getRequestUserId(request.headers),
        )
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
          Effect.catchTag("Permission.ConflictError", (error) =>
            Effect.fail(
              new ConflictError({
                resource: String(error.requestID),
                message: `Permission request is already ${error.status}${error.closeReason ? ` (${error.closeReason})` : ""}`,
              }),
            ),
          ),
        )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
