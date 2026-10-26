export * as SessionToolSandbox from "./tool-sandbox.js"

import { createHash, randomUUID } from "node:crypto"
import { Context, Effect, Layer, Option, Schema, type Scope } from "effect"
import { Tool } from "@opencode/schema/tool"
import { ToolFailure } from "@opencode/ai"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SandboxProvider } from "../sandbox/provider.js"
import { SandboxEndpoint } from "../sandbox/endpoint.js"
import { Database } from "../database/database.js"
import { SessionToolGate } from "./tool-gate.js"
import { materialize } from "./tool-host/assets.js"
import type { Session } from "../session.js"
import type { SessionTool } from "@opencode/schema/session-tool"
import type { Tool as ToolRegistry } from "../tool.js"
import { Manifest, HostError, port, prefix, protocolVersion, versionHash, type Envelope } from "./tool-host-protocol.js"

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const ownerID = randomUUID()
export const launcher = (sandboxID: string, runtimeDirectory: string) => {
  const pid = "/tmp/opencode-session-tool-host.pid"
  // A resumed VM can retain a daemon from an older SaaS fencing generation.
  const generation = `${pid}.generation`
  const command = `if [ -s ${quote(pid)} ] && kill -0 "$(cat ${quote(pid)})" 2>/dev/null && [ "$(cat ${quote(generation)} 2>/dev/null)" = ${quote(sandboxID)} ]; then echo ready; else if [ -s ${quote(pid)} ]; then old="$(cat ${quote(pid)})"; kill "$old" 2>/dev/null || true; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$old" 2>/dev/null || break; sleep 0.1; done; kill -9 "$old" 2>/dev/null || true; fi; OPENCODE_SESSION_TOOL_SANDBOX_ID=${quote(sandboxID)} nohup node ${quote(`${runtimeDirectory}/session-tool-host.mjs`)} --serve > /tmp/opencode-session-tool-host.log 2>&1 </dev/null & echo $! > ${quote(pid)}; printf '%s' ${quote(sandboxID)} > ${quote(generation)}; fi`
  // The daemon must not inherit the flock descriptor and retain the startup lock forever.
  return `flock --close -x ${quote(`${pid}.lock`)} -c ${quote(command)}`
}

