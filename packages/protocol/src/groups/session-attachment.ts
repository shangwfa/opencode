import { Attachment } from "@opencode/schema/attachment"
import { Session } from "@opencode/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { FileNotFoundError, SessionNotFoundError, UnknownError } from "../errors.js"

export const makeSessionAttachmentGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.session-attachment")
    .add(
      HttpApiEndpoint.get("session.attachment", "/api/session/:sessionID/attachment/:attachmentID", {
        params: { sessionID: Session.ID, attachmentID: Attachment.ID },
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
        error: [SessionNotFoundError, FileNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.attachment",
            summary: "Read managed session attachment",
            description: "Download a managed attachment stored in the session sandbox.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session attachments",
        description: "Session-scoped managed attachment downloads.",
      }),
    )
