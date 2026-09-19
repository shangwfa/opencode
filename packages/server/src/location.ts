import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Workspace } from "@opencode/schema/workspace"
import { Session } from "@opencode/core/session"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { missingSession } from "./handlers/session-error"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

export const sessionInfo = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: unknown) {
  const id = yield* decodeSessionID(sessionID).pipe(
    Effect.mapError(() => new InvalidRequestError({ message: "Invalid session ID", field: "sessionID" })),
  )
  return yield* sessions.get(id).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
})

export function requestRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  // Explicit workspace addressing (e.g. sandbox file browsing without a session).
  const workspace = request.headers["x-opencode-workspace"]
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    ...(workspace === undefined ? {} : { workspaceID: Workspace.ID.make(decode(workspace)) }),
  })
}

const USER_ID_HEADER = "x-user-id"
const USER_NAME_HEADER = "x-user-name"
const MAX_USER_ID_LENGTH = 128

/** v1's normalization: trim, cap at 128, and treat absent/blank as the public bucket. */
export function normalizeUserID(input: unknown): string {
  if (typeof input !== "string") return ""
  const trimmed = input.trim()
  return trimmed ? trimmed.slice(0, MAX_USER_ID_LENGTH) : ""
}

/** Acting user for HITL scoping, read from the v1-compatible `x-user-id` header. */
export function requestUserID(request: HttpServerRequest.HttpServerRequest): string {
  const raw = request.headers[USER_ID_HEADER]
  return normalizeUserID(Array.isArray(raw) ? raw[0] : raw)
}

/** Display name for the acting user (v1's per-message `userName`), `x-user-name` header. */
export function requestUserName(request: HttpServerRequest.HttpServerRequest): string {
  const raw = request.headers[USER_NAME_HEADER]
  return normalizeUserID(Array.isArray(raw) ? raw[0] : raw)
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const sessions = yield* Session.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const query = new URL(request.url, "http://localhost").searchParams
        // SaaS: a sessionID query pins the request to that session's location,
        // so fs endpoints address the session's sandbox workspace (v1 parity:
        // /file?path=...&sessionID=...).
        const sessionID = query.get("sessionID")
        // A bad sessionID falls back to header-based addressing instead of
        // failing the request: fs endpoints must not require a session.
        const ref =
          sessionID === null
            ? requestRef(request)
            : yield* sessionInfo(sessions, sessionID).pipe(
                Effect.map((info) => info.location),
                Effect.catchTags({
                  InvalidRequestError: () => Effect.succeed(requestRef(request)),
                  SessionNotFoundError: () => Effect.succeed(requestRef(request)),
                }),
              )
        return yield* effect.pipe(Effect.provide(locations.get(ref)))
      }),
    )
  }),
)
