export * as WorkspaceDocker from "./docker.js"

import { Workspace } from "@opencode/schema/workspace"
import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { spawn as spawnChildProcess } from "node:child_process"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner, make } from "effect/unstable/process/ChildProcessSpawner"
import type { DirEntry, FileInfo, FilesImpl, FileType } from "../environment/files.js"
import { Failed, NotFound, WrongKind } from "../environment/files.js"
import { WorkspaceDriver } from "./driver.js"

/** Provider-private reconnect state. Core stores it opaquely; only this module reads inside. */
interface DockerBinding {
  readonly containerName: string
  readonly containerID?: string
  readonly image: string
  readonly suspended: boolean
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
}

const LABEL = "dev.opencode.workspace"
const AGENT_PATH = "/opt/opencode-sandbox/fs-agent.mjs"
const containerName = (workspaceID: Workspace.ID) => `opencode-ws-${workspaceID}`

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

const docker = Effect.fn("WorkspaceDocker.docker")(function* (args: ReadonlyArray<string>, input?: string) {
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
    } satisfies DockerBinding
  })

const writeBinding = (saveBinding: (binding: WorkspaceDriver.Binding) => Effect.Effect<void>, binding: DockerBinding) =>
  saveBinding({
    containerName: binding.containerName,
    ...(binding.containerID === undefined ? {} : { containerID: binding.containerID }),
    image: binding.image,
    ...(binding.suspended ? { suspended: true } : {}),
  })

export const driver = (options: Options, hostSpawner: ChildProcessSpawner["Service"]): WorkspaceDriver.Interface => {
  const image = options.image ?? "opencode-sandbox:latest"
  const agentPath = options.agentPath ?? AGENT_PATH

  const create: WorkspaceDriver.Interface["create"] = ({ workspaceID }) =>
    Effect.gen(function* () {
      // Idempotent per workspaceID: adopt any container previously created for
      // this label, including one left behind by a crash between `docker run`
      // and binding persistence.
      const existing = yield* psByLabel(workspaceID)
      if (existing.length > 0) {
        const name = existing.includes(containerName(workspaceID)) ? containerName(workspaceID) : existing[0]
        const id = yield* inspect(name, "{{.Id}}")
        return { binding: { containerName: name, containerID: id, image } }
      }
      const id = yield* docker([
        "run",
        "-d",
        "--name",
        containerName(workspaceID),
        "--label",
        `${LABEL}=${workspaceID}`,
        ...(options.cpus === undefined ? [] : ["--cpus", String(options.cpus)]),
        ...(options.memory === undefined ? [] : ["-m", options.memory]),
        image,
        "sleep",
        "infinity",
      ]).pipe(Effect.map((stdout) => stdout.trim()))
      return { binding: { containerName: containerName(workspaceID), containerID: id, image } }
    })

  const connect: WorkspaceDriver.Interface["connect"] = ({ binding, saveBinding }) =>
    Effect.gen(function* () {
      const parsed = yield* parseBinding(binding)
      if ((yield* inspect(parsed.containerName, "{{.State.Running}}")) !== "true") {
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
      const parsed = yield* parseBinding(binding)
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
    })

  return WorkspaceDriver.make({ create, connect, suspendForIdle, destroy })
}

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

/** Registry node wiring the docker driver under its provider name. */
export const registryNode = (provider = "docker", options: Options = {}) =>
  makeGlobalNode({
    service: WorkspaceDriver.RegistryService,
    layer: Layer.effect(
      WorkspaceDriver.RegistryService,
      Effect.map(ChildProcessSpawner, (spawner) => WorkspaceDriver.registry({ [provider]: driver(options, spawner) })),
    ),
    deps: [CrossSpawnSpawner.node],
  })
