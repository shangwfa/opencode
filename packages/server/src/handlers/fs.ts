import path from "path"
import { FileSystem } from "@opencode/core/filesystem"
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
import { response } from "../location"

// `/api/fs/*` reads the host filesystem by default. Passing `session` reroutes
// the same operations onto that session's sandbox workspace, which is the only
// filesystem that exists for remote executions.
const sandboxTarget = (location: Location.Interface, input?: string) => {
  const absolute = path.resolve(location.directory, input ?? ".")
  return {
    sandboxPath: SandboxPath.toSandboxPath(absolute, location.directory),
    resource: (value: string) =>
      RelativePath.make(path.relative(location.directory, SandboxPath.toHostPath(value, location.directory)) || "."),
  }
}

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const requested = RelativePath.make(
            decodeURIComponent(new URL(ctx.request.url, "http://localhost").pathname.slice(13)),
          )
          if (ctx.query.session !== undefined) {
            const provider = yield* SandboxProvider.Service
            const location = yield* Location.Service
            const target = sandboxTarget(location, requested)
            const content = yield* provider
              .fileReadBytes(ctx.query.session, target.sandboxPath)
              .pipe(
                Effect.mapError(
                  (error) => new FileNotFoundError({ path: requested, message: error.message }),
                ),
              )
            if (content === null)
              return yield* Effect.fail(
                new FileNotFoundError({ path: requested, message: `File not found: ${requested}` }),
              )
            return HttpServerResponse.uint8Array(content, { contentType: Mime.detect(content) })
          }
          const fs = yield* FileSystem.Service
          const file = yield* fs.read({ path: requested }).pipe(
            Effect.mapError(
              (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
            ),
          )
          return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            if (ctx.query.session !== undefined) {
              const provider = yield* SandboxProvider.Service
              const location = yield* Location.Service
              const target = sandboxTarget(location, ctx.query.path)
              const entries = yield* provider
                .fileList(ctx.query.session, target.sandboxPath)
                .pipe(
                  Effect.mapError(
                    (error) => new FileNotFoundError({ path: ctx.query.path ?? ".", message: error.message }),
                  ),
                )
              const base = target.sandboxPath.endsWith("/") ? target.sandboxPath : `${target.sandboxPath}/`
              return entries.map((entry) => ({
                path: target.resource(`${base}${entry.name}`),
                type: entry.isDirectory ? ("directory" as const) : ("file" as const),
              }))
            }
            const fs = yield* FileSystem.Service
            return yield* fs.list(ctx.query)
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            if (ctx.query.session !== undefined) {
              const provider = yield* SandboxProvider.Service
              const location = yield* Location.Service
              const target = sandboxTarget(location)
              const limit = ctx.query.limit ?? 100
              const found = yield* provider
                .fileFind(ctx.query.session, target.sandboxPath, ctx.query.query)
                .pipe(
                  Effect.mapError(
                    (error) => new FileNotFoundError({ path: ".", message: error.message }),
                  ),
                )
              return found
                .filter((entry) =>
                  ctx.query.type === undefined
                    ? true
                    : ctx.query.type === "directory"
                      ? entry.isDirectory
                      : !entry.isDirectory,
                )
                .slice(0, limit)
                .map((entry) => ({
                  path: target.resource(entry.path),
                  type: entry.isDirectory ? ("directory" as const) : ("file" as const),
                }))
            }
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
  }),
)
