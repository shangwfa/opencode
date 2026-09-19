export * as SandboxFiles from "./sandbox-files.js"

import { Effect, Scope, Stream } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChildProcess } from "effect/unstable/process"
import path from "node:path"
import { Session } from "@opencode/core/session"
import { Workspace } from "@opencode/core/workspace"

import { insert as insertExecLog } from "@opencode/core/exec-log/index"
import { Database } from "@opencode/core/database/database"
import { makeFiles } from "@opencode/core/environment/index"
import { FSUtil } from "@opencode/util/fs-util"

/**
 * Session-scoped file management endpoints (v1 sandbox-proxy parity):
 * mkdir / create / download / upload / remove under
 * `/api/session/:id/files/...`. Every operation routes through the session's
 * sandbox environment (Environment.files), so paths are sandbox paths end to
 * end. Each mutation is audited into exec_log with a `file-*` source, matching
 * the v1 fleet. Mounted as a transform: these paths have no HttpApi schema, so
 * they are served from the RouteNotFound fallback.
 */
export interface SandboxFilesServices {
  readonly sessions: Session.Interface
  readonly workspace: Workspace.Interface
  readonly database: Database.Interface
}

export const handler = (services: SandboxFilesServices) => {
  const { sessions, workspace, database } = services
  const lifetime = Scope.makeUnsafe()
  const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status })
  const fail = (status: number, error: string) => json({ error }, status)

  const filesFor = Effect.fn("server.sandbox-files.for")(function* (sessionID: string) {
    const info = yield* sessions.get(Session.ID.make(sessionID))
    const workspaceID = info.location.workspaceID
    if (workspaceID === undefined) return yield* Effect.fail({ status: 404, body: { error: "session not found" } })
    const connection = yield* workspace.connect(workspaceID).pipe(
      Effect.mapError((error) => ({ status: 502, body: { error: String(error) } })),
    )
    return { files: makeFiles(connection), connection, directory: info.location.directory }
  })

  const audit = (sessionID: string, source: string, payload: unknown) =>
    insertExecLog({
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      session_id: Session.ID.make(sessionID),
      command: JSON.stringify(payload),
      status: "completed",
      source: source as "file-mkdir",
      time_started: Date.now(),
      time_created: Date.now(),
      time_updated: Date.now(),
    }).pipe(
      Effect.provideService(Database.Service, database),
      Effect.catchCause((cause) => Effect.logWarning("sandbox files audit failed", cause)),
    )

  const raw = (bytes: Uint8Array, contentType: string, name: string) =>
    HttpServerResponse.raw(bytes, {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(name)}`,
      },
      contentType,
    })

  const route = Effect.fn("server.sandbox-files.route")(function* (
    sessionID: string,
    action: string,
    query: URLSearchParams,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const context = yield* filesFor(sessionID)
    const files = context.files
    const filesForConnection = context.connection
    const input = query.get("path") ?? undefined
    const absolute = input === undefined || input === "" ? undefined : path.resolve(context.directory, input)

    switch (action) {
      case "mkdir": {
        if (absolute === undefined) return fail(400, "path is required")
        yield* files.mkdir(absolute).pipe(Effect.mapError((error) => ({ status: 502, body: { error: String(error) } })))
        yield* audit(sessionID, "file-mkdir", { path: absolute })
        return json({ sessionID, path: absolute, created: true })
      }
      case "create": {
        if (absolute === undefined) return fail(400, "path is required")
        const bytes = new Uint8Array(yield* request.arrayBuffer)
        yield* files
          .write(absolute, bytes)
          .pipe(Effect.mapError((error) => ({ status: 502, body: { error: String(error) } })))
        yield* audit(sessionID, "file-create", { path: absolute, size: bytes.byteLength })
        return json({ sessionID, path: absolute, size: bytes.byteLength, created: true })
      }
      case "upload": {
        const filename = query.get("filename") ?? ""
        if (filename === "" || filename.includes("/") || filename.includes("\\") || filename.includes("\0"))
          return fail(400, "invalid filename")
        if (filename === "." || filename === "..") return fail(400, "invalid filename")
        const bytes = new Uint8Array(yield* request.arrayBuffer)
        const directory = absolute ?? context.directory
        const target = path.join(directory, filename)
        yield* files.mkdir(path.dirname(target)).pipe(Effect.mapError((e) => ({ status: 502, body: { error: String(e) } })))
        yield* files.write(target, bytes).pipe(Effect.mapError((e) => ({ status: 502, body: { error: String(e) } })))
        yield* audit(sessionID, "file-upload", { path: target, size: bytes.byteLength })
        return json({ sessionID, path: target, size: bytes.byteLength, created: true })
      }
      case "download": {
        if (absolute === undefined) return fail(400, "path is required")
        const stat = yield* files.stat(absolute).pipe(Effect.orElseSucceed(() => undefined))
        if (stat === undefined) return fail(404, "file not found")
        if (stat.type === "directory") {
          // Archive with the sandbox's own python3 zipfile (no host zip
          // dependency), stash, stream back, then clean up.
          const script = `/tmp/oc-dl-${Date.now()}.py`
          const archive = `/tmp/oc-dl-${Date.now()}.zip`
          yield* files
            .write(
              script,
              new TextEncoder().encode(
                [
                  `import zipfile, os`,
                  `with zipfile.ZipFile(${JSON.stringify(archive)}, "w") as z:`,
                  `    for root, dirs, names in os.walk(${JSON.stringify(absolute)}):`,
                  `        dirs.sort(); names.sort()`,
                  `        z.write(root)`,
                  `        for name in names:`,
                  `            z.write(os.path.join(root, name))`,
                ].join("\n"),
              ),
            )
            .pipe(Effect.mapError((e) => ({ status: 502, body: { error: String(e) } })))
          yield* filesForConnection.spawner
            .spawn(ChildProcess.make("python3", [script]))
            .pipe(
              Effect.flatMap((shell) =>
                Effect.all([Stream.runCollect(shell.stdout), shell.exitCode]).pipe(Effect.orDie),
              ),
              Effect.provideService(Scope.Scope, lifetime),
              Effect.catchCause(() => Effect.void),
            )
          const packed = yield* files.read(archive).pipe(Effect.orElseSucceed(() => undefined))
          yield* files.remove(script).pipe(Effect.orDie)
          yield* files.remove(archive).pipe(Effect.orDie)
          if (packed === undefined) return fail(502, "failed to archive directory")
          return raw(packed.bytes, "application/zip", `${path.basename(absolute)}.zip`)
        }
        const bytes = yield* files.read(absolute).pipe(Effect.orElseSucceed(() => undefined))
        if (bytes === undefined) return fail(404, "file not found")
        return raw(bytes.bytes, FSUtil.mimeType(absolute), path.basename(absolute))
      }
      case "remove": {
        if (absolute === undefined) return fail(400, "path is required")
        const stat = yield* files.stat(absolute).pipe(Effect.orElseSucceed(() => undefined))
        if (stat === undefined) return fail(404, "file not found")
        yield* files.remove(absolute).pipe(Effect.mapError((e) => ({ status: 502, body: { error: String(e) } })))
        const type = stat.type === "directory" ? "directory" : "file"
        yield* audit(sessionID, "file-remove", { path: absolute, type })
        return json({ sessionID, path: absolute, removed: true, type })
      }
    }
    return fail(400, "unsupported action")
  })

  type App = Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    HttpServerRequest.HttpServerRequest | Scope.Scope
  >

  const pipeline = (api: App) =>
    api.pipe(
      Effect.catchIf(isRouteNotFound, () =>
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.flatMap((request) => {
            const url = new URL(request.url, "http://localhost")
            const parsed =
              /^\/api\/session\/(ses_[A-Za-z0-9]+)\/files\/(mkdir|create|download|upload|remove)$/.exec(
                url.pathname,
              )
            if (parsed === null) return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
            return route(parsed[1], parsed[2], url.searchParams, request).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("sandbox files handler failed", cause).pipe(
                  Effect.andThen(Effect.succeed(json({ error: "sandbox files operation failed" }, 502))),
                ),
              ),
            )
          }),
        ),
      ),
    )

  return (api: App) => pipeline(api)
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}
