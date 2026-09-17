export * as SandboxOpenSandbox from "./opensandbox.js"

import { ConnectionConfig, Sandbox, SandboxManager } from "@alibaba-group/opensandbox"
import type { ConnectionConfigOptions, FileInfo as SandboxFileInfo, SandboxFiles, SnapshotInfo } from "@alibaba-group/opensandbox"
import { Workspace } from "@opencode/schema/workspace"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Effect, Layer, Schedule, Scope } from "effect"
import { systemError } from "effect/PlatformError"
import { make } from "effect/unstable/process/ChildProcessSpawner"
import type { DirEntry, FileInfo, FilesImpl } from "@opencode/core/environment/files"
import { Failed, NotFound, WrongKind } from "@opencode/core/environment/files"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"

/**
 * Provider-private reconnect state: the remote sandbox id plus the image it
 * was started from and the newest Ready snapshot, mirroring the v1 sandbox
 * fleet's persistence model. Core stores it opaquely; only this module reads
 * inside.
 */
interface OpenSandboxBinding {
  readonly sandboxId: string
  readonly image: string
  readonly snapshotId?: string
  readonly snapshotAt?: number
}

export interface Options {
  /** OpenSandbox lifecycle/execd server, e.g. `opensandbox.example.com:443`. */
  readonly domain: string
  readonly protocol?: ConnectionConfigOptions["protocol"]
  readonly apiKey?: string
  /**
   * Base image for cold starts. Defaults to the team registry image used by
   * the v1 sandbox fleet (`opencode-sandbox:browser-cdp`).
   */
  readonly image?: string
  /** Route endpoint lookups through the server gateway. Defaults to false (direct). */
  readonly useServerProxy?: boolean
  /** Sandbox create/readiness budget in seconds. Defaults to 600 (v1 default). */
  readonly timeoutSeconds?: number
  /** Upper bound for waiting a snapshot to become Ready. Defaults to 900s (v1 default). */
  readonly snapshotWaitMs?: number
  /** Janitor cadence. Defaults to 1 hour. */
  readonly gcIntervalMs?: number
  /** Age at which a snapshot whose sandbox is gone becomes collectable. Defaults to 14 days (v1 default). */
  readonly snapshotTtlMs?: number
  /** Resource limits forwarded to the lifecycle API. */
  readonly resource?: Record<string, string>
  /** Environment baked into new sandboxes. */
  readonly env?: Record<string, string>
}

const LABEL = "dev.opencode.workspace"
const SNAPSHOT_NAME_PREFIX = "opencode-ws-"
const DEFAULT_IMAGE = "crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:browser-cdp"
const SNAPSHOT_POLL_MS = 2_000

const snapshotName = (workspaceID: Workspace.ID) => `${SNAPSHOT_NAME_PREFIX}${workspaceID}`
const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

const isGone = (error: WorkspaceDriver.Error) => /not found|no such|404/i.test(error.message)

const tryPromise = <A>(run: () => Promise<A>, message: string) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkspaceDriver.Error({ message: `${message}: ${describe(cause)}`, cause }),
  })

const makeConnectionConfig = (options: Options) =>
  new ConnectionConfig({
    domain: options.domain,
    protocol: options.protocol ?? "https",
    ...(options.apiKey === undefined || options.apiKey.length === 0 ? {} : { apiKey: options.apiKey }),
    ...(options.useServerProxy === undefined ? {} : { useServerProxy: options.useServerProxy }),
    requestTimeoutSeconds: 120,
  })

/** Test/ops helper: true when the sandbox id no longer resolves to a live sandbox. */
export const isSandboxGone = async (options: Options, sandboxId: string): Promise<boolean> => {
  const manager = SandboxManager.create({ connectionConfig: makeConnectionConfig(options) })
  try {
    const info = await manager.getSandboxInfo(sandboxId)
    return info.status.state === "Deleted"
  } catch {
    return true
  } finally {
    await manager.close().catch(() => undefined)
  }
}

