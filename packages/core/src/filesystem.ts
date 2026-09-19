export * as FileSystem from "./filesystem.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode/util/fs-util"
import { Location } from "./location.js"
import { EnvironmentService } from "./environment/environment.js"
import { PositiveInt, RelativePath } from "./schema.js"
import { FileSystemSearch } from "./filesystem/search.js"
import { Entry, FileSystem, FindInput } from "@opencode/schema/filesystem"
export { Entry, Match, Submatch } from "@opencode/schema/filesystem"

export const ReadInput = Schema.Struct({
  path: RelativePath,
})
export type ReadInput = typeof ReadInput.Type

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("FileSystem.NotFoundError", {
  path: RelativePath,
}) {}

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

export const ListInput = Schema.Struct({
  path: Schema.String.pipe(Schema.optional),
})
export type ListInput = typeof ListInput.Type

export { FindInput }

export const DEFAULT_SEARCH_LIMIT = 100
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  hidden: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  include: Schema.optionalKey(Schema.String),
  literal: Schema.optionalKey(Schema.Boolean),
  caseSensitive: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export const Event = FileSystem.Event

export interface Interface {
  readonly read: (
    input: ReadInput,
  ) => Effect.Effect<{ readonly content: Uint8Array; readonly mime: string }, NotFoundError>
  readonly list: (input?: ListInput) => Effect.Effect<Entry[]>
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const search = yield* FileSystemSearch.Service
    // Workspace-placed locations execute in the sandbox: route file operations
    // through the Location environment (Environment.files) instead of the host
    // node fs (upstream #44568). Local placements keep the host fs.
    const environment = yield* EnvironmentService.Service
    const files = environment.files

    const listFromEnvironment = (directory: string) =>
      files.list(directory).pipe(
        Effect.map((entries) =>
          entries.flatMap((entry) =>
            entry.type === "file" || entry.type === "directory" ? [{ name: entry.name, type: entry.type }] : [],
          ),
        ),
      )
    // Workspace-placed directories exist only inside the workspace, so a host
    // realpath probe at boot consults the wrong filesystem and would block
    // construction on servers without a matching local directory. Treat the
    // configured directory as canonical; local placements keep symlink
    // canonicalization. This skip is boot-only: resolve/read/list below still
    // access the host filesystem per operation (tracked in #44568).
    const root = location.workspaceID ? location.directory : yield* fs.realPath(location.directory).pipe(Effect.orDie)
    const resolve = Effect.fnUntraced(function* (input?: RelativePath) {
      const absolute = path.resolve(location.directory, input ?? ".")
      if (!FSUtil.contains(location.directory, absolute))
        return yield* Effect.die(new Error("Path escapes the location"))
      // Sandbox filesystems have no host realpath; the absolute path is canonical.
      if (location.workspaceID) return { absolute, real: absolute, directory: location.directory }
      const real = yield* fs.realPath(absolute)
      if (!FSUtil.contains(root, real)) return yield* Effect.die(new Error("Path escapes the location"))
      return { absolute, real, directory: location.directory }
    })
    return Service.of({
      find: search.find,
      read: Effect.fn("FileSystem.read")(function* (input) {
        if (location.workspaceID) {
          // Sandbox placement: Environment.files routes to the workspace.
          const absolute = path.resolve(location.directory, input.path ?? ".")
          const result = yield* files.read(absolute).pipe(
            Effect.mapError((error) =>
              error._tag === "Environment.NotFound"
                ? new NotFoundError({ path: input.path })
                : new NotFoundError({ path: input.path }),

            ),
          )
          if (result.info.type !== "file") return yield* Effect.die(new Error("Path is not a file"))
          return { content: result.bytes, mime: FSUtil.mimeType(absolute) }
        }
        const target = yield* resolve(input.path).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(new NotFoundError({ path: input.path })),
            (_, error) => Effect.die(error),
          ),
        )
        const info = yield* fs.stat(target.real).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(new NotFoundError({ path: input.path })),
            (_, error) => Effect.die(error),
          ),
        )
        if (info.type !== "File") return yield* Effect.die(new Error("Path is not a file"))
        const content = yield* fs.readFile(target.real).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.fail(new NotFoundError({ path: input.path })),
            (_, error) => Effect.die(error),
          ),
        )
        return {
          content: new Uint8Array(content),
          mime: FSUtil.mimeType(target.real),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        // Navigation can leave the cwd without activating another Location.
        const directory = path.resolve(location.directory, input.path ?? ".")
        if (location.workspaceID) {
          return yield* listFromEnvironment(directory).pipe(
            Effect.map((items) => entryList(items, location.directory, directory)),
            Effect.mapError((error) => new Error(`Sandbox list failed: ${String(error)}`)),
            Effect.orDie,
          )
        }
        const info = yield* fs.stat(directory).pipe(Effect.orDie)
        if (info.type !== "Directory") return yield* Effect.die(new Error("Path is not a directory"))
        return yield* fs.readDirectoryEntries(directory).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                if (item.type !== "file" && item.type !== "directory") return []
                const absolute = path.join(directory, item.name)
                const relative = path.relative(location.directory, absolute) || "."
                return [
                  Entry.make({
                    path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                    type: item.type,
                  }),
                ]
              })
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node, EnvironmentService.node],
})
/** Shared entry shaping for both host and environment listings. */
function entryList(
  items: ReadonlyArray<{ name: string; type: "file" | "directory" }>,
  rootDirectory: string,
  directory: string,
): Array<ReturnType<typeof Entry.make>> {
  return items
    .flatMap((item) => {
      const absolute = path.join(directory, item.name)
      const relative = path.relative(rootDirectory, absolute) || "."
      return [
        Entry.make({
          path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
          type: item.type,
        }),
      ]
    })
    .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))
}
