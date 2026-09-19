export * as SandboxOpenSandbox from "./opensandbox.js"

import { createDefaultAdapterFactory, ConnectionConfig, Sandbox, SandboxManager } from "@alibaba-group/opensandbox"
import type { ConnectionConfigOptions, RunCommandOpts, SnapshotInfo } from "@alibaba-group/opensandbox"
import { Workspace } from "@opencode/schema/workspace"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { ChildProcess } from "effect/unstable/process"
import { Cause, Deferred, Effect, Layer, Queue, Ref, Schedule, Scope, Sink, Stream } from "effect"
import { make, makeHandle, ExitCode, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
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

/**
 * Provider name registered with the WorkspaceDriver registry in sandbox mode.
 */
export const PROVIDER = "opensandbox"

/**
 * Builds driver options from the environment (v1 flag parity). Returns
 * undefined when no sandbox domain is configured, letting callers fall back to
 * the local environment driver.
 */
export const fromEnv = (env: Record<string, string | undefined> = process.env): Options | undefined => {
  const domain = env["OPENCODE_SANDBOX_DOMAIN"]
  if (domain === undefined || domain.length === 0) return undefined
  return {
    domain,
    protocol: (env["OPENCODE_SANDBOX_PROTOCOL"] as "https" | "http" | undefined) ?? "http",
    ...(env["OPENCODE_SANDBOX_API_KEY"] === undefined || env["OPENCODE_SANDBOX_API_KEY"].length === 0
      ? {}
      : { apiKey: env["OPENCODE_SANDBOX_API_KEY"] }),
    ...(env["OPENCODE_SANDBOX_IMAGE"] === undefined ? {} : { image: env["OPENCODE_SANDBOX_IMAGE"] }),
    useServerProxy: env["OPENCODE_SANDBOX_USE_SERVER_PROXY"] !== "false",
  }
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

  const createSandbox = (
    workspaceID: Workspace.ID,
    from: { readonly image: string } | { readonly snapshotId: string },
    resourceOverride?: Record<string, string>,
  ) =>
    tryPromise(
      () =>
        Sandbox.create({
          connectionConfig,
          ...("snapshotId" in from ? { snapshotId: from.snapshotId } : { image: from.image }),
          timeoutSeconds: options.timeoutSeconds ?? 600,
          ...(resourceOverride ?? options.resource) === undefined ? {} : { resource: resourceOverride ?? options.resource },
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

  const create: WorkspaceDriver.Interface["create"] = ({ workspaceID, resource }) =>
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
      const sb = yield* createSandbox(workspaceID, { image }, resource)
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
      return sandboxEnvironment(sb)
    })

  const snapshot: WorkspaceDriver.Interface["snapshot"] = ({ workspaceID, binding, saveBinding }) =>
    Effect.gen(function* () {
      const parsed = yield* parseBinding(binding)
      // Same Ready-before-commit semantics as suspend, but the source sandbox stays alive.
      const snapshotId = yield* snapshotUntilReady(parsed.sandboxId, workspaceID)
      yield* retireSuperseded(workspaceID, snapshotId)
      yield* saveBinding({
        sandboxId: parsed.sandboxId,
        image: parsed.image,
        snapshotId,
        snapshotAt: Date.now(),
      })
      return { snapshotId }
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

  return WorkspaceDriver.make({ create, connect, snapshot, suspendForIdle, destroy })
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

/** POSIX single-quote escaping for argv -> shell script translation. */
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`

/**
 * Translates a Command into a shell script plus exec options. argv is quoted so
 * the remote bash runs the same process; pipes become shell pipes. `extendEnv`
 * is dropped: the sandbox must not inherit the host environment.
 */
const toShell = (command: ChildProcess.Command): { script: string; options: RunCommandOpts } => {
  if (command._tag === "PipedCommand") {
    const left = toShell(command.left)
    const right = toShell(command.right)
    return {
      script: `${left.script} | ${right.script}`,
      options: {
        ...right.options,
        ...(left.options.workingDirectory !== undefined ? { workingDirectory: left.options.workingDirectory } : {}),
      },
    }
  }
  const envs = Object.fromEntries(
    Object.entries(command.options.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    script: [command.command, ...command.args].map(quote).join(" "),
    options: {
      ...(command.options.cwd === undefined ? {} : { workingDirectory: command.options.cwd }),
      ...(Object.keys(envs).length === 0 ? {} : { envs }),
    },
  }
}

/**
 * Spawns a command inside the sandbox by streaming execd SSE events and
 * mapping them onto a ChildProcessHandle: init carries the command id used for
 * interruption, stdout/stderr feed queues, and completion/error settle the
 * exit code (mirrors the SDK's foreground exit-code inference).
 */
const spawnInSandbox = (sb: Sandbox, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const { script, options } = toShell(command)
    yield* Effect.logInfo("[spawn-probe] spawn start", { script, options })
    const out = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const err = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const exit = yield* Deferred.make<ExitCode>()
    const commandID = yield* Ref.make<string | undefined>(undefined)
    const failure = yield* Ref.make<string | undefined>(undefined)
    const sawExit = yield* Ref.make(false)
    const abort = new AbortController()
    const encoder = new TextEncoder()

    yield* Stream.fromAsyncIterable(
      sb.commands.runStream(script, options, abort.signal),
      (cause) => new Error(`sandbox command stream failed: ${String(cause)}`),
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("[spawn-probe] event", { type: event.type, text: typeof event.text === "string" ? event.text.slice(0, 80) : undefined })
          if (event.type === "init") {
            if (typeof event.text === "string" && event.text.length > 0) yield* Ref.set(commandID, event.text)
            return
          }
          // execd events carry line payloads without the trailing newline
          // (the SDK's own collector joins with "\n"); append it back so
          // multi-line command output keeps its shape.
          if (event.type === "stdout") return yield* Queue.offer(out, encoder.encode((event.text ?? "") + "\n"))
          if (event.type === "execution_complete") yield* Ref.set(sawExit, true)
          if (event.type === "stderr") return yield* Queue.offer(err, encoder.encode((event.text ?? "") + "\n"))
          if (event.type === "error") {
            const detail = event.error as { evalue?: unknown; value?: unknown } | undefined
            const value = detail?.evalue ?? detail?.value
            if (value !== undefined) yield* Ref.set(failure, String(value))
          }
        }),
      ),
      Effect.ensuring(Effect.all([Queue.end(out), Queue.end(err)])),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Effect.logInfo("[spawn-probe] stream done")
          const failed = yield* Ref.get(failure)
          const trimmed = failed?.trim() ?? ""
          const parsed = /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined
          const sawCompletion = yield* Ref.get(sawExit)
          // A stream that ends without a completion event means the execd
          // connection died (e.g. the sandbox was reclaimed externally);
          // report a transport failure instead of a fake success.
          const code = parsed ?? (failed === undefined ? (sawCompletion ? 0 : -1) : 1)
          yield* Deferred.succeed(exit, ExitCode(code))
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("sandbox command stream ended abnormally", cause)
          yield* Ref.set(sawExit, false)
        }),
      ),
      Effect.forkScoped,
    )

    return makeHandle({
      // The execd has no host pid; expose a stable non-zero placeholder.
      pid: ProcessId(0),
      // execd has no stdin channel for foreground commands.
      stdin: Sink.drain,
      stdout: Stream.fromQueue(out),
      stderr: Stream.fromQueue(err),
      all: Stream.merge(Stream.fromQueue(out), Stream.fromQueue(err)),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
      exitCode: Deferred.await(exit),
      kill: () =>
        Effect.gen(function* () {
          abort.abort()
          const id = yield* Ref.get(commandID)
          if (id !== undefined) {
            yield* Effect.promise(() => sb.commands.interrupt(id)).pipe(
              Effect.catchCause((cause) => Effect.logWarning("sandbox interrupt failed", cause)),
            )
          }
        }),
      unref: Effect.succeed(Effect.void),
    })
  })

const sandboxEnvironment = (sb: Sandbox) => {
  const files = sb.files
  const spawner = make((command) => spawnInSandbox(sb, command))

  // The execd's files API (`getFileInfo`/`readBytes`) serves a stale view that
  // never sees `writeFiles` output, while commands inside the sandbox see it
  // immediately — so stat/read resolve through exec scripts instead. write and
  // mkdir stay on the files API: exec has no stdin channel to feed bytes in.
  const shQuote = (value: string) => `'` + value.replace(/'/g, `'\\''`) + `'`
  const runScript = (script: string) =>
    Effect.promise(() =>
      (async () => {
        const lines: string[] = []
        for await (const event of sb.commands.runStream(script)) {
          if (event.type === "stdout") lines.push(event.text ?? "")
        }
        return lines
      })(),
    )

  const fileFacts = Effect.fn("SandboxOpenSandbox.fileFacts")(function* (
    path: string,
    range?: { readonly offset: number; readonly length: number },
  ) {
    const p = shQuote(path)
    const body = range ? `tail -c +$(( ${range.offset} + 1 )) ${p} | head -c ${range.length} | base64` : `base64 ${p}`
    const script = [
      `if [ -d ${p} ]; then printf '__DIR__\\n'; exit 0; fi`,
      `if [ ! -f ${p} ]; then printf '__MISSING__\\n'; exit 0; fi`,
      `printf '__SIZE__%s\\n' "$(wc -c < ${p})"`,
      `printf '__MTIME__%s\\n' "$(stat -c %Y ${p} 2>/dev/null || printf 0)"`,
      `printf '__B64__\\n'`,
      body,
    ].join("\n")
    const lines = yield* runScript(script).pipe(
      Effect.mapError(() => new Failed({ path, cause: new Error("sandbox exec stream failed") })),
    )
    if (lines[0] === "__DIR__") return yield* new WrongKind({ path, actual: "directory" })
    if (lines[0] === "__MISSING__") return yield* new NotFound({ path })
    const marker = lines.indexOf("__B64__")
    const size = Number(lines.find((line) => line.startsWith("__SIZE__"))?.slice("__SIZE__".length) ?? NaN)
    const mtime = Number(lines.find((line) => line.startsWith("__MTIME__"))?.slice("__MTIME__".length) ?? 0)
    if (marker < 0 || Number.isNaN(size))
      return yield* new Failed({ path, cause: new Error("sandbox read produced no payload") })
    const bytes = Buffer.from(lines.slice(marker + 1).join(""), "base64")
    return { info: { type: "file" as const, size, mtimeMs: mtime * 1000 }, bytes }
  })

  const stat = Effect.fn("SandboxOpenSandbox.stat")(function* (path: string) {
    return (yield* fileFacts(path)).info
  })

  const overrides: Partial<FilesImpl> = {
    read: (path, range) => fileFacts(path, range),
    write: (path, bytes) =>
      agentVoid(() => files.writeFiles([{ path, data: bytes }]), path).pipe(
        Effect.mapError(() => new Failed({ path, cause: new Error("sandbox write failed") })),
      ),
    mkdir: (path) =>
      agentVoid(() => files.createDirectories([{ path }]), path).pipe(
        Effect.mapError(() => new Failed({ path, cause: new Error("sandbox mkdir failed") })),
      ),
  }

  return { spawner, overrides }
}

/** OpenSandbox request failures collapse into Failed file operations. */
// execd reports missing paths through SandboxApiException with a 404-ish
// status or "not found" message; callers (e.g. write's BOM-preserving read of
// the existing file) rely on NotFound specifically and treat generic Failed
// as fatal.
const isNotFound = (cause: unknown) => {
  // "Download failed" is the execd's fixed wording when readBytes targets a
  // missing path (verified against the fleet's execd build).
  const text = String((cause as { message?: string })?.message ?? cause)
  return /not found|no such file|404|download failed/i.test(text)
}

const agent = <A>(run: () => Promise<A>, path: string) =>
  tryPromise(run, "sandbox files request failed").pipe(
    Effect.mapError((error) =>
      isNotFound((error as { cause?: unknown })?.cause ?? error)
        ? new NotFound({ path })
        : new Failed({ path, cause: new Error("sandbox files request failed") },
      ),
    ),
  )

const agentVoid = (run: () => Promise<void>, path: string) =>
  agent(run, path).pipe(Effect.asVoid)

/**
 * Resolves the externally reachable address (host:port) for one sandbox
 * service port; used by the server's proxy/endpoint routes.
 */
export const resolveEndpoint = Effect.fn("SandboxOpenSandbox.resolveEndpoint")((sandboxId: string, port: number) =>
  Effect.tryPromise({
    try: async () => {
      const connectionConfig = makeConnectionConfig(fromEnv() as Options)
      const factory = createDefaultAdapterFactory()
      const stack = factory.createLifecycleStack({
        connectionConfig,
        lifecycleBaseUrl: connectionConfig.getBaseUrl(),
      })
      const endpoint = await stack.sandboxes.getSandboxEndpoint(
        sandboxId as never,
        port,
        connectionConfig.useServerProxy,
      )
      return endpoint.endpoint
    },
    catch: (cause) => new Error(`resolveEndpoint failed: ${String(cause)}`),
  }),
)

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
