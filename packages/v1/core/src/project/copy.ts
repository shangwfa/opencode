export * as ProjectCopy from "./copy"

import { and, eq, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { AbsolutePath } from "../schema"
import { FSUtil } from "../fs-util"
import { Git } from "../git"
import { makeLocationNode } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { Project } from "../project"
import { ProjectDirectoryTable } from "./sql"
import { ProjectDirectories } from "./directories"
import { makeStrategies } from "./copy-strategies"
import { Slug } from "../util/slug"
import { EventV2 } from "../event"
import { Database } from "../database/database"
import { Location } from "../location"
import { Event } from "@opencode-ai/schema/project-directories"
import { ProjectCopy } from "@opencode-ai/schema/project-copy"

export const StrategyID = ProjectCopy.StrategyID
export type StrategyID = typeof StrategyID.Type

export const CreateInput = ProjectCopy.CreateInput
export type CreateInput = typeof CreateInput.Type

export const RemoveInput = ProjectCopy.RemoveInput
export type RemoveInput = typeof RemoveInput.Type

export const RefreshInput = Schema.Struct({
  projectID: Project.ID,
}).annotate({ identifier: "ProjectCopy.RefreshInput" })
export type RefreshInput = typeof RefreshInput.Type

export const RefreshResult = Schema.Struct({
  updated: Schema.Array(AbsolutePath),
  removed: Schema.Array(AbsolutePath),
}).annotate({ identifier: "ProjectCopy.RefreshResult" })
export type RefreshResult = typeof RefreshResult.Type

export const Copy = ProjectCopy.Copy
export type Copy = typeof Copy.Type

export const DetectInput = Schema.Struct({
  directory: AbsolutePath,
}).annotate({ identifier: "ProjectCopy.DetectInput" })
export type DetectInput = typeof DetectInput.Type

export type DirectoryType = "main" | "root" | StrategyID

export class SourceDirectoryNotFoundError extends Schema.TaggedErrorClass<SourceDirectoryNotFoundError>()(
  "ProjectCopy.SourceDirectoryNotFoundError",
  { directory: AbsolutePath },
) {}

export class DestinationExistsError extends Schema.TaggedErrorClass<DestinationExistsError>()(
  "ProjectCopy.DestinationExistsError",
  { directory: AbsolutePath },
) {}

export class DirectoryUnavailableError extends Schema.TaggedErrorClass<DirectoryUnavailableError>()(
  "ProjectCopy.DirectoryUnavailableError",
  { directory: AbsolutePath },
) {}

export class StrategyNotFoundError extends Schema.TaggedErrorClass<StrategyNotFoundError>()(
  "ProjectCopy.StrategyNotFoundError",
  { directory: AbsolutePath },
) {}

export class InvalidDirectoryError extends Schema.TaggedErrorClass<InvalidDirectoryError>()(
  "ProjectCopy.InvalidDirectoryError",
  { directory: AbsolutePath },
) {}

export class StrategyUnavailableError extends Schema.TaggedErrorClass<StrategyUnavailableError>()(
  "ProjectCopy.StrategyUnavailableError",
  { strategy: Schema.String },
) {}

export type Error =
  | SourceDirectoryNotFoundError
  | DestinationExistsError
  | DirectoryUnavailableError
  | StrategyNotFoundError
  | InvalidDirectoryError
  | StrategyUnavailableError
  | Git.WorktreeError

export interface Strategy {
  readonly id: StrategyID
  readonly create: (input: {
    sourceDirectory: AbsolutePath
    directory: AbsolutePath
  }) => Effect.Effect<Copy, Git.WorktreeError | DirectoryUnavailableError>
  readonly remove: (input: {
    directory: AbsolutePath
    force: boolean
  }) => Effect.Effect<void, Git.WorktreeError | DirectoryUnavailableError>
  readonly list: (directory: AbsolutePath) => Effect.Effect<Copy[], Git.WorktreeError | DirectoryUnavailableError>
  readonly detect: (directory: AbsolutePath) => Effect.Effect<boolean>
}

export { Event }

export interface Interface {
  readonly detect: (input: DetectInput) => Effect.Effect<StrategyID | undefined>
  readonly create: (input: CreateInput) => Effect.Effect<Copy, Error>
  readonly remove: (input: RemoveInput) => Effect.Effect<void, Error>
  readonly refresh: (input: RefreshInput) => Effect.Effect<RefreshResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectCopy") {}

export const refreshAfterBoot = Effect.gen(function* () {
  const location = yield* Location.Service
  const copies = yield* Service
  yield* Effect.gen(function* () {
    yield* Effect.logInfo("project copy refresh started", { projectID: location.project.id })
    const result = yield* copies.refresh({ projectID: location.project.id })
    yield* Effect.logInfo("project copy refresh done", {
      projectID: location.project.id,
      updated: result.updated,
      removed: result.removed,
    })
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("project copy refresh failed", { cause })),
    Effect.forkScoped,
    Effect.asVoid,
  )
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db

    const canonical = Effect.fnUntraced(function* (input: AbsolutePath) {
      const resolved = AbsolutePath.make(yield* fs.resolve(input))
      if (!(yield* fs.isDir(resolved))) return yield* new DirectoryUnavailableError({ directory: input })
      return resolved
    })

    const registry = makeStrategies({ git, fs, canonical })

    const source = Effect.fnUntraced(function* (input: AbsolutePath, projectID: Project.ID) {
      const sourceDirectory = yield* canonical(input)
      const row = yield* db
        .select({ directory: ProjectDirectoryTable.directory })
        .from(ProjectDirectoryTable)
        .where(
          and(eq(ProjectDirectoryTable.project_id, projectID), eq(ProjectDirectoryTable.directory, sourceDirectory)),
        )
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new SourceDirectoryNotFoundError({ directory: sourceDirectory })
      return sourceDirectory
    })

    const insert = Effect.fnUntraced(function* (projectID: Project.ID, copyDirectory: AbsolutePath, type: StrategyID) {
      return yield* db
        .transaction(
          (tx) =>
            Effect.gen(function* () {
              const row = yield* tx
                .select({ directory: ProjectDirectoryTable.directory })
                .from(ProjectDirectoryTable)
                .where(
                  and(
                    eq(ProjectDirectoryTable.project_id, projectID),
                    eq(ProjectDirectoryTable.directory, copyDirectory),
                  ),
                )
                .get()
              if (row) return false
              yield* tx
                .insert(ProjectDirectoryTable)
                .values({ project_id: projectID, directory: copyDirectory, type: type as "git_worktree" })
                .run()
              return true
            }),
          { behavior: "immediate" },
        )
        .pipe(Effect.orDie)
    })

    const removeStored = Effect.fnUntraced(function* (projectID: Project.ID, copyDirectory: AbsolutePath) {
      return (
        (yield* db
          .delete(ProjectDirectoryTable)
          .where(
            and(eq(ProjectDirectoryTable.project_id, projectID), eq(ProjectDirectoryTable.directory, copyDirectory)),
          )
          .returning({ directory: ProjectDirectoryTable.directory })
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })

    const changed = Effect.fnUntraced(function* (projectID: Project.ID, update: boolean) {
      if (update) yield* events.publish(Event.Updated, { projectID })
    })

    const strategy = (id: StrategyID) => registry.get(id) as Strategy

    const detect = Effect.fn("ProjectCopy.detect")(function* (input: DetectInput) {
      for (const strategy of registry.values()) {
        if (yield* strategy.detect(input.directory)) return strategy.id
      }
      return undefined
    })

    const create = Effect.fn("ProjectCopy.create")(function* (input: CreateInput) {
      yield* fs.makeDirectory(input.directory, { recursive: true }).pipe(Effect.orDie)
      const name = input.name ?? Slug.create()
      let suffix = 1
      let copyDirectory = AbsolutePath.make(path.join(input.directory, name))
      while (yield* fs.existsSafe(copyDirectory)) {
        suffix++
        if (suffix > 10) return yield* new DestinationExistsError({ directory: copyDirectory })
        copyDirectory = AbsolutePath.make(path.join(input.directory, `${name}-${suffix}`))
      }

      const result = yield* strategy(input.strategy).create({
        directory: copyDirectory,
        sourceDirectory: yield* source(input.sourceDirectory, input.projectID),
      })
      yield* changed(input.projectID, yield* insert(input.projectID, result.directory, input.strategy))
      return result
    })

    const remove = Effect.fn("ProjectCopy.remove")(function* (input: RemoveInput) {
      const copyDirectory = yield* canonical(input.directory)
      const id = yield* detect({ directory: copyDirectory })
      if (!id) return yield* new StrategyNotFoundError({ directory: copyDirectory })
      yield* strategy(id).remove({ directory: copyDirectory, force: input.force })
      yield* changed(input.projectID, yield* removeStored(input.projectID, copyDirectory))
    })

    const refresh = Effect.fn("ProjectCopy.refresh")(function* (input: RefreshInput) {
      const roots = yield* db
        .select({ directory: ProjectDirectoryTable.directory })
        .from(ProjectDirectoryTable)
        .where(
          and(
            eq(ProjectDirectoryTable.project_id, input.projectID),
            inArray(ProjectDirectoryTable.type, ["main", "root"]),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      const sourceDirectories = yield* Effect.forEach(roots, (item) => canonical(AbsolutePath.make(item.directory)), {
        concurrency: "unbounded",
      })
      const discovered = yield* Effect.forEach(
        sourceDirectories,
        (sourceDirectory) =>
          Effect.forEach(registry.values(), (strategy) =>
            strategy
              .list(sourceDirectory)
              .pipe(Effect.map((items) => items.map((item) => ({ ...item, type: strategy.id })))),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((sets) => new Map(sets.flat(2).map((item) => [item.directory, item] as const)).values().toArray()),
      )
      const stored = yield* db
        .select({ directory: ProjectDirectoryTable.directory })
        .from(ProjectDirectoryTable)
        .where(eq(ProjectDirectoryTable.project_id, input.projectID))
        .all()
        .pipe(Effect.orDie)
      const updated = yield* Effect.forEach(discovered, (item) =>
        insert(input.projectID, item.directory, item.type).pipe(
          Effect.map((result) => (result ? item.directory : undefined)),
        ),
      ).pipe(Effect.map((items) => items.filter((item): item is AbsolutePath => item !== undefined)))
      const removed = yield* Effect.forEach(stored, (item) => {
        const directory = AbsolutePath.make(item.directory)
        return fs
          .isDir(directory)
          .pipe(
            Effect.flatMap((exists) =>
              exists
                ? Effect.succeed(undefined)
                : removeStored(input.projectID, directory).pipe(
                    Effect.map((result) => (result ? directory : undefined)),
                  ),
            ),
          )
      }).pipe(Effect.map((items) => items.filter((item): item is AbsolutePath => item !== undefined)))
      yield* changed(input.projectID, updated.length > 0 || removed.length > 0)
      return { updated, removed }
    })

    return Service.of({ detect, create, remove, refresh })
  }),
)

export const locationLayer = layer
export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(LayerNode.compile(FSUtil.node)),
  Layer.provide(LayerNode.compile(Git.node)),
  Layer.provide(LayerNode.compile(EventV2.node)),
)
export const node = makeLocationNode({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, ProjectDirectories.node, EventV2.node, Database.node],
})

export const refreshNode = makeLocationNode({
  name: "project-copy-refresh",
  layer: Layer.effectDiscard(refreshAfterBoot),
  deps: [node, Location.node],
})