export const driver = (options: Options): WorkspaceDriver.Interface => {
  const image = options.image ?? DEFAULT_IMAGE
  const connectionConfig = makeConnectionConfig(options)
  const manager = SandboxManager.create({ connectionConfig })

  const createSandbox = (workspaceID: Workspace.ID, from: { readonly image: string } | { readonly snapshotId: string }) =>
    tryPromise(
      () =>
        Sandbox.create({
          connectionConfig,
          ...("snapshotId" in from ? { snapshotId: from.snapshotId } : { image: from.image }),
          timeoutSeconds: options.timeoutSeconds ?? 600,
          ...(options.resource === undefined ? {} : { resource: options.resource }),
          ...(options.env === undefined ? {} : { env: options.env }),
          metadata: { [LABEL]: workspaceID },
        }),
      `Sandbox.create failed for ${workspaceID}`,
    )

  /** Sandboxes still alive for this workspace: crash adoption and null-binding destroy. */
  const liveSandboxes = Effect.fn("SandboxOpenSandbox.liveSandboxes")(function* (workspaceID: Workspace.ID) {
    const result = yield* tryPromise(
      () => manager.listSandboxInfos({ metadata: { [LABEL]: workspaceID } }),
      "listSandboxInfos failed",
    )
    return result.items
        .filter((info) => info.status.state === "Running" || info.status.state === "Paused")
        .map((info) => info.id)
  })

  const readySnapshots = Effect.fn("SandboxOpenSandbox.readySnapshots")(function* (workspaceID: Workspace.ID) {
    const result = yield* tryPromise(
      () => manager.listSnapshots({ name: snapshotName(workspaceID), states: ["Ready"] }),
      "listSnapshots failed",
    )
    return result.items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  })

  const create: WorkspaceDriver.Interface["create"] = ({ workspaceID }) =>
    Effect.gen(function* () {
      const bind = (
        sandboxId: string,
        snapshot?: { readonly snapshotId: string; readonly snapshotAt: number },
      ): WorkspaceDriver.Binding => ({
        sandboxId,
        image,
        ...(snapshot === undefined ? {} : snapshot),
      })
      // Idempotent per workspaceID: adopt any live sandbox tagged for this
      // workspace, including one left behind by a crash between create and
      // binding persistence.
      const live = yield* liveSandboxes(workspaceID)
      if (live.length > 0) return { binding: bind(live[0]) }
      // Recovery tier 2: the sandbox is gone but a Ready snapshot survives —
      // restore from it so workspace state carries over.
      const snapshots = yield* readySnapshots(workspaceID)
      if (snapshots.length > 0) {
        const sb = yield* createSandbox(workspaceID, { snapshotId: snapshots[0].id })
        return {
          binding: bind(sb.id, { snapshotId: snapshots[0].id, snapshotAt: snapshots[0].createdAt.getTime() }),
        }
      }
      // Recovery tier 3: nothing to adopt or restore — cold start from the base image.
      const sb = yield* createSandbox(workspaceID, { image })
      return { binding: bind(sb.id) }
    })

  const connectSandbox = Effect.fn("SandboxOpenSandbox.connect")(function* (sandboxId: string, workspaceID: Workspace.ID) {
    return yield* tryPromise(
      () => Sandbox.connect({ connectionConfig, sandboxId }),
      `Sandbox.connect failed for ${workspaceID}`,
    )
  })

  const connect: WorkspaceDriver.Interface["connect"] = ({ workspaceID, binding, saveBinding }) =>
    Effect.gen(function* () {
      const parsed = yield* parseBinding(binding)
      const scope = yield* Scope.Scope
      const sb = yield* connectSandbox(parsed.sandboxId, workspaceID).pipe(
        Effect.catchIf(isGone, () =>
          Effect.gen(function* () {
            // The sandbox was reclaimed or expired. Restore from the binding's
            // snapshot, else the newest Ready snapshot, else cold start.
            let from: { readonly image: string } | { readonly snapshotId: string } | undefined
            if (parsed.snapshotId !== undefined && (yield* snapshotReady(parsed.snapshotId))) {
              from = { snapshotId: parsed.snapshotId }
            } else {
              const snapshots = yield* readySnapshots(workspaceID)
              if (snapshots.length > 0) from = { snapshotId: snapshots[0].id }
            }
            if (from === undefined) {
              yield* Effect.logWarning(`sandbox ${parsed.sandboxId} and its snapshots are gone; cold starting`)
              from = { image }
            } else {
              yield* Effect.logWarning(`sandbox ${parsed.sandboxId} is gone; restoring from snapshot`)
            }
            const revived = yield* createSandbox(workspaceID, from)
            yield* saveBinding({
              sandboxId: revived.id,
              image: parsed.image,
              ...(parsed.snapshotId === undefined ? {} : { snapshotId: parsed.snapshotId }),
              ...(parsed.snapshotAt === undefined ? {} : { snapshotAt: parsed.snapshotAt }),
            })
            return revived
          }),
        ),
      )
      // Release client-side HTTP resources when the connection scope closes;
      // the sandbox itself stays alive (Workspace owns its lifecycle).
      yield* Scope.addFinalizer(scope, Effect.promise(() => sb.close().catch(() => undefined)))
      return sandboxEnvironment(sb.files)
    })

  const suspendForIdle: WorkspaceDriver.Interface["suspendForIdle"] = ({ workspaceID, binding, saveBinding }) =>
    Effect.gen(function* () {
      const parsed = yield* parseBinding(binding)
      // Snapshot creation is asynchronous on the server. A snapshot whose
      // source sandbox dies while Creating fails (v1 hard-won lesson), so the
      // sandbox is only killed after Ready is observed; a Failed or timed-out
      // snapshot fails the suspend and keeps the sandbox alive for retry.
      const snapshotId = yield* snapshotUntilReady(parsed.sandboxId, workspaceID)
      yield* retireSuperseded(workspaceID, snapshotId)
      yield* tryPromise(() => manager.killSandbox(parsed.sandboxId), `killSandbox failed for ${workspaceID}`).pipe(
        Effect.catchIf(isGone, () => Effect.void),
      )
      yield* saveBinding({
        sandboxId: parsed.sandboxId,
        image: parsed.image,
        snapshotId,
        snapshotAt: Date.now(),
      })
    })

  const destroy: WorkspaceDriver.Interface["destroy"] = ({ workspaceID, binding }) =>
    Effect.gen(function* () {
      const ids = new Set<string>()
      if (binding !== null) ids.add((yield* parseBinding(binding)).sandboxId)
      // Null binding: a crashed create may still have left a tagged sandbox.
      for (const id of yield* liveSandboxes(workspaceID)) ids.add(id)
      for (const id of ids) {
        yield* tryPromise(() => manager.killSandbox(id), `killSandbox failed for ${workspaceID}`).pipe(
          Effect.catchIf(isGone, () => Effect.void),
        )
      }
      // Snapshots deliberately survive destroy; the janitor reclaims them once
      // the workspace has no live sandbox and the TTL has passed.
    })

  /** Newest Ready snapshots other than `keep` are retired right away. */
  const retireSuperseded = Effect.fn("SandboxOpenSandbox.retireSuperseded")(function* (workspaceID: Workspace.ID, keep: string) {
    const result = yield* tryPromise(
      () => manager.listSnapshots({ name: snapshotName(workspaceID) }),
      "listSnapshots failed",
    )
    for (const snapshot of result.items) {
      if (snapshot.id === keep) continue
      yield* tryPromise(() => manager.deleteSnapshot(snapshot.id), `deleteSnapshot failed`).pipe(
        Effect.catchIf(isGone, () => Effect.void),
      )
    }
  })

  const snapshotReady = Effect.fn("SandboxOpenSandbox.snapshotReady")(function* (snapshotId: string) {
    return yield* tryPromise(() => manager.getSnapshot(snapshotId), "getSnapshot failed").pipe(
      Effect.map((info) => info.status.state === "Ready"),
      Effect.catchIf(isGone, () => Effect.succeed(false)),
    )
  })

  /**
   * Kicks off a server-side snapshot and polls it to Ready within the wait
   * budget. Creating/Failed/timeout never destroys the source sandbox — the
   * caller treats a failed snapshot as a failed suspend.
   */
  const snapshotUntilReady = Effect.fn("SandboxOpenSandbox.snapshotUntilReady")(function* (sandboxId: string, workspaceID: Workspace.ID) {
    const info = yield* tryPromise(
      () => manager.createSnapshot(sandboxId, { name: snapshotName(workspaceID) }),
      `createSnapshot failed for ${workspaceID}`,
    )
    const deadline = Date.now() + (options.snapshotWaitMs ?? SNAPSHOT_WAIT_MS_DEFAULT)
    let current = info
    while (current.status.state !== "Ready") {
      if (current.status.state === "Failed") {
        return yield* new WorkspaceDriver.Error({
          message: `snapshot ${info.id} failed for ${workspaceID}: ${current.status.message ?? "unknown reason"}`,
        })
      }
      if (Date.now() > deadline) {
        return yield* new WorkspaceDriver.Error({
          message: `snapshot ${info.id} for ${workspaceID} did not become Ready within the wait budget`,
        })
      }
      yield* Effect.sleep(SNAPSHOT_POLL_MS)
      current = yield* tryPromise(() => manager.getSnapshot(info.id), "getSnapshot failed")
    }
    return info.id
  })

  return WorkspaceDriver.make({ create, connect, suspendForIdle, destroy })
}

