import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { ToolAttachment } from "@opencode/core/tool/attachment"
import { FileNotFoundError, UnknownError } from "@opencode/protocol/errors"
import { Effect, Option } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const missing = (id: string) => new FileNotFoundError({ path: id, message: `Attachment not found: ${id}` })
const encodeFilename = (filename: string) =>
  encodeURIComponent(filename).replace(/['()]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)

export const SessionAttachmentHandler = HttpApiBuilder.group(Api, "server.session-attachment", (handlers) =>
  Effect.gen(function* () {
    return handlers.handleRaw("session.attachment", (ctx) =>
      Effect.gen(function* () {
        const provider = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
        const input = { sessionID: ctx.params.sessionID, id: ctx.params.attachmentID }
        const file = yield* (provider?.enabled
          ? ToolAttachment.open({ ...input, provider })
          : ToolAttachment.openLocal(input)
        ).pipe(
          Effect.mapError((error) =>
            error instanceof ToolAttachment.NotFoundError
              ? missing(ctx.params.attachmentID)
              : new UnknownError({ message: "Failed to read managed attachment" }),
          ),
        )
        const range = ToolAttachment.parseByteRange(ctx.request.headers.range, file.metadata.size)
        if (range === null)
          return HttpServerResponse.empty({
            status: 416,
            headers: { "Content-Range": `bytes */${file.metadata.size}` },
          })

        const etag = `"sha256-${file.metadata.sha256}"`
        const condition = ctx.request.headers["if-none-match"]
        const matches = condition?.split(",").map((tag) => tag.trim()).some((tag) => tag === "*" || tag === etag)
        if (!range && matches)
          return HttpServerResponse.empty({ status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } })

        const bytes = range ? file.bytes.subarray(range.start, range.end + 1) : file.bytes
        const asciiName = file.metadata.filename.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment"
        return HttpServerResponse.uint8Array(bytes, {
          status: range ? 206 : 200,
          contentType: file.metadata.mime,
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=31536000, immutable",
            "Content-Disposition": `${file.metadata.audience === "display-only" ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeFilename(file.metadata.filename)}`,
            "X-Content-Type-Options": "nosniff",
            ETag: etag,
            ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${file.metadata.size}` } : {}),
          },
        })
      }),
    )
  }),
)
