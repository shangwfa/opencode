export * as SandboxAttachments from "./sandbox-attachments.js"

import { Effect, Scope } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Session } from "@opencode/core/session"
import { Workspace } from "@opencode/core/workspace"
import { makeFiles } from "@opencode/core/environment/index"
import { ToolAttachment } from "@opencode/core/tool/attachment"

/**
 * Managed tool-attachment download (v1 parity): raw bytes with Range/ETag
 * support, served from the RouteNotFound fallback because the response is not a
 * JSON HttpApi payload. The bytes live in the session's sandbox environment.
 */
export interface SandboxAttachmentsServices {
  readonly sessions: Session.Interface
  readonly workspace: Workspace.Interface
}

export const handler = (services: SandboxAttachmentsServices) => {
  const { sessions, workspace } = services

  type App = Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >

  const pipeline = (api: App) =>
    api.pipe(
      Effect.catchIf(isRouteNotFound, (error) =>
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.flatMap((request: HttpServerRequest.HttpServerRequest) => {
            const url = new URL(request.url, "http://localhost")
            const parsed = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/attachment\/(att_[0-9A-Za-z]+)$/.exec(url.pathname)
            if (parsed === null) return Effect.fail(error)
            return download(parsed[1]!, parsed[2]!, request).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("sandbox attachment failed", cause).pipe(
                  Effect.andThen(Effect.succeed(HttpServerResponse.empty({ status: 500 }))),
                ),
              ),
            )
          }),
        ),
      ),
    )

  const download = Effect.fn("server.sandbox-attachments.download")(function* (
    sessionID: string,
    attachmentID: string,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const session = Session.ID.make(sessionID)
    const info = yield* sessions.get(session)
    if (info === undefined) return HttpServerResponse.empty({ status: 404 })
    const workspaceID = info.location.workspaceID
    if (workspaceID === undefined) return HttpServerResponse.empty({ status: 404 })
    const connection = yield* workspace.connect(workspaceID).pipe(Effect.orDie)
    const files = makeFiles(connection)
    const opened = yield* ToolAttachment.open({
      files,
      sessionID: session,
      id: ToolAttachment.ID.make(attachmentID),
    }).pipe(Effect.catchTag("ToolAttachment.NotFoundError", () => Effect.succeed(undefined)))
    if (opened === undefined) return HttpServerResponse.empty({ status: 404 })

    const size = opened.metadata.size
    const range = ToolAttachment.parseByteRange(request.headers.range, size)
    if (range === null)
      return HttpServerResponse.empty({ status: 416, headers: { "Content-Range": `bytes */${size}` } })
    const etag = `"sha256-${opened.metadata.sha256}"`
    const ifNoneMatch = request.headers["if-none-match"]
      ?.split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
    if (!range && ifNoneMatch?.includes(etag))
      return HttpServerResponse.empty({ status: 304, headers: { ETag: etag } })

    const bytes = yield* opened
      .bytes(range ? { offset: range.start, length: range.end - range.start + 1 } : undefined)
      .pipe(Effect.orDie)
    const disposition = opened.metadata.audience === "display-only" ? "attachment" : "inline"
    return HttpServerResponse.raw(bytes, {
      status: range ? 206 : 200,
      contentType: opened.metadata.mime,
      headers: {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": `${disposition}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(opened.metadata.filename)}`,
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
        ETag: etag,
        "X-Content-Type-Options": "nosniff",
      },
    })
  })

  return pipeline
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}