const SNAPSHOT_WAIT_MS_DEFAULT = 900_000

const parseBinding = (binding: WorkspaceDriver.Binding) =>
  Effect.gen(function* () {
    if (typeof binding.sandboxId !== "string" || binding.sandboxId.length === 0) {
      return yield* new WorkspaceDriver.Error({ message: "opensandbox workspace binding has no sandboxId" })
    }
    return {
      sandboxId: binding.sandboxId,
      image: typeof binding.image === "string" ? binding.image : "",
      snapshotId: typeof binding.snapshotId === "string" ? binding.snapshotId : undefined,
      snapshotAt: typeof binding.snapshotAt === "number" ? binding.snapshotAt : undefined,
    } satisfies OpenSandboxBinding
  })

/**
 * Boot janitor: reclaims snapshots whose workspace no longer has a live
 * sandbox. Superseded snapshots in a group go immediately (the suspend path
 * also retires them); the newest survives its TTL so a reclaimed workspace
 * can still be restored.
 */
export const collectGarbage = Effect.fn("SandboxOpenSandbox.collectGarbage")(function* (manager: SandboxManager, ttlMs: number) {
  const result = yield* tryPromise(() => manager.listSnapshots(), "listSnapshots failed")
  const byWorkspace = new Map<string, Array<SnapshotInfo>>()
  for (const snapshot of result.items) {
    if (snapshot.name === undefined) continue
    const group = byWorkspace.get(snapshot.name) ?? []
    group.push(snapshot)
    byWorkspace.set(snapshot.name, group)
  }
  const now = Date.now()
  for (const [name, group] of byWorkspace) {
    const workspaceID = name.startsWith(SNAPSHOT_NAME_PREFIX) ? name.slice(SNAPSHOT_NAME_PREFIX.length) : undefined
    if (workspaceID === undefined || workspaceID.length === 0) continue
    // A live sandbox pins its snapshots; the suspend path retires them.
    const live = yield* tryPromise(
      () => manager.listSandboxInfos({ metadata: { [LABEL]: workspaceID as Workspace.ID } }),
      "listSandboxInfos failed",
    ).pipe(Effect.map((listing) => listing.items.some((info) => info.status.state === "Running" || info.status.state === "Paused")))
    if (live) continue
    const sorted = group.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    for (const [index, snapshot] of sorted.entries()) {
      if (index === 0 && now - snapshot.createdAt.getTime() < ttlMs) continue
      yield* tryPromise(() => manager.deleteSnapshot(snapshot.id), "deleteSnapshot failed").pipe(
        Effect.catchIf(isGone, () => Effect.void),
      )
    }
  }
})

