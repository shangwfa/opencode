import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { getRequestUserId } from "@/auth/request-user"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ConflictError, QuestionNotFoundError } from "../errors"

export const questionHandlers = HttpApiBuilder.group(InstanceHttpApi, "question", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      return yield* svc.list(getRequestUserId(request.headers))
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      yield* svc
        .reply(
          {
            requestID: ctx.params.requestID,
            answers: ctx.payload.answers,
          },
          getRequestUserId(request.headers),
        )
        .pipe(
          Effect.catchTag("Question.NotFoundError", (error) =>
            Effect.fail(
              new QuestionNotFoundError({
                requestID: String(error.requestID),
                message: `Question request not found: ${error.requestID}`,
              }),
            ),
          ),
          Effect.catchTag("Question.ConflictError", (error) =>
            Effect.fail(
              new ConflictError({
                resource: String(error.requestID),
                message: `Question request is already ${error.status}${error.closeReason ? ` (${error.closeReason})` : ""}`,
              }),
            ),
          ),
        )
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      const request = yield* HttpServerRequest.HttpServerRequest
      yield* svc.reject(ctx.params.requestID, getRequestUserId(request.headers)).pipe(
        Effect.catchTag("Question.NotFoundError", (error) =>
          Effect.fail(
            new QuestionNotFoundError({
              requestID: String(error.requestID),
              message: `Question request not found: ${error.requestID}`,
            }),
          ),
        ),
        Effect.catchTag("Question.ConflictError", (error) =>
          Effect.fail(
            new ConflictError({
              resource: String(error.requestID),
              message: `Question request is already ${error.status}${error.closeReason ? ` (${error.closeReason})` : ""}`,
            }),
          ),
        ),
      )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply).handle("reject", reject)
  }),
)
