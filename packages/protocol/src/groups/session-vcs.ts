import { FileDiff } from "@opencode/schema/file-diff"
import { NonNegativeInt, optional } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Vcs } from "@opencode/schema/vcs"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError, SessionNotFoundError } from "../errors.js"

const DiffQuery = Schema.Struct({
  mode: Vcs.Mode,
  base: optional(Schema.String),
  context: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

/**
 * Session-scoped VCS routes. The diff runs inside the session's sandbox at the
 * session's own working directory, so sandbox-mounted repositories stay
 * visible — the location-scoped `/api/vcs/diff` cannot see them.
 */
export const makeSessionVcsGroup = <I extends HttpApiMiddleware.AnyId, S>(
  sessionLocationMiddleware: Context.Key<I, S>,
) =>
  HttpApiGroup.make("server.session-vcs")
    .add(
      HttpApiEndpoint.get("session.vcsDiff", "/api/session/:sessionID/vcs/diff", {
        params: { sessionID: Session.ID },
        query: DiffQuery,
        success: Schema.Struct({ data: Schema.Array(FileDiff.Info) }),
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.vcs.diff",
            summary: "Diff the session workspace",
            description:
              "Diff the session's working directory inside its sandbox: HEAD to the working copy (working), the base merge-base to the working copy (branch), or the base merge-base to HEAD (committed). Untracked files are included except in committed mode.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "session vcs",
        description: "Session-scoped version control routes backed by the session sandbox.",
      }),
    )