const sandboxEnvironment = (files: SandboxFiles) => {
  // The spawner adapter (ExecdCommands bash-session semantics mapped onto the
  // ChildProcessSpawner shape) lands in the next migration batch.
  const spawner = make(() =>
    Effect.fail(
      systemError({
        _tag: "Unknown",
        module: "SandboxOpenSandbox",
        method: "spawn",
        description: "opensandbox spawner adapter is not implemented yet",
      }),
    ),
  )

  const fileInfo = (info: SandboxFileInfo): FileInfo => ({
    type: (info.type ?? "other") as FileInfo["type"],
    size: info.size ?? 0,
    mtimeMs: info.modifiedAt?.getTime() ?? 0,
  })

  const stat = Effect.fn("SandboxOpenSandbox.stat")(function* (path: string) {
    const map = yield* agent(() => files.getFileInfo([path]), path)
    const info = map[path]
    if (info === undefined) return yield* new NotFound({ path })
    return fileInfo(info)
  })

  const overrides: FilesImpl = {
    read: (path, range) =>
      Effect.gen(function* () {
        const info = yield* stat(path)
        if (info.type !== "file") return yield* new WrongKind({ path, actual: info.type })
        const bytes = yield* agent(
          () => files.readBytes(path, range === undefined ? undefined : { offset: range.offset, limit: range.length }),
          path,
        )
        return { info, bytes }
      }),
    stat: (path) => stat(path),
    list: (path) =>
      Effect.gen(function* () {
        const info = yield* stat(path)
        if (info.type !== "directory" && info.type !== "symlink") {
          return yield* new WrongKind({ path, actual: info.type })
        }
        const entries = yield* agent(() => files.listDirectory({ path }), path)
        return entries.map((entry) => ({
          name: entry.path.split("/").filter(Boolean).pop() ?? entry.path,
          type: (entry.type ?? "other") as FileInfo["type"],
        })) satisfies Array<DirEntry>
      }),
    write: (path, bytes) => agentVoid(() => files.writeFiles([{ path, data: bytes }]), path),
    remove: (path) =>
      Effect.gen(function* () {
        const info = yield* stat(path).pipe(Effect.catchTag("Environment.NotFound", () => Effect.succeed(null)))
        // rm -rf semantics: removing a missing path succeeds.
        if (info === null) return
        if (info.type === "directory") return yield* agentVoid(() => files.deleteDirectories([path]), path)
        return yield* agentVoid(() => files.deleteFiles([path]), path)
      }),
    move: (from, to) =>
      Effect.gen(function* () {
        const info = yield* stat(from)
        if (info.type === "file") {
          const target = yield* stat(to).pipe(
            Effect.map((dest) => (dest.type === "directory" ? `${to}/${from.split("/").pop()}` : to)),
            Effect.catchTag("Environment.NotFound", () => Effect.succeed(to)),
          )
          return yield* agentVoid(() => files.moveFiles([{ src: from, dest: target }]), from)
        }
        return yield* agentVoid(() => files.moveFiles([{ src: from, dest: to }]), from)
      }),
    mkdir: (path) => agentVoid(() => files.createDirectories([{ path }]), path),
  }

  return { spawner, overrides }
}

