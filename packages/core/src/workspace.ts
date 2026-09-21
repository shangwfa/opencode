export * as Workspace from "./workspace.js"

import { Workspace } from "@opencode/schema/workspace"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { eq } from "drizzle-orm"
import { ChildProcess } from "effect/unstable/process"
import { Clock, Context, Deferred, Duration, Effect, Exit, FiberSet, Layer, Option, Ref, Schedule, Schema, Scope, Stream } from "effect"
import { systemError } from "effect/PlatformError"
import { make } from "effect/unstable/process/ChildProcessSpawner"
import { execDefaults } from "./environment/exec-defaults.js"
import type { Files } from "./environment/files.js"
import type { EnvironmentDriver } from "./environment/driver.js"
import { Database } from "./database/database.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { WorkspaceDriver } from "./workspace/driver.js"
import { WorkspaceTable } from "./workspace/sql.js"
import { recordSandboxEvent } from "./observability/metrics.js"

export const ID = Workspace.ID
export type ID = Workspace.ID

export class Info extends Schema.Class<Info>("Workspace.Info")({
  id: ID,
  provider: Schema.String,
  binding: WorkspaceDriver.Binding,
  createdAt: Schema.Number,
  lastUsedAt: Schema.Number,
}) {}

export class NotFound extends Schema.TaggedError<NotFound>()("Workspace.NotFound", { workspaceID: ID }) {}

export class CreateConflict extends Schema.TaggedError<CreateConflict>()("Workspace.CreateConflict", {
  workspaceID: ID,
  provider: Schema.String,
  existingProvider: Schema.String,
}) {}

export interface Interface {
  /** Instantly commits a logical workspace ID. No provider work happens here. */
  readonly create: (input: {
    readonly id?: ID
    readonly provider: string
    readonly resource?: Record<string, string>
  }) => Effect.Effect<ID, CreateConflict | WorkspaceDriver.ProviderNotFound>
  /** Starts or joins the shared attempt that makes the backing resource real, then returns it. */
  readonly provision: (
    workspaceID: ID,
  ) => Effect.Effect<Info, NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
  readonly connect: (
    workspaceID: ID,
  ) => Effect.Effect<EnvironmentDriver.Driver, NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
  /** Makes the workspace absent; reports whether this call destroyed an existing workspace. */
  readonly destroy: (
    workspaceID: ID,
  ) => Effect.Effect<Workspace.DestroyResult, WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound>
  /** Marks the sandbox exempt from idle suspension (v1 keep-alive parity). */
  readonly setKeepAlive: (workspaceID: ID, enabled: boolean) => Effect.Effect<void>
  readonly isKeepAlive: (workspaceID: ID) => boolean
  /**
   * Snapshot-then-stop one workspace's sandbox (v1 kill-sandbox parity for
   * persistent sessions): the snapshot must reach Ready before the sandbox is
   * killed, and the binding row survives so the next use restores from it.
   * Runs in the background; a failed snapshot keeps the sandbox alive.
   */
  readonly suspend: (workspaceID: ID) => Effect.Effect<void, NotFound>
  /** Drops a cached sandbox connection; the next use reconnects (reviving from snapshot when the sandbox died). */
  readonly invalidate: (workspaceID: ID) => Effect.Effect<void>
  /**
   * Observational one-shot command against the cached sandbox connection
   * (v1 OOM sampling parity): never refreshes lastActivity or the active
   * counter, so sampling cannot keep an idle workspace alive. Undefined when
   * no cached connection exists (the workspace is not in use here).
   */
  /** Reads the persisted binding without connecting; null when unbound. */
  readonly rawBinding: (workspaceID: ID) => Effect.Effect<WorkspaceDriver.Binding | null, NotFound>
  /** Reads the session-level sandbox resource spec for this workspace. */
  readonly resource: (workspaceID: ID) => Effect.Effect<Record<string, string> | null, NotFound>
  /** Explicitly snapshots the workspace's sandbox without killing it (v1 POST /snapshot parity). */
  readonly snapshot: (workspaceID: ID) => Effect.Effect<{ readonly snapshotId: string }, NotFound | WorkspaceDriver.Error>
  /** Updates the sandbox resource spec; takes effect at the next sandbox create. */
  readonly setResource: (workspaceID: ID, resource: Record<string, string>) => Effect.Effect<void, NotFound>
  readonly sample: (
    workspaceID: ID,
    command: string,
    timeoutMs: number,
  ) => Effect.Effect<{ readonly stdout: string } | undefined>
  /**
   * Writes a file into the workspace's sandbox (compaction history):
   * provisions the sandbox when no cached connection exists and creates
   * parent directories. Never refreshes the activity counters beyond the
   * provision itself.
   */
  readonly writeFile: (workspaceID: ID, path: string, bytes: Uint8Array) => Effect.Effect<void>
}

