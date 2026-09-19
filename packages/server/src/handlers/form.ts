import { Form } from "@opencode/core/form"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response, requestUserID } from "../location"
import { HttpServerRequest } from "effect/unstable/http"

export const FormHandler = HttpApiBuilder.group(Api, "server.form", (handlers) =>
  handlers.handle(
    "form.list",
    Effect.fn(function* () {
      const form = yield* Form.Service
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* response(form.list({ userID: requestUserID(request) }))
    }),
  ),
)
