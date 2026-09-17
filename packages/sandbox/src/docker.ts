export * as SandboxDocker from "./docker.js"

import { Workspace } from "@opencode/schema/workspace"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { spawn as spawnChildProcess } from "node:child_process"
import { Effect, Layer, Schedule, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make } from "effect/unstable/process/ChildProcessSpawner"
import type { DirEntry, FileInfo, FilesImpl, FileType } from "@opencode/core/environment/files"
import { Failed, NotFound, WrongKind } from "@opencode/core/environment/files"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"

/** Provider-private reconnect state. Core stores it opaquely; only this module reads inside. */
interface DockerBinding {
  readonly containerName: string
  readonly containerID?: string
  readonly image: string
  readonly suspended: boolean
  /** Newest snapshot image tag for this workspace, written on suspend. */
  readonly snapshotRef?: string
  /** Epoch ms of the newest snapshot; drives refresh-interval decisions. */
  readonly snapshotAt?: number
}

export interface Options {
  /** Image started for new workspaces. Defaults to `opencode-sandbox:latest`. */
  readonly image?: string
  /** Host path of fs-agent.mjs; when set the driver `docker cp`s it into containers on connect. */
  readonly installAgent?: string
  /** In-container path of the fs agent. */
  readonly agentPath?: string
  /** CPU limit passed as `--cpus` for new containers. */
  readonly cpus?: number
  /** Memory limit passed as `-m` for new containers. */
  readonly memory?: string
  /** Grace period for `docker stop` on suspend. */
  readonly stopTimeoutSeconds?: number
  /** Snapshot the container before idle suspension. Defaults to true. */
  readonly snapshot?: boolean
  /** Skip the suspend snapshot when the newest one is fresher than this. Defaults to 0 (always snapshot). */
  readonly snapshotIntervalMs?: number
  /** Janitor cadence. Defaults to 1 hour. */
  readonly gcIntervalMs?: number
  /** Age at which an unreferenced snapshot group becomes collectable. Defaults to 7 days. */
  readonly snapshotTtlMs?: number
}

const LABEL = "dev.opencode.workspace"
const SNAPSHOT_LABEL = "dev.opencode.snapshot"
const SNAPSHOT_READY = "ready"
const CREATED_LABEL = "dev.opencode.created"
const SNAPSHOT_REPO = "opencode-ws-snapshot"
const AGENT_PATH = "/opt/opencode-sandbox/fs-agent.mjs"
const containerName = (workspaceID: Workspace.ID) => `opencode-ws-${workspaceID}`
const snapshotTag = (workspaceID: Workspace.ID, at: number) => `${workspaceID}-${at}`

interface ExecResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