/** OpenSandbox request failures collapse into Failed file operations. */
const agent = <A>(run: () => Promise<A>, path: string) =>
  tryPromise(run, "sandbox files request failed").pipe(
    Effect.mapError(() => new Failed({ path, cause: new Error("sandbox files request failed") })),
  )

const agentVoid = (run: () => Promise<void>, path: string) =>
  agent(run, path).pipe(Effect.asVoid)

/** Registry node wiring the opensandbox driver under its provider name. */
export const registryNode = (provider = "opensandbox", options: Options) =>
  makeGlobalNode({
    service: WorkspaceDriver.RegistryService,
    layer: Layer.effect(
      WorkspaceDriver.RegistryService,
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const manager = SandboxManager.create({ connectionConfig: makeConnectionConfig(options) })
        yield* Scope.addFinalizer(scope, Effect.promise(() => manager.close().catch(() => undefined)))
        yield* collectGarbage(manager, options.snapshotTtlMs ?? 14 * 24 * 60 * 60 * 1000).pipe(
          Effect.catchCause((cause) => Effect.logError("opensandbox workspace janitor sweep failed", cause)),
          Effect.repeat(Schedule.spaced(options.gcIntervalMs ?? 60 * 60 * 1000)),
          Effect.forkScoped,
        )
        return WorkspaceDriver.registry({ [provider]: driver(options) })
      }),
    ),
    deps: [],
  })
