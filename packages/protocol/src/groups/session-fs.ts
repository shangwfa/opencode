import { FileSystem } from "@opencode/schema/filesystem"
import { PositiveInt } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { FileNotFoundError, SessionNotFoundError } from "../errors.js"

const ListQuery = Schema.Struct({
  path: Schema.String.pipe(Schema.optional).annotate({
    description: "An absolute path or a path relative to the session workspace. Defaults to the workspace root.",
  }),
})

const FindQuery = Schema.Struct({
  query: FileSystem.FindInput.fields.query,
  type: FileSystem.FindInput.fields.type,
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional),
})

/**
 * Session-scoped filesystem routes. Every endpoint resolves the session
 * through the session-location middleware and therefore operates on that
 * session's sandbox workspace instead of the host filesystem.
 */
export const makeSessionFileSystemGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.session-fs")
    .add(
      HttpApiEndpoint.get("session.fs.read", "/api/session/:sessionID/fs/read/*", {
        params: { sessionID: Session.ID },
        success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
        error: [SessionNotFoundError, FileNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.fs.read",
            summary: "Read session file",
            description: "Read one file from the session sandbox workspace.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.fs.list", "/api/session/:sessionID/fs/list", {
        params: { sessionID: Session.ID },
        query: ListQuery,
        success: Schema.Struct({ data: Schema.Array(FileSystem.Entry) }),
        error: [SessionNotFoundError, FileNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.fs.list",
            summary: "List session directory",
            description: "List direct children of a directory inside the session sandbox workspace.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.fs.find", "/api/session/:sessionID/fs/find", {
        params: { sessionID: Session.ID },
        query: FindQuery,
        success: Schema.Struct({ data: Schema.Array(FileSystem.Entry) }),
        error: [SessionNotFoundError, FileNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.fs.find",
            summary: "Find session files",
            description: "Find files recursively inside the session sandbox workspace.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session filesystem",
        description: "Session-scoped filesystem routes backed by the session sandbox.",
      }),
    )