export interface Connection {
  endpoint: string
  headers?: Readonly<Record<string, string>>
  envelope: Envelope
}
export interface Interface {
  readonly load: (session: Session.Info, row: SessionTool.Info) => Effect.Effect<Tool.Info, Error>
  readonly release: (sessionID: string, scope?: "session" | "sandbox") => Effect.Effect<void>
  readonly capture: (snapshot: ToolRegistry.Snapshot, tools: ReadonlyArray<Tool.Info>) => void
  readonly acquire: (snapshot: ToolRegistry.Snapshot) => Effect.Effect<ToolRegistry.Snapshot, Error, Scope.Scope>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionToolSandbox") {}
interface Lease {
  connection: Connection
  snapshotID: string
}
class RequestLease extends Context.Service<RequestLease, Lease>()("@opencode/SessionToolSnapshotLease") {}
interface Captured {
  session: Session.Info
  row: SessionTool.Info
  manifest: Manifest
  sourcePath: string
}

export async function rpc(
  connection: Connection,
  operation: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const response = await fetch(`${SandboxEndpoint.httpUrl(connection.endpoint)}${prefix}${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...connection.headers },
    body: JSON.stringify({ ...connection.envelope, ...body }),
    signal: signal ?? AbortSignal.timeout(12_000),
  })
  if (!response.ok) {
    const failure = (await response.json()) as { code?: string; message?: string }
    throw new HostError(failure.code ?? "not-ready", failure.message ?? `Host HTTP ${response.status}`)
  }
  return response
}

export async function consume(
  connection: Connection,
  response: Response,
  executionID: string,
  context: Tool.Context,
): Promise<Tool.Result> {
  if (!response.body) throw new HostError("result-unknown", "Host returned no execution stream")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let ordinal = 0
  try {
    while (true) {
      const next = await reader.read()
      buffer += decoder.decode(next.value, { stream: !next.done })
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024 + 4096)
        throw new HostError("result-too-large", "Host frame exceeds budget")
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const frame = JSON.parse(line)
        if (frame.executionID !== executionID || !Number.isInteger(frame.ordinal) || frame.ordinal <= ordinal)
          throw new HostError("protocol-mismatch", "Execution frame identity/order mismatch")
        ordinal = frame.ordinal
        if (frame.type === "progress") {
          let error: string | undefined
          try {
            await Effect.runPromise(context.progress(frame.update))
          } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
          }
          await rpc(connection, "progress-ack", {
            executionID,
            progressID: frame.progressID,
            outcome: error ? "error" : "ok",
            ...(error ? { message: error } : {}),
          })
        } else if (frame.type === "result") return frame.result
        else if (frame.type === "error") throw new HostError(frame.code, frame.message)
      }
      if (next.done) throw new HostError("result-unknown", "Host stream closed without terminal result")
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

const failure = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)))
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sandbox = yield* SandboxProvider.Service
    const gate = SessionToolGate.make((yield* Database.Service).db)
    const connections = new Map<string, Connection>()
    // Producer-owned data only; canonical lookup/executors remain in Tool.Snapshot.
    const captured = new WeakMap<Tool.Info, Captured>()
    const snapshots = new WeakMap<ToolRegistry.Snapshot["execute"], ReadonlyArray<Captured>>()
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        [...connections.values()],
        (connection) =>
          Effect.tryPromise({ try: () => rpc(connection, "owner-release"), catch: failure }).pipe(Effect.ignore),
        { discard: true, concurrency: 4 },
      ),
    )

    const prepare = Effect.fn("SessionToolSandbox.prepare")(function* (session: Session.Info) {
      if (!sandbox.enabled) return yield* Effect.fail(new Error("Session tools require an enabled Sandbox"))
      const sandboxID = yield* sandbox.boot(session.id)
      yield* gate.booted(session.id, sandboxID)
      const runtimeDirectory = yield* materialize(sandbox, session.id)
      const started = yield* sandbox.run({
        sessionID: session.id,
        hostWorkdir: session.location.directory,
        command: launcher(sandboxID, runtimeDirectory),
        timeoutMs: 10_000,
      })
      if (started.exitCode !== 0)
        return yield* Effect.fail(new Error(`Session Tool Host launch failed: ${started.output}`))
      const resolved = yield* sandbox.endpoint(session.id, port, true)
      if (resolved._tag !== "resolved") return yield* Effect.fail(new Error("Session Tool Host endpoint unavailable"))
      const endpoint = resolved.endpoint.replace(/\/$/, "")
      let health: { hostEpoch: string; sandboxID: string; protocolVersion: number } | undefined
      for (let attempt = 0; attempt < 20; attempt++) {
        health = yield* Effect.tryPromise({
          try: async () => {
            const response = await fetch(`${SandboxEndpoint.httpUrl(endpoint)}${prefix}health`, { headers: resolved.headers, signal: AbortSignal.timeout(2000) })
            if (!response.ok) throw new Error(`Host health HTTP ${response.status}`)
            return (await response.json()) as NonNullable<typeof health>
          },
          catch: failure,
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (health) break
        yield* Effect.sleep("250 millis")
      }
      if (!health || health.sandboxID !== sandboxID || health.protocolVersion !== protocolVersion)
        return yield* Effect.fail(new Error("Session Tool Host capability/identity mismatch"))
      const connection: Connection = {
        endpoint,
        headers: resolved.headers,
        envelope: {
          protocolVersion,
          sandboxID,
          hostEpoch: health.hostEpoch,
          ownerID,
          ownerLeaseID: "",
          logicalSessionID: session.id,
          lifecycleEpoch: 1,
          generation: 1,
        },
      }
      const response = yield* gate.admit(session.id, sandboxID, (epoch) =>
        Effect.tryPromise({
          try: async () => {
            connection.envelope.lifecycleEpoch = epoch
            const result = await rpc(connection, "prepare")
            return (await result.json()) as { generation: number; hostEpoch: string; ownerLeaseID: string }
          },
          catch: failure,
        }),
      )
      connection.envelope.generation = response.generation
      connection.envelope.ownerLeaseID = response.ownerLeaseID
      connections.set(session.id, connection)
      return connection
    })

    const heartbeat = (connection: Connection) =>
      Effect.tryPromise({
        try: () => rpc(connection, "renew"),
        catch: failure,
      })
    const publishSource = Effect.fn("SessionToolSandbox.publishSource")(function* (
      sessionID: string,
      sourcePath: string,
      code: string,
    ) {
      const temporary = `${sourcePath}.tmp-${randomUUID()}`
      yield* sandbox.fileWrite(sessionID, temporary, code)
      const result = yield* sandbox.run({
        sessionID,
        hostWorkdir: "/workspace",
        timeoutMs: 10_000,
        command: `mv ${quote(temporary)} ${quote(sourcePath)}`,
      })
      if (result.exitCode !== 0) return yield* Effect.fail(new Error("Session Tool source atomic publication failed"))
    })

    return Service.of({
      capture: (snapshot, tools) => {
        const names = new Set(snapshot.definitions.map((definition) => definition.name))
        snapshots.set(
          snapshot.execute,
          tools
            .filter((tool) => names.has(tool.name))
            .flatMap((tool) => {
              const value = captured.get(tool)
              return value ? [value] : []
            }),
        )
      },
      acquire: (snapshot) =>
        Effect.gen(function* () {
          const versions =
            snapshots
              .get(snapshot.execute)
              ?.filter((value) => snapshot.definitions.some((tool) => tool.name === value.row.name)) ?? []
          const first = versions[0]
          if (!first) return snapshot
          const current = yield* prepare(first.session)
          yield* sandbox.activity(first.session.id)
          yield* Effect.forkScoped(Effect.sleep("5 seconds").pipe(Effect.andThen(heartbeat(current)), Effect.forever))
          for (const version of versions) yield* publishSource(first.session.id, version.sourcePath, version.row.code)
          const snapshotID = randomUUID()
          yield* Effect.tryPromise({
            try: () =>
              rpc(current, "snapshot-acquire", {
                snapshotID,
                manifests: versions.map((version) => ({
                  versionHash: version.manifest.versionHash,
                  manifestHash: version.manifest.manifestHash,
                })),
              }),
            catch: failure,
          })
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise({ try: () => rpc(current, "snapshot-release", { snapshotID }), catch: failure }).pipe(
              Effect.ignore,
            ),
          )
          return {
            ...snapshot,
            execute: (input) =>
              snapshot.execute(input).pipe(Effect.provideService(RequestLease, { connection: current, snapshotID })),
          }
        }),
      load: (session, row) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* prepare(session)
            yield* sandbox.activity(session.id)
            yield* Effect.forkScoped(
              Effect.sleep("5 seconds").pipe(Effect.andThen(heartbeat(connection)), Effect.forever),
            )
            const version = versionHash(row.code)
            const sourcePath = `/workspace/.opencode/.session-tools/${session.id}/${version}/source.ts`
            yield* publishSource(session.id, sourcePath, row.code)
            const manifest = yield* Effect.tryPromise({
              try: async () => {
                const response = await rpc(connection, "discover", { versionHash: version, sourcePath })
                return Schema.decodeUnknownSync(Manifest)(await response.json())
              },
              catch: failure,
            })
            const info: Tool.Info = {
              name: row.name,
              description: manifest.description,
              input: manifest.inputSchema as Tool.ValueSchema,
              output: manifest.outputSchema as Tool.ValueSchema,
              options: { codemode: false },
              execute: (args, context) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    const lease = Option.getOrUndefined(yield* Effect.serviceOption(RequestLease))
                    if (!lease)
                      return yield* Effect.fail(
                        new Error("Session Tool execution requires a model-request snapshot lease"),
                      )
                    const { connection: current, snapshotID } = lease
                    const executionID = createHash("sha256")
                      .update(`${context.sessionID}:${context.messageID}:${context.id}`)
                      .digest("hex")
                    const cancelled = Effect.tryPromise({
                      try: () => rpc(current, "cancel", { executionID }),
                      catch: failure,
                    }).pipe(Effect.ignore)
                    return yield* Effect.tryPromise({
                      try: async (signal) => {
                        const response = await Effect.runPromise(
                          gate.admit(session.id, current.envelope.sandboxID, (epoch) => {
                            if (epoch !== current.envelope.lifecycleEpoch)
                              return Effect.fail(new Error("Session tool lifecycle changed"))
                            return Effect.tryPromise({
                              try: () =>
                                rpc(
                                  current,
                                  "execute",
                                  {
                                    snapshotID,
                                    executionID,
                                    versionHash: version,
                                    manifestHash: manifest.manifestHash,
                                    sourcePath,
                                    args,
                                    context: {
                                      sessionID: context.sessionID,
                                      messageID: context.messageID,
                                      id: context.id,
                                      agent: context.agent,
                                    },
                                    deadlineMs: 60_000,
                                  },
                                  signal,
                                ),
                              catch: failure,
                            })
                          }),
                        )
                        try {
                          return await consume(current, response, executionID, context)
                        } catch (error) {
                          if (signal.aborted || error instanceof HostError) throw error
                          // A lost stream is never permission to replay a side-effecting tool.
                          const status = (await rpc(current, "status", { executionID })
                            .then((response) => response.json())
                            .catch(() => undefined)) as
                            | { terminal?: { type: string; result?: Tool.Result; code?: string; message?: string } }
                            | undefined
                          if (status?.terminal?.type === "result" && status.terminal.result)
                            return status.terminal.result
                          if (status?.terminal?.type === "error")
                            throw new HostError(
                              status.terminal.code ?? "result-unknown",
                              status.terminal.message ?? "Tool failed",
                            )
                          throw new HostError(
                            "result-unknown",
                            "Session Tool execution stream was lost; execution was not replayed",
                          )
                        }
                      },
                      catch: failure,
                    }).pipe(Effect.onInterrupt(() => cancelled))
                  }),
                ).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
            } satisfies Tool.Info
            captured.set(info, { session, row, manifest, sourcePath })
            return info
          }),
        ),
      release: (sessionID, scope = "session") => {
        const connection = connections.get(sessionID)
        return Effect.gen(function* () {
          let current = connection
          // A different SaaS instance may own the live worker. Teardown must not depend on local caches.
          if (!current && sandbox.enabled) {
            const resolved = yield* sandbox.endpoint(sessionID, port, true)
            if (resolved._tag !== "resolved") return
            const endpoint = resolved.endpoint.replace(/\/$/, "")
            const health = yield* Effect.tryPromise({
              try: async () => {
                const response = await fetch(`${SandboxEndpoint.httpUrl(endpoint)}${prefix}health`, { headers: resolved.headers, signal: AbortSignal.timeout(2000) })
                if (!response.ok) throw new Error(`Host health HTTP ${response.status}`)
                return (await response.json()) as { hostEpoch: string; sandboxID: string }
              },
              catch: failure,
            })
            current = {
              endpoint,
              headers: resolved.headers,
              envelope: {
                protocolVersion,
                sandboxID: health.sandboxID,
                hostEpoch: health.hostEpoch,
                ownerID,
                ownerLeaseID: "",
                logicalSessionID: sessionID,
                lifecycleEpoch: 1,
                generation: 1,
              },
            }
          }
          if (current) yield* Effect.tryPromise({ try: () => rpc(current, "release", { scope }), catch: failure })
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Session Tool Host release failed", { sessionID, scope, error: error.message }),
          ),
        )
      },
    })
  }),
)
export const node = makeLocationNode({ service: Service, layer, deps: [SandboxProvider.node, Database.node] })
