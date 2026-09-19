import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Files } from "./files.js"
import type { Driver } from "./driver.js"
import { makeFiles } from "./index.js"
import { makeLocalDriver } from "./local.js"
import { Location } from "../location.js"
import { Workspace } from "../workspace.js"

export interface Interface {
  readonly files: Files
  readonly spawner: ChildProcessSpawner["Service"]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Environment") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const location = yield* Location.Service
    const workspace = yield* Workspace.Service
    // The workspace binding is per operation, not per construction: a missing
    // or destroyed placement surfaces on the calls that need it instead of
    // taking the whole location (and every co-located service) down at boot.
    const driver: Effect.Effect<Driver> = location.workspaceID
      ? workspace.connect(location.workspaceID).pipe(
          // Environment has no error channel; an unknown or destroyed placement is a configuration defect by design.
          Effect.mapError(
            (cause) => new Error(`Failed to bind Environment to workspace ${location.workspaceID}`, { cause }),
          ),
          Effect.orDie,
        )
      : Effect.succeed(makeLocalDriver(spawner))
    const call = <A, E, R>(run: (files: Files) => Effect.Effect<A, E, R>) =>
      Effect.flatMap(driver, (resolved) => run(makeFiles(resolved)))
    const files: Files = {
      read: (path, range) => call((impl) => impl.read(path, range)),
      write: (path, bytes) => call((impl) => impl.write(path, bytes)),
      stat: (path) => call((impl) => impl.stat(path)),
      list: (path) => call((impl) => impl.list(path)),
      remove: (path) => call((impl) => impl.remove(path)),
      move: (from, to) => call((impl) => impl.move(from, to)),
      mkdir: (path) => call((impl) => impl.mkdir(path)),
    }
    const spawnerOf = Effect.map(driver, (resolved) => resolved.spawner)
    return Service.of({
      files,
      spawner: {
        spawn: (command) => Effect.flatMap(spawnerOf, (impl) => impl.spawn(command)),
        exitCode: (command) => Effect.flatMap(spawnerOf, (impl) => impl.exitCode(command)),
        streamString: (command, options) =>
          Stream.unwrap(Effect.map(spawnerOf, (impl) => impl.streamString(command, options))),
        streamLines: (command, options) =>
          Stream.unwrap(Effect.map(spawnerOf, (impl) => impl.streamLines(command, options))),
        lines: (command, options) => Effect.flatMap(spawnerOf, (impl) => impl.lines(command, options)),
        string: (command, options) => Effect.flatMap(spawnerOf, (impl) => impl.string(command, options)),
      },
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [CrossSpawnSpawner.node, Location.node, Workspace.node],
})

export * as EnvironmentService from "./environment.js"