export interface Options {
  readonly idleThreshold?: Duration.Input
  readonly pollInterval?: Duration.Input
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workspace") {}

interface Connection {
  readonly driver: WorkspaceDriver.Interface
  readonly environment: EnvironmentDriver.Driver
  readonly saveBinding: (binding: WorkspaceDriver.Binding) => Effect.Effect<void>
  readonly lastActivity: Ref.Ref<number>
  readonly active: Ref.Ref<number>
  readonly scope: Scope.Closeable
}

type ReadinessError = NotFound | WorkspaceDriver.Error | WorkspaceDriver.ProviderNotFound

export const configured = (options: Options = {}) =>
  makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [Database.node, WorkspaceDriver.node],
  })

const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const registry = yield* WorkspaceDriver.RegistryService
      const lifetime = yield* Scope.Scope
      const connections = new Map<ID, Connection>()
      const keptAlive = new Set<ID>()
      // Inlined makeFiles (execDefaults + overrides): importing
      // ./environment/index.js here would cycle (environment -> workspace).
      const makeFiles = (driver: EnvironmentDriver.Driver) =>
        ({ ...execDefaults(driver.spawner), ...driver.overrides }) as Files
      // Destroy cancels the racing provision body by settling the deferred.
      const attempts = new Map<ID, Deferred.Deferred<Info, ReadinessError>>()
      const locks = KeyedMutex.makeUnsafe<ID>()
      const fork = yield* FiberSet.makeRuntime<never, void, never>()
      const idleThreshold = Duration.toMillis(options.idleThreshold ?? Duration.minutes(20))

      const find = (workspaceID: ID) =>
        db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).get().pipe(Effect.orDie)

      const load = Effect.fn("Workspace.load")(function* (workspaceID: ID) {
        const row = yield* find(workspaceID)
        if (!row) return yield* new NotFound({ workspaceID })
        return row
      })

      const resource = (workspaceID: ID) =>
        Effect.map(load(workspaceID), (row) => row.resource ?? null)

      const saveBinding = (workspaceID: ID, binding: WorkspaceDriver.Binding) =>
        db.update(WorkspaceTable).set({ binding }).where(eq(WorkspaceTable.id, workspaceID)).run().pipe(Effect.orDie)

      const info = (row: typeof WorkspaceTable.$inferSelect, binding: WorkspaceDriver.Binding) =>
        new Info({
          id: row.id,
          provider: row.provider,
          binding,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        })

      const provision = Effect.fn("Workspace.provision")((workspaceID: ID) =>
        Effect.suspend(() => {
          const existing = attempts.get(workspaceID)
          if (existing) return Deferred.await(existing)

          const attempt = Deferred.makeUnsafe<Info, ReadinessError>()
          attempts.set(workspaceID, attempt)
          fork(
            locks
              .withLock(workspaceID)(
                Effect.gen(function* () {
                  const row = yield* load(workspaceID)
                  if (row.binding) return info(row, row.binding)
                  const driver = yield* registry.get(row.provider)
                  const result = yield* driver.create({ workspaceID, resource: row.resource ?? undefined })
                  yield* recordSandboxEvent("create")
                  yield* saveBinding(workspaceID, result.binding)
                  return info(row, result.binding)
                }),
              )
              .pipe(
                Effect.raceFirst(Deferred.await(attempt)),
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    if (attempts.get(workspaceID) === attempt) attempts.delete(workspaceID)
                    Deferred.doneUnsafe(attempt, exit)
                  }),
                ),
                Effect.exit,
                Effect.asVoid,
              ),
          )
          return Deferred.await(attempt)
        }),
      )

      const open = Effect.fn("Workspace.open")(function* (workspaceID: ID) {
        const existing = connections.get(workspaceID)
        if (existing) return existing

        const row = yield* load(workspaceID)
        // Bindings are persisted before provision resolves and never nulled; a raced
        // destroy deletes the whole row and surfaces as NotFound from load above.
        if (!row.binding) return yield* Effect.die(`workspace ${workspaceID} has no binding after provision`)
        const driver = yield* registry.get(row.provider)
        const persistBinding = (binding: WorkspaceDriver.Binding) => saveBinding(workspaceID, binding)
        const scope = yield* Scope.fork(lifetime)
        const environment = yield* driver
          .connect({ workspaceID, binding: row.binding, saveBinding: persistBinding })
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
          )
        yield* recordSandboxEvent("restore")
        const now = yield* Clock.currentTimeMillis
        const connection: Connection = {
          driver,
          environment,
          saveBinding: persistBinding,
          lastActivity: yield* Ref.make(now),
          active: yield* Ref.make(0),
          scope,
        }
        connections.set(workspaceID, connection)
        yield* db
          .update(WorkspaceTable)
          .set({ last_used_at: now })
          .where(eq(WorkspaceTable.id, workspaceID))
          .run()
          .pipe(Effect.orDie)
        return connection
      })

      yield* Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* Effect.forEach(
          [...connections.entries()].filter(([id]) => !keptAlive.has(id)),
          ([workspaceID, expected]) =>
            locks.withLock(workspaceID)(
              Effect.gen(function* () {
                const connection = connections.get(workspaceID)
                if (connection !== expected || (yield* Ref.get(connection.active)) > 0) return
                const lastActivity = yield* Ref.get(connection.lastActivity)
                if (now - lastActivity < idleThreshold) return
                const row = yield* load(workspaceID)
                if (!row.binding) return
                // Deliberate: a racing spawn blocks, then wakes cleanly. Unlocking mid-suspend could reattach a sandbox being terminated.
                yield* connection.driver.suspendForIdle({
                  workspaceID,
                  binding: row.binding,
                  saveBinding: connection.saveBinding,
                })
                yield* db
                  .update(WorkspaceTable)
                  .set({ last_used_at: lastActivity })
                  .where(eq(WorkspaceTable.id, workspaceID))
                  .run()
                  .pipe(Effect.orDie)
                connections.delete(workspaceID)
                yield* Scope.close(connection.scope, Exit.void)
              }).pipe(Effect.catchCause((cause) => Effect.logError("workspace idle suspension failed", cause))),
            ),
          { concurrency: "unbounded", discard: true },
        )
      }).pipe(Effect.repeat(Schedule.spaced(options.pollInterval ?? Duration.minutes(1))), Effect.forkScoped)

      return Service.of({
        setKeepAlive: (workspaceID, enabled) =>
          Effect.sync(() => {
            if (enabled) keptAlive.add(workspaceID)
            else keptAlive.delete(workspaceID)
          }),
        isKeepAlive: (workspaceID) => keptAlive.has(workspaceID),

        sample: Effect.fn("Workspace.sample")(function* (workspaceID, command, timeoutMs) {
          const connection = connections.get(workspaceID)
          if (connection === undefined) return undefined
          const settled = yield* Effect.gen(function* () {
            const shell = yield* connection.environment.spawner
              .spawn(ChildProcess.make("sh", ["-c", command]))
              .pipe(
                Effect.provideService(Scope.Scope, connection.scope),
                Effect.orDie,
              )
            const out = yield* Stream.runCollect(Stream.decodeText(shell.stdout)).pipe(
              Effect.map((chunks) => Array.from(chunks).join("")),
              Effect.orDie,
            )
            yield* shell.exitCode.pipe(Effect.orDie)
            return out
          }).pipe(Effect.timeoutOption(`${timeoutMs} millis`))
          if (Option.isNone(settled)) return undefined
          return { stdout: settled.value }
        }),
        writeFile: Effect.fn("Workspace.writeFile")(function* (workspaceID, path, bytes) {
          // History writes may be the first workspace use of a chat-only session,
          // so provision instead of degrading to "no cached connection". provision
          // takes the workspace lock itself, so it must run OUTSIDE withLock.
          yield* Effect.suspend(() => (connections.has(workspaceID) ? Effect.void : provision(workspaceID))).pipe(
            Effect.orDie,
          )
          const connection = yield* locks.withLock(workspaceID)(open(workspaceID)).pipe(Effect.orDie)
          // execDefaults.write runs `mkdir -p $(dirname)` before writing.
          yield* makeFiles(connection.environment).write(path, bytes).pipe(Effect.orDie)
        }),
        rawBinding: (workspaceID) => Effect.map(load(workspaceID), (row) => row.binding),
        resource,
        snapshot: Effect.fn("Workspace.snapshot")(function* (workspaceID) {
          const row = yield* load(workspaceID)
          if (row.binding === null) return yield* new NotFound({ workspaceID })
          const driver = yield* registry.get(row.provider).pipe(Effect.orDie)
          if (driver.snapshot === undefined)
            return yield* new WorkspaceDriver.Error({ message: `provider ${row.provider} does not support snapshots` })
          return yield* driver.snapshot({
            workspaceID,
            binding: row.binding,
            saveBinding: (binding) => saveBinding(workspaceID, binding).pipe(Effect.orDie),
          })
        }),
        setResource: (workspaceID, resource) =>
          Effect.gen(function* () {
            yield* load(workspaceID)
            yield* db
              .update(WorkspaceTable)
              .set({ resource, last_used_at: yield* Clock.currentTimeMillis })
              .where(eq(WorkspaceTable.id, workspaceID))
              .run()
              .pipe(Effect.orDie)
          }),
        invalidate: Effect.fn("Workspace.invalidate")(function* (workspaceID) {
          const connection = connections.get(workspaceID)
          if (connection === undefined) return
          connections.delete(workspaceID)
          yield* Scope.close(connection.scope, Exit.void).pipe(Effect.orDie)
        }),
        suspend: Effect.fn("Workspace.suspend")(function* (workspaceID) {
          const row = yield* load(workspaceID)
          if (row.binding === null) return yield* new NotFound({ workspaceID })
          const driver = yield* registry.get(row.provider).pipe(Effect.orDie)
          yield* driver
            .suspendForIdle({
              workspaceID,
              binding: row.binding,
              saveBinding: (binding) => saveBinding(workspaceID, binding).pipe(Effect.orDie),
            })
            .pipe(
              // The per-connection idle sweep owns live connections; a manual
              // suspend drops any cached connection the same way.
              Effect.tap(() =>
                Effect.sync(() => {
                  connections.delete(workspaceID)
                }),
              ),
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.logError(`workspace suspend failed for ${workspaceID}`, exit.cause),
              ),
              Effect.forkIn(lifetime),
            )
        }),
        create: Effect.fn("Workspace.create")(function* (input) {
          const workspaceID = input.id ?? ID.create()
          const existing = yield* db
            .select({ provider: WorkspaceTable.provider })
            .from(WorkspaceTable)
            .where(eq(WorkspaceTable.id, workspaceID))
            .get()
            .pipe(Effect.orDie)
          if (existing) {
            if (existing.provider === input.provider) return workspaceID
            return yield* new CreateConflict({
              workspaceID,
              provider: input.provider,
              existingProvider: existing.provider,
            })
          }
          yield* registry.get(input.provider)
          const now = yield* Clock.currentTimeMillis
          const inserted = yield* db
            .insert(WorkspaceTable)
            .values({
              id: workspaceID,
              provider: input.provider,
              binding: null,
              resource: input.resource ?? null,
              created_at: now,
              last_used_at: now,
            })
            .onConflictDoNothing()
            .returning({ id: WorkspaceTable.id })
            .get()
            .pipe(Effect.orDie)
          if (inserted) return workspaceID
          const row = yield* load(workspaceID).pipe(Effect.orDie)
          if (row.provider !== input.provider)
            return yield* new CreateConflict({
              workspaceID,
              provider: input.provider,
              existingProvider: row.provider,
            })
          return workspaceID
        }),
        provision,
        connect: Effect.fn("Workspace.connect")(function* (workspaceID) {
          // Per-operation acquire: nothing provisions or connects until a
          // spawn or file call actually needs the workspace, so a connect on a
          // cold workspace stays free (and a missing placement cannot fail it).
          const acquire = Effect.acquireRelease(
            Effect.suspend(() => (connections.has(workspaceID) ? Effect.void : provision(workspaceID))).pipe(
              Effect.andThen(
                locks.withLock(workspaceID)(
                  Effect.gen(function* () {
                    const connection = yield* open(workspaceID)
                    yield* Ref.update(connection.active, (active) => active + 1)
                    return connection
                  }),
                ),
              ),
              Effect.mapError((cause) =>
                systemError({
                  _tag: "Unknown",
                  module: "Workspace",
                  method: "connect",
                  description: `Failed to wake workspace ${workspaceID}`,
                  cause,
                }),
              ),
            ),
            (connection) =>
              locks.withLock(workspaceID)(
                Effect.gen(function* () {
                  yield* Ref.update(connection.active, (active) => active - 1)
                  yield* Ref.set(connection.lastActivity, yield* Clock.currentTimeMillis)
                }),
              ),
          )

          const spawner = make((command) =>
            Effect.acquireRelease(
              // A live connection implies the binding is already persisted, so skip the provision hop.
              Effect.suspend(() => (connections.has(workspaceID) ? Effect.void : provision(workspaceID))).pipe(
                Effect.andThen(
                  locks.withLock(workspaceID)(
                    Effect.gen(function* () {
                      const connection = yield* open(workspaceID)
                      yield* Ref.set(connection.lastActivity, yield* Clock.currentTimeMillis)
                      yield* Ref.update(connection.active, (active) => active + 1)
                      return connection
                    }),
                  ),
                ),
                Effect.mapError((cause) =>
                  systemError({
                    _tag: "Unknown",
                    module: "Workspace",
                    method: "spawn",
                    description: `Failed to wake workspace ${workspaceID}`,
                    cause,
                  }),
                ),
              ),
              (connection) =>
                locks.withLock(workspaceID)(
                  Effect.gen(function* () {
                    yield* Ref.update(connection.active, (active) => active - 1)
                    yield* Ref.set(connection.lastActivity, yield* Clock.currentTimeMillis)
                  }),
                ),
            ).pipe(Effect.flatMap((connection) => connection.environment.spawner.spawn(command))),
          )

          // A wake failure is a placement defect, not a file-operation error.
          const connect = Effect.orDie(acquire)
          const overrides: EnvironmentDriver.Driver["overrides"] = {
            read: (path, range) =>
              Effect.scoped(Effect.flatMap(connect, (connection) => makeFiles(connection.environment).read(path, range))),
            write: (path, bytes, mode) =>
              Effect.scoped(
                Effect.flatMap(connect, (connection) =>
                  makeFiles(connection.environment).write(path, bytes, mode),
                ),
              ),
            stat: (path) =>
              Effect.scoped(Effect.flatMap(connect, (connection) => makeFiles(connection.environment).stat(path))),
            list: (path) =>
              Effect.scoped(Effect.flatMap(connect, (connection) => makeFiles(connection.environment).list(path))),
            remove: (path) =>
              Effect.scoped(Effect.flatMap(connect, (connection) => makeFiles(connection.environment).remove(path))),
            move: (from, to) =>
              Effect.scoped(Effect.flatMap(connect, (connection) => makeFiles(connection.environment).move(from, to))),
            mkdir: (path, mode) =>
              Effect.scoped(Effect.flatMap(connect, (connection) => makeFiles(connection.environment).mkdir(path, mode))),
          }
          // Endpoint lookups are provider-owned and absent for local drivers.
          const endpoint: EnvironmentDriver.Driver["endpoint"] = (port) =>
            Effect.scoped(
              Effect.flatMap(connect, (connection) =>
                connection.environment.endpoint === undefined
                  ? Effect.fail(new Error("workspace driver has no endpoint provider"))
                  : connection.environment.endpoint(port),
              ),
            )
          return { spawner, overrides, endpoint }
        }),
        destroy: Effect.fn("Workspace.destroy")(function* (workspaceID) {
          // Settling the shared attempt cancels its racing provision body and fails
          // waiters with NotFound before teardown commits. Accepted tradeoffs: if the
          // locked teardown below fails, those waiters saw NotFound for a workspace
          // that still exists (the next provision retries it), and a provision racing
          // this window may briefly succeed before teardown destroys its fresh binding.
          const attempt = attempts.get(workspaceID)
          if (attempt) {
            attempts.delete(workspaceID)
            Deferred.doneUnsafe(attempt, Exit.fail(new NotFound({ workspaceID })))
          }
          return yield* locks.withLock(workspaceID)(
            Effect.gen(function* () {
              const row = yield* find(workspaceID)
              if (!row) return { destroyed: false }
              const connection = connections.get(workspaceID)
              connections.delete(workspaceID)
              if (connection) yield* Scope.close(connection.scope, Exit.void)
              // Null binding still reaches the driver: an interrupted or crashed
              // provision may have created a resource that was never persisted. A
              // provider missing from the registry cannot block deleting a
              // never-provisioned row.
              yield* registry.get(row.provider).pipe(
                Effect.flatMap((driver) => driver.destroy({ workspaceID, binding: row.binding })),
                Effect.catchTag("WorkspaceDriver.ProviderNotFound", (error) =>
                  row.binding ? Effect.fail(error) : Effect.void,
                ),
              )
              yield* recordSandboxEvent("kill")
              yield* db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, workspaceID)).run().pipe(Effect.orDie)
              return { destroyed: true }
            }),
          )
        }),
      })
    }),
  )

export const node = configured()

// TODO(workspace-plan): add the boot janitor and ~23h safety snapshot rotation in a later PR.
// TODO(workspace-plan): make cold wake interruptible with a re-pin loop against janitor races.
// TODO(workspace-plan): consider extracting a keyed shared-attempt helper (join/cancel, drop-on-settle) beside
// KeyedMutex at end-of-series consolidation; filesystem/search.ts and session/run-coordinator.ts hand-roll the same
// shape. Audited stdlib alternatives (rc.111): RcMap fails twice (refcount release cancels in-flight work when the
// last waiter leaves, and one finalizer path cannot express idle-suspend vs destroy); Cache interrupts the shared
// lookup when its last awaiter is interrupted and cannot fail waiters with NotFound on invalidation.
