import path from "path"
import { Location } from "@opencode/core/location"
import { Mime } from "@opencode/core/mime"
import { RelativePath } from "@opencode/core/schema"
import { SandboxPath } from "@opencode/core/sandbox/path"
import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { FileNotFoundError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

// Session-scoped filesystem reads. The session-location middleware already
// resolved the session and injected its Location services, so the provider
// reached here belongs to this session's sandbox.
//
// Two guardrails mirror the host-side FileSystem behavior:
// - browsing never starts a sandbox — an idle session fails fast instead of
//   holding the request behind a remote create
// - resolved paths must stay inside the sandbox workspace
const sandboxTarget = (directory: string, requested: string): { target?: string; error?: FileNotFoundError } => {
  const target = SandboxPath.toSandboxPath(path.resolve(directory, requested || "."), directory)
  if (!SandboxPath.isSandboxPath(target))
    return {
      error: new FileNotFoundError({ path: requested, message: `Path escapes the workspace: ${requested}` }),
    }
  return { target }
}

const notRunning = (path_: string) =>
  new FileNotFoundError({ path: path_, message: "Sandbox is not running for this session" })

export const SessionFileSystemHandler = HttpApiBuilder.group(Api, "server.session-fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handleRaw("session.fs.read", (ctx) =>
        Effect.gen(function* () {
          const provider = yield* SandboxProvider.Service
          const location = yield* Location.Service
          const raw = decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname)
          const marker = "/fs/read/"
          const index = raw.indexOf(marker)
          const requested = index >= 0 ? raw.slice(index + marker.length) : ""
          const resolved = sandboxTarget(location.directory, requested)
          if (resolved.error) return yield* Effect.fail(resolved.error)
          if (!(yield* provider.isReady(ctx.params.sessionID))) return yield* Effect.fail(notRunning(requested))
          const content = yield* provider.fileReadBytes(ctx.params.sessionID, resolved.target ?? ".").pipe(
            Effect.mapError((error) => new FileNotFoundError({ path: requested, message: error.message })),
          )
          if (content === null)
            return yield* Effect.fail(
              new FileNotFoundError({ path: requested, message: `File not found: ${requested}` }),
            )
          return HttpServerResponse.uint8Array(content, { contentType: Mime.detect(content) })
        }),
      )
      .handle("session.fs.list", (ctx) =>
        Effect.gen(function* () {
          const provider = yield* SandboxProvider.Service
          const location = yield* Location.Service
          const requested = ctx.query.path ?? "."
          const resolved = sandboxTarget(location.directory, requested)
          if (resolved.error) return yield* Effect.fail(resolved.error)
          if (!(yield* provider.isReady(ctx.params.sessionID))) return yield* Effect.fail(notRunning(requested))
          const entries = yield* provider.fileList(ctx.params.sessionID, resolved.target ?? ".").pipe(
            Effect.mapError((error) => new FileNotFoundError({ path: requested, message: error.message })),
          )
          const prefix = (resolved.target ?? ".").endsWith("/") ? resolved.target : `${resolved.target}/`
          return {
            data: entries.map((entry) => {
              const sandboxEntry = `${prefix}${entry.name}`
              const resource =
                path.relative(location.directory, SandboxPath.toHostPath(sandboxEntry, location.directory)) || "."
              return {
                path: RelativePath.make(resource),
                type: entry.isDirectory ? ("directory" as const) : ("file" as const),
              }
            }),
          }
        }),
      )
      .handle("session.fs.find", (ctx) =>
        Effect.gen(function* () {
          const provider = yield* SandboxProvider.Service
          const location = yield* Location.Service
          if (!(yield* provider.isReady(ctx.params.sessionID))) return yield* Effect.fail(notRunning("."))
          const base = SandboxPath.toSandboxPath(path.resolve(location.directory, "."), location.directory)
          const found = yield* provider.fileFind(ctx.params.sessionID, base, ctx.query.query).pipe(
            Effect.mapError((error) => new FileNotFoundError({ path: ".", message: error.message })),
          )
          const limit = ctx.query.limit ?? 100
          return {
            data: found
              .filter((entry) =>
                ctx.query.type === undefined
                  ? true
                  : ctx.query.type === "directory"
                    ? entry.isDirectory
                    : !entry.isDirectory,
              )
              .slice(0, limit)
              .map((entry) => {
                const resource =
                  path.relative(location.directory, SandboxPath.toHostPath(entry.path, location.directory)) || "."
                return {
                  path: RelativePath.make(resource),
                  type: entry.isDirectory ? ("directory" as const) : ("file" as const),
                }
              }),
          }
        }),
      )
  }),
)