const run = (args: ReadonlyArray<string>, input?: string) =>
  Effect.callback<ExecResult, WorkspaceDriver.Error>((resume) => {
    const child = spawnChildProcess("docker", args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")))
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")))
    child.on("error", (cause) =>
      resume(Effect.fail(new WorkspaceDriver.Error({ message: `docker ${args.join(" ")} failed to start`, cause }))),
    )
    child.on("close", (code) => resume(Effect.succeed({ stdout, stderr, code: code ?? -1 })))
    child.stdin.end(input)
    return Effect.sync(() => child.kill("SIGKILL"))
  })

const docker = Effect.fn("SandboxDocker.docker")(function* (args: ReadonlyArray<string>, input?: string) {
  const result = yield* run(args, input)
  if (result.code !== 0) {
    return yield* new WorkspaceDriver.Error({
      message: `docker ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`,
    })
  }
  return result.stdout
})

const psByLabel = (workspaceID: Workspace.ID) =>
  docker(["ps", "-a", "--filter", `label=${LABEL}=${workspaceID}`, "--format", "{{.Names}}"]).pipe(
    Effect.map((stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  )

const inspect = (container: string, format: string) =>
  docker(["inspect", "-f", format, container]).pipe(Effect.map((stdout) => stdout.trim()))

const parseBinding = (binding: WorkspaceDriver.Binding) =>
  Effect.gen(function* () {
    if (typeof binding.containerName !== "string" || binding.containerName.length === 0) {
      return yield* new WorkspaceDriver.Error({ message: "docker workspace binding has no containerName" })
    }
    return {
      containerName: binding.containerName,
      containerID: typeof binding.containerID === "string" ? binding.containerID : undefined,
      image: typeof binding.image === "string" ? binding.image : "",
      suspended: binding.suspended === true,
      snapshotRef: typeof binding.snapshotRef === "string" ? binding.snapshotRef : undefined,
      snapshotAt: typeof binding.snapshotAt === "number" ? binding.snapshotAt : undefined,
    } satisfies DockerBinding
  })

const writeBinding = (saveBinding: (binding: WorkspaceDriver.Binding) => Effect.Effect<void>, binding: DockerBinding) =>
  saveBinding({
    containerName: binding.containerName,
    ...(binding.containerID === undefined ? {} : { containerID: binding.containerID }),
    image: binding.image,
    ...(binding.suspended ? { suspended: true } : {}),
    ...(binding.snapshotRef === undefined ? {} : { snapshotRef: binding.snapshotRef }),
    ...(binding.snapshotAt === undefined ? {} : { snapshotAt: binding.snapshotAt }),
  })

interface Snapshot {
  readonly id: string
  readonly tag: string
  readonly workspaceID: Workspace.ID
  readonly createdAt: number
}

const listSnapshots = (workspaceID?: Workspace.ID) =>
  docker([
    "images",
    "--filter",
    `label=${SNAPSHOT_LABEL}=${SNAPSHOT_READY}`,
    ...(workspaceID === undefined ? [] : ["--filter", `label=${LABEL}=${workspaceID}`]),
    "--format",
    "json",
  ]).pipe(
    Effect.map((stdout) =>
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { ID: string; Repository: string; Tag: string; Labels: Record<string, string> })
        .filter((entry) => entry.Repository === SNAPSHOT_REPO && entry.Tag !== "<none>")
        .map((entry) => ({
          id: entry.ID,
          tag: `${entry.Repository}:${entry.Tag}`,
          workspaceID: entry.Labels[LABEL] as Workspace.ID,
          createdAt: Number(entry.Labels[CREATED_LABEL] ?? 0),
        })),
    ),
  )

const latestSnapshot = Effect.fn("SandboxDocker.latestSnapshot")(function* (workspaceID: Workspace.ID) {
  const snapshots = yield* listSnapshots(workspaceID)
  return snapshots.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
})

/**
 * Commits the container's rootfs as a fresh snapshot image. `docker commit`
 * pauses the container for the duration, so the captured filesystem is
 * consistent; a failed commit fails the suspend, which keeps the source
 * container alive ("no destroy before the snapshot is ready").
 */
const takeSnapshot = Effect.fn("SandboxDocker.takeSnapshot")(function* (container: string, workspaceID: Workspace.ID) {
  const at = Date.now()
  yield* docker([
    "commit",
    "--change",
    `LABEL ${LABEL}=${workspaceID}`,
    "--change",
    `LABEL ${SNAPSHOT_LABEL}=${SNAPSHOT_READY}`,
    "--change",
    `LABEL ${CREATED_LABEL}=${at}`,
    container,
    `${SNAPSHOT_REPO}:${snapshotTag(workspaceID, at)}`,
  ])
  return { snapshotRef: `${SNAPSHOT_REPO}:${snapshotTag(workspaceID, at)}`, snapshotAt: at } as const
})

const imageExists = (ref: string) =>
  docker(["image", "inspect", ref]).pipe(
    Effect.map(() => true),
    Effect.catchIf(isNoSuchImage, () => Effect.succeed(false)),
  )

const isNoSuchImage = (error: WorkspaceDriver.Error) =>
  error.message.includes("No such image") || error.message.includes("reference does not exist")

export const driver = (options: Options, hostSpawner: ChildProcessSpawner["Service"]): WorkspaceDriver.Interface => {
  const image = options.image ?? "opencode-sandbox:latest"
  const agentPath = options.agentPath ?? AGENT_PATH

  const runContainer = (workspaceID: Workspace.ID, from: string) =>
    docker([
      "run",
      "-d",
      "--name",
      containerName(workspaceID),
      "--label",
      `${LABEL}=${workspaceID}`,
      ...(options.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
      ...(options.memory === undefined ? [] : ["-m", options.memory]),
      from,
      "sleep",
      "infinity",
    ]).pipe(Effect.map((stdout) => stdout.trim()))

  const create: WorkspaceDriver.Interface["create"] = ({ workspaceID }) =>
    Effect.gen(function* () {
      const bind = (
        containerID: string,
        snapshot?: { readonly snapshotRef: string; readonly snapshotAt: number },
      ): WorkspaceDriver.Binding => ({
        containerName: containerName(workspaceID),
        containerID,
        image,
        ...(snapshot === undefined ? {} : snapshot),
      })
      // Idempotent per workspaceID: adopt any container previously created for
      // this label, including one left behind by a crash between `docker run`
      // and binding persistence.
      const existing = yield* psByLabel(workspaceID)
      if (existing.length > 0) {
        const name = existing.includes(containerName(workspaceID)) ? containerName(workspaceID) : existing[0]
        const id = yield* inspect(name, "{{.Id}}")
        return { binding: { containerName: name, containerID: id, image } }
      }
      // Recovery tier 2: the container is gone but a ready snapshot survives —
      // restart from it so workspace state carries over.
      const snapshot = yield* latestSnapshot(workspaceID)
      if (snapshot !== null && (yield* imageExists(snapshot.tag))) {
        const id = yield* runContainer(workspaceID, snapshot.tag)
        return {
          binding: bind(id, { snapshotRef: snapshot.tag, snapshotAt: snapshot.createdAt }),
        }
      }
      // Recovery tier 3: nothing to adopt or restore — cold start from the base image.
      const id = yield* runContainer(workspaceID, image)
      return { binding: bind(id) }
    })

  const connect: WorkspaceDriver.Interface["connect"] = ({ binding, saveBinding }) =>
    Effect.gen(function* () {
      let parsed = yield* parseBinding(binding)
      const state = yield* inspect(parsed.containerName, "{{.State.Running}}").pipe(
        Effect.catchIf(isNoSuchContainer, () => Effect.succeed("gone")),
      )
      if (state === "gone") {
        // The container was reclaimed or the host restarted. Restore from the
        // binding's snapshot, else the newest labeled snapshot, else cold start.
        const workspaceID = extractWorkspaceID(parsed)
        let from: string | undefined = undefined
        if (parsed.snapshotRef !== undefined && (yield* imageExists(parsed.snapshotRef))) {
          from = parsed.snapshotRef
        } else {
          const snapshot = yield* latestSnapshot(workspaceID)
          if (snapshot !== null && (yield* imageExists(snapshot.tag))) from = snapshot.tag
        }
        if (from === undefined) {
          yield* Effect.logWarning(
            `workspace container ${parsed.containerName} and its snapshots are gone; cold starting from ${image}`,
          )
          from = image
        } else {
          yield* Effect.logWarning(`workspace container ${parsed.containerName} is gone; restoring from ${from}`)
        }
        const id = yield* runContainer(workspaceID, from)
        parsed = { ...parsed, containerID: id }
      } else if (state !== "true") {
        // A suspended container keeps its rootfs; `docker start` revives it.
        yield* docker(["start", parsed.containerName])
      }
      if (parsed.suspended) yield* writeBinding(saveBinding, { ...parsed, suspended: false })
      if (options.installAgent !== undefined) {
        const slash = agentPath.lastIndexOf("/")
        yield* docker(["exec", parsed.containerName, "mkdir", "-p", slash === -1 ? "." : agentPath.slice(0, slash)])
        yield* docker(["cp", options.installAgent, `${parsed.containerName}:${agentPath}`])
      }
      return sandboxDriver(hostSpawner, parsed.containerName, agentPath)
    })

  const suspendForIdle: WorkspaceDriver.Interface["suspendForIdle"] = ({ binding, saveBinding }) =>
    Effect.gen(function* () {
      let parsed = yield* parseBinding(binding)
      if (options.snapshot !== false) {
        const interval = options.snapshotIntervalMs ?? 0
        const due = parsed.snapshotAt === undefined || Date.now() - parsed.snapshotAt >= interval
        if (due) {
          // A failed commit fails the suspend, so the source container stays
          // alive until a ready snapshot exists.
          const fresh = yield* takeSnapshot(parsed.containerName, extractWorkspaceID(parsed))
          if (parsed.snapshotRef !== undefined && parsed.snapshotRef !== fresh.snapshotRef) {
            // Retire the superseded snapshot; in-use images are retried later.
            yield* docker(["rmi", parsed.snapshotRef]).pipe(
              Effect.catchIf(isNoSuchImage, () => Effect.void),
              Effect.catchIf(isImageInUse, () => Effect.void),
            )
          }
          parsed = { ...parsed, snapshotRef: fresh.snapshotRef, snapshotAt: fresh.snapshotAt }
        }
      }
      yield* stopContainer(parsed.containerName, options.stopTimeoutSeconds ?? 10)
      yield* writeBinding(saveBinding, { ...parsed, suspended: true })
    })

  const destroy: WorkspaceDriver.Interface["destroy"] = ({ workspaceID, binding }) =>
    Effect.gen(function* () {
      const names = new Set<string>()
      if (binding !== null) names.add((yield* parseBinding(binding)).containerName)
      // Null binding: a crashed create may still have left a labeled container.
      for (const name of yield* psByLabel(workspaceID)) names.add(name)
      for (const name of names) {
        yield* docker(["rm", "-f", "-v", name]).pipe(
          Effect.catchIf(isNoSuchContainer, () => Effect.void),
        )
      }
      // Snapshots deliberately survive destroy; the janitor reclaims them once
      // the workspace has no container left and the TTL has passed.
    })

  return WorkspaceDriver.make({ create, connect, suspendForIdle, destroy })
}

/** Container names are deterministic per workspace, so the binding re-derives it. */
const extractWorkspaceID = (binding: DockerBinding): Workspace.ID =>
  binding.containerName.replace(/^opencode-ws-/, "") as Workspace.ID

const isImageInUse = (error: WorkspaceDriver.Error) =>
  error.message.includes("image is being used") || error.message.includes("has dependent child images")

const stopContainer = (container: string, timeoutSeconds: number) =>
  docker(["stop", "-t", String(timeoutSeconds), container]).pipe(
    Effect.catchIf(isNoSuchContainer, () => Effect.void),
  )

const isNoSuchContainer = (error: WorkspaceDriver.Error) => error.message.includes("No such container")

/**
 * Rewrites a Command so the described process runs inside the container via
 * `docker exec`. cwd/env become exec flags; stdio and process-control options
 * keep applying to the host-side docker client, which stands in for the
 * container process. `extendEnv` is deliberately dropped: leaking the whole
 * host environment into the sandbox would defeat isolation.
 */
const rewrite = (container: string, command: ChildProcess.Command): ChildProcess.Command => {
  if (command._tag === "PipedCommand") {
    return ChildProcess.pipeTo(rewrite(container, command.left), rewrite(container, command.right), command.options)
  }
  const { cwd, env, extendEnv, ...rest } = command.options
  return ChildProcess.make(
    "docker",
    [
      "exec",
      "-i",
      ...(cwd === undefined ? [] : ["-w", cwd]),
      ...Object.entries(env ?? {}).flatMap(([key, value]) => (value === undefined ? [] : ["-e", `${key}=${value}`])),
      container,
      command.command,
      ...command.args,
    ],
    rest,
  )
}

const sandboxDriver = (hostSpawner: ChildProcessSpawner["Service"], container: string, agentPath: string) => {
  const spawner = make((command) => hostSpawner.spawn(rewrite(container, command)))

  // A failed docker exec is a Failed file operation from the FilesImpl contract's view.
  const agent = <A>(request: Record<string, unknown>, read: (result: unknown) => A): Effect.Effect<A, NotFound | WrongKind | Failed> =>
    Effect.gen(function* () {
      const stdout = yield* docker(["exec", "-i", container, "node", agentPath], JSON.stringify(request)).pipe(
        Effect.mapError(
          (error) => new Failed({ path: String(request.path ?? request.from ?? ""), cause: error }),
        ),
      )
      const response = JSON.parse(stdout) as AgentResponse
      if (response.ok) return read(response.result)
      const error = response.error
      if (error.kind === "NotFound") return yield* new NotFound({ path: error.path })
      if (error.kind === "WrongKind")
        return yield* new WrongKind({ path: error.path, actual: error.actual ?? "other" })
      return yield* new Failed({ path: error.path, cause: new Error(error.message ?? "sandbox fs agent failed") })
    })

  // Narrow the wide agent error union down to each FilesImpl method's contract.
  const toFailed = (error: NotFound | WrongKind | Failed): Failed =>
    error instanceof Failed ? error : new Failed({ path: error.path, cause: error })
  const dropWrongKind = (error: NotFound | WrongKind | Failed): NotFound | Failed =>
    error instanceof WrongKind ? new Failed({ path: error.path, cause: error }) : error

  const overrides: FilesImpl = {
    read: (path, range) =>
      agent(
        range === undefined ? { op: "read", path } : { op: "read", path, offset: range.offset, length: range.length },
        (result) => {
          const { info, bytes } = result as { info: FileInfo; bytes: string }
          return { info, bytes: new Uint8Array(Buffer.from(bytes, "base64")) }
        },
      ),
    stat: (path) => agent({ op: "stat", path }, (result) => result as FileInfo).pipe(Effect.mapError(dropWrongKind)),
    list: (path) => agent({ op: "list", path }, (result) => result as ReadonlyArray<DirEntry>),
    write: (path, bytes) =>
      agent({ op: "write", path, bytes: Buffer.from(bytes).toString("base64") }, () => undefined).pipe(
        Effect.mapError(toFailed),
      ),
    remove: (path) => agent({ op: "remove", path }, () => undefined).pipe(Effect.mapError(toFailed)),
    move: (from, to) => agent({ op: "move", from, to }, () => undefined).pipe(Effect.mapError(dropWrongKind)),
    mkdir: (path) => agent({ op: "mkdir", path }, () => undefined).pipe(Effect.mapError(toFailed)),
  }

  return { spawner, overrides }
}

type AgentResponse =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false
      readonly error: {
        readonly kind: "NotFound" | "WrongKind" | "Failed"
        readonly path: string
        readonly actual?: FileType
        readonly message?: string
      }
    }

/**
 * Boot janitor: reclaims snapshot images whose workspace no longer has a
 * container. Superseded snapshots in a group go immediately; the newest one
 * survives its TTL so a reclaimed workspace can still be restored. Failures
 * never stop the loop — the next sweep retries.
 */
export const collectGarbage = Effect.fn("SandboxDocker.collectGarbage")(function* (ttlMs: number) {
  const byWorkspace = new Map<Workspace.ID, Array<Snapshot>>()
  for (const snapshot of yield* listSnapshots()) {
    const group = byWorkspace.get(snapshot.workspaceID) ?? []
    group.push(snapshot)
    byWorkspace.set(snapshot.workspaceID, group)
  }
  const now = Date.now()
  for (const [workspaceID, group] of byWorkspace) {
    // A surviving container pins its snapshots; the suspend path retires them.
    if ((yield* psByLabel(workspaceID)).length > 0) continue
    const sorted = group.sort((a, b) => b.createdAt - a.createdAt)
    for (const [index, snapshot] of sorted.entries()) {
      if (index === 0 && now - snapshot.createdAt < ttlMs) continue
      yield* docker(["rmi", snapshot.tag]).pipe(
        Effect.catchIf(isNoSuchImage, () => Effect.void),
        Effect.catchIf(isImageInUse, () => Effect.void),
      )
    }
  }
})

/** Registry node wiring the docker driver under its provider name. */
export const registryNode = (provider = "docker", options: Options = {}) =>
  makeGlobalNode({
    service: WorkspaceDriver.RegistryService,
    layer: Layer.effect(
      WorkspaceDriver.RegistryService,
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const scope = yield* Scope.Scope
        yield* collectGarbage(options.snapshotTtlMs ?? 7 * 24 * 60 * 60 * 1000).pipe(
          Effect.catchCause((cause) => Effect.logError("docker workspace janitor sweep failed", cause)),
          Effect.repeat(Schedule.spaced(options.gcIntervalMs ?? 60 * 60 * 1000)),
          Effect.forkScoped,
          Effect.provideService(Scope.Scope, scope),
        )
        return WorkspaceDriver.registry({ [provider]: driver(options, spawner) })
      }),
    ),
    deps: [CrossSpawnSpawner.node],
  })
