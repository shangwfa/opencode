import { randomBytes, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Glob } from "@opencode/util/glob"
import { APIError, FileSystem, Sandbox, Snapshot } from "@vercel/sandbox"
import { and, eq, sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import { Database } from "../../database/database.js"
import { SessionTable } from "../../session/sql.js"
import { SessionSchema } from "../../session/schema.js"
import { SessionToolGate } from "../../session/tool-gate.js"
import { SandboxTable, SandboxCommandTable } from "../sql.js"
import { SandboxPath } from "../path.js"
import { rootSessionID, type Interface, type RunInput } from "../contract.js"
import type { SandboxConfig } from "../config.js"
import * as CreateLease from "../lifecycle/create-lease.js"
import { resume, type ActiveConnection } from "./client.js"
import * as Commands from "./command.js"
import * as PortGate from "./port-gate.js"
import { singleSubmissionFetch, type Transport } from "./transport.js"

const attempt = <A>(run: (signal: AbortSignal) => Promise<A>) => Effect.tryPromise({
  try: run,
  catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
})
const missing = (error: unknown) => error instanceof APIError && error.response.status === 404
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT"
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`

export function resources(cpu: string, memory: string) {
  const vcpus = Number(cpu)
  const size = /^(\d+)(Gi|Mi)$/.exec(memory)
  const mb = size ? Number(size[1]) * (size[2] === "Gi" ? 1024 : 1) : NaN
  if (!Number.isSafeInteger(vcpus) || vcpus < 1 || vcpus > 32 || mb !== vcpus * 2048) {
    throw new Error("Vercel resources require an integer vCPU count and exactly 2 GiB memory per vCPU")
  }
  return { vcpus }
}

export const make = (config: SandboxConfig.Config, rawTransport?: Transport) => Effect.gen(function* () {
  const credentials = config.vercel
  if (!credentials) return yield* Effect.die(new Error("Vercel credentials are not configured"))
  const { db } = yield* Database.Service
  const scope = `${credentials.teamId}/${credentials.projectId}`
  const fetch = singleSubmissionFetch(rawTransport)
  const connection = (name: string) => ({ ...credentials, name, fetch })
  const gate = SessionToolGate.make(db)
  const leaseMs = (config.createTimeoutSeconds + 60) * 1000
  const lease = (database: Parameters<typeof CreateLease.create>[0]["db"] = db) => CreateLease.create({ db: database, host: "api.vercel.com", provider: "vercel", providerScope: scope, leaseMs })
  const locks = new Map<string, Semaphore.Semaphore>()
  const key = (sessionID: string) => rootSessionID(sessionID, (id) => db
    .select({ parentID: SessionTable.parent_id }).from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(id))).get().pipe(Effect.orDie))
  const row = (sessionID: string) => db.select().from(SandboxTable)
    .where(eq(SandboxTable.session_id, sessionID)).get().pipe(Effect.orDie)
  const current = (sessionID: string, id: string) => and(
    eq(SandboxTable.session_id, sessionID), eq(SandboxTable.provider, "vercel"), eq(SandboxTable.id, id),
  )
  const check = (record: typeof SandboxTable.$inferSelect | undefined) => {
    if (record && (record.provider !== "vercel" || (record.provider_scope && record.provider_scope !== scope))) {
      throw new Error("Sandbox binding belongs to a different provider or Vercel project")
    }
  }
  const sessionResource = (sessionID: string) => db.select({ sandbox: SessionTable.sandbox })
    .from(SessionTable).where(eq(SessionTable.id, SessionSchema.ID.make(sessionID))).get().pipe(Effect.orDie)
  const readActive = (record: typeof SandboxTable.$inferSelect) => attempt(async (signal) => {
    check(record)
    if (!record.remote_name) throw new Error("Vercel binding has no remote name")
    const sandbox = await Sandbox.get({ ...connection(record.remote_name), resume: false, signal })
    const session = sandbox.currentSession()
    if (session.sessionId !== record.id || session.status !== "running") throw new Error("Vercel running generation changed")
    return { sandbox, session, generation: session.sessionId } satisfies ActiveConnection
  })

  const bootImpl = Effect.fn("VercelSandbox.boot")(function* (sessionID: string): Effect.fn.Return<ActiveConnection, Error> {
    const until = Date.now() + leaseMs
    while (Date.now() < until) {
      const prior = yield* row(sessionID)
      yield* Effect.try({ try: () => check(prior), catch: (error) => error instanceof Error ? error : new Error(String(error)) })
      if (prior?.state === "running") {
        const sandbox = yield* attempt((signal) => Sandbox.get({ ...connection(prior.remote_name ?? ""), resume: false, signal }))
        const session = sandbox.currentSession()
        if (session.status === "running" && session.sessionId === prior.id) {
          yield* gate.booted(sessionID, prior.id)
          return { sandbox, session, generation: prior.id }
        }
        // No command has been submitted: a stopped VM may be resumed under the creation lease.
        if (session.status !== "stopped") return yield* Effect.fail(new Error("Vercel generation requires reconciliation"))
        yield* db.update(SandboxTable).set({ state: "destroyed" }).where(current(sessionID, prior.id)).run().pipe(Effect.orDie)
      }
      const claim = yield* gate.creating(sessionID, (tx) => lease(tx).claim(sessionID))
      if (claim._tag !== "claimed") { yield* Effect.sleep("250 millis"); continue }
      const create = Effect.gen(function* () {
        const record = yield* row(sessionID)
        if (!record) return yield* Effect.fail(new Error("Vercel creation intent disappeared"))
        const resource = (yield* sessionResource(sessionID))?.sandbox
        if (resource?.persistMode === "pvc") return yield* Effect.fail(new Error("Vercel does not support PVC persistence"))
        const spec = yield* Effect.try({
          try: () => resources(resource?.cpu ?? config.resource.cpu, resource?.memory ?? config.resource.memory),
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        })
        let active: ActiveConnection
        if (record.remote_name) {
          // Never getOrCreate: a missing saved workspace must not become a fresh checkout.
          active = yield* attempt((signal) => resume({ ...connection(record.remote_name ?? ""), signal }))
        } else {
          const name = `oc-${randomUUID().replaceAll("-", "")}`
          const intent = yield* db.update(SandboxTable).set({ remote_name: name, provider_scope: scope, endpoint_token: randomBytes(18).toString("base64url") })
            .where(current(sessionID, CreateLease.creatingID(claim.owner))).returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
          if (!intent.length) return yield* Effect.fail(new Error("Vercel creation lease lost before dispatch"))
          const sandbox = yield* attempt((signal) => Sandbox.create({
            ...connection(name), resources: spec, image: resource?.image || credentials.image,
            timeout: config.timeoutSeconds * 1000, persistent: resource?.persistMode !== "none",
            ports: PortGate.INITIAL_GATE_PORTS,
            snapshotExpiration: config.snapshot.ttlMs, keepLastSnapshots: { count: 1, deleteEvicted: true },
            signal,
          }))
          active = { sandbox, session: sandbox.currentSession(), generation: sandbox.currentSession().sessionId }
        }
        const prepared = yield* attempt((signal) => active.session.runCommand({
          cmd: "sh", args: ["-c", "mkdir -p /workspace && chmod 0777 /workspace"], sudo: true, timeoutMs: 10_000, signal,
        }))
        if (prepared.exitCode !== 0) return yield* Effect.fail(new Error("Vercel workspace initialization failed"))
        // Runner/gate assets must exist before any service launcher references them.
        yield* ensureAssets(active)
        const saved = yield* gate.creating(sessionID, (tx) => lease(tx).complete(sessionID, claim.owner, active.generation))
        if (!saved) return yield* Effect.fail(new Error("Vercel creation lease lost; remote workspace retained for reconciliation"))
        yield* gate.booted(sessionID, active.generation)
        return active
      }).pipe(
        Effect.tapError(() => lease().release(sessionID, claim.owner)),
      )
      const heartbeat = Effect.sleep("10 seconds").pipe(Effect.andThen(lease().heartbeat(sessionID, claim.owner)), Effect.forever)
      return yield* Effect.raceFirst(create, heartbeat)
    }
    return yield* Effect.fail(new Error("Vercel sandbox creation lease wait timed out"))
  })
  const boot = (sessionID: string) => bootImpl(sessionID).pipe(Effect.timeout(leaseMs))

  const touch = Effect.fn("VercelSandbox.touch")(function* (sessionID: string, active: ActiveConnection) {
    const changed = yield* db.update(SandboxTable).set({ time_updated: sql`max(${SandboxTable.time_updated}, ${Date.now()})` })
      .where(and(current(sessionID, active.generation), eq(SandboxTable.state, "running")))
      .returning({ id: SandboxTable.id, keepAlive: SandboxTable.keep_alive }).all().pipe(Effect.orDie)
    if (!changed.length) return yield* Effect.fail(new Error("Vercel sandbox generation is no longer running"))
    const remaining = active.sandbox.expiresAt?.getTime()
    if (!remaining || remaining - Date.now() < Math.min(config.timeoutSeconds * 500, 120_000)) {
      yield* attempt((signal) => active.session.extendTimeout(config.timeoutSeconds * 1000, { signal }))
    }
  })

  const interrupt = Effect.fn("VercelSandbox.interrupt")(function* (sessionID: string, operationID?: string) {
    const record = yield* row(sessionID)
    if (!record?.remote_name || record.state === "destroyed") return
    const active = yield* readActive(record)
    const commands = yield* db.select().from(SandboxCommandTable).where(and(
      eq(SandboxCommandTable.session_id, sessionID), eq(SandboxCommandTable.sandbox_id, record.id),
      ...(operationID ? [eq(SandboxCommandTable.operation_id, operationID)] : []),
    )).all().pipe(Effect.orDie)
    for (const command of commands) {
      yield* attempt((signal) => Commands.cancel(active, {
        sandboxName: active.sandbox.name, generation: record.id, commandID: command.command_id,
      }, { signal }))
    }
  })

  const destroy = Effect.fn("VercelSandbox.destroy")(function* (sessionID: string) {
    const record = yield* row(sessionID)
    if (!record || record.state === "destroyed") return
    check(record)
    if (record.state === "creating") return yield* Effect.fail(new Error("Vercel sandbox is still being created"))
    if (record.state === "snapshotting" && record.time_updated > Date.now() - leaseMs) {
      return yield* Effect.fail(new Error("Vercel stop is already in progress"))
    }
    const stamp = Math.max(Date.now(), record.time_updated + 1)
    const claimed = yield* db.update(SandboxTable).set({ state: "snapshotting", time_updated: sql`max(${SandboxTable.time_updated} + 1, ${stamp})` })
      .where(and(current(sessionID, record.id), eq(SandboxTable.state, record.state),
        ...(record.state === "snapshotting" ? [eq(SandboxTable.time_updated, record.time_updated)] : [])))
      .returning({ id: SandboxTable.id, stamp: SandboxTable.time_updated }).all().pipe(Effect.orDie)
    if (!claimed.length) return yield* Effect.fail(new Error("Vercel stop generation changed"))
    const closure = yield* gate.close(sessionID, true, record.id)
    if (!closure) return yield* Effect.fail(new Error("Vercel stop gate could not be closed"))
    // Stop addresses the captured VM, never an auto-resumed replacement.
    yield* attempt(async (signal) => {
      const sandbox = await Sandbox.get({ ...connection(record.remote_name ?? ""), resume: false, signal })
      if (sandbox.currentSession().sessionId !== record.id) throw new Error("Vercel stop generation mismatch")
      const stopped = await sandbox.stop({ signal })
      if (sandbox.persistent && stopped.snapshot?.status !== "created") throw new Error("Vercel stop did not preserve the workspace snapshot")
    })
    const stopped = yield* db.update(SandboxTable).set({ state: "destroyed", time_updated: Date.now() })
      .where(and(current(sessionID, record.id), eq(SandboxTable.state, "snapshotting"), eq(SandboxTable.time_updated, claimed[0].stamp)))
      .returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (stopped.length) {
      yield* gate.destroyed(sessionID, closure)
      yield* db.delete(SandboxCommandTable).where(and(eq(SandboxCommandTable.session_id, sessionID), eq(SandboxCommandTable.sandbox_id, record.id))).run().pipe(Effect.orDie)
    }
  })

  const setKeepAlive = (sessionID: string, keep_alive: boolean) => Effect.gen(function* () {
    const record = yield* row(sessionID)
    check(record)
    const updated = yield* db.insert(SandboxTable).values({
    id: `pending-${sessionID}`, session_id: sessionID, host: "api.vercel.com", provider: "vercel", provider_scope: scope,
    state: "destroyed", keep_alive,
  }).onConflictDoUpdate({ target: SandboxTable.session_id, set: { keep_alive },
    setWhere: and(eq(SandboxTable.provider, "vercel"), eq(SandboxTable.provider_scope, scope)),
    }).returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (!updated.length) return yield* Effect.die(new Error("Vercel keep-alive scope changed"))
  })

  const run = Effect.fn("VercelSandbox.run")(function* (input: RunInput) {
    const sessionID = yield* key(input.sessionID)
    const active = yield* boot(sessionID)
    yield* touch(sessionID, active)
    const id = randomUUID()
    const file = `/workspace/.opencode/output/${id}.log`
    const command = `mkdir -p /workspace/.opencode/output && set -o pipefail; (\n${input.command}\n) 2>&1 | tee ${quote(file)}; exit "\${PIPESTATUS[0]}"`
    const task = yield* gate.admit(input.sessionID, active.generation, () => Effect.gen(function* () {
      const task = yield* attempt((signal) => Commands.start(active, {
        cmd: "bash", args: ["-lc", command], timeoutMs: 0,
        cwd: input.cwd ? SandboxPath.toSandboxCwd(input.cwd, input.hostWorkdir) : "/workspace", signal,
      }))
      yield* db.insert(SandboxCommandTable).values({ id, session_id: sessionID, sandbox_id: active.generation,
        command_id: task.commandID, operation_id: input.operationID ?? id }).run().pipe(Effect.orDie)
      return task
    }))
    let completed = false
    let cancellationConfirmed = true
    const observe = attempt((signal) => Commands.observe(active, task, { maxBytes: 1024 * 1024, signal })).pipe(
      Effect.tap(() => Effect.sync(() => { completed = true })),
      Effect.ensuring(Effect.gen(function* () {
        if (!completed) {
          const cancelled = yield* attempt((signal) => Commands.cancel(active, task, { signal })).pipe(Effect.result)
          if (cancelled._tag === "Failure") {
            cancellationConfirmed = false
            yield* Effect.logWarning("Vercel command cancellation unconfirmed; PG command retained", { sessionID, commandID: task.commandID })
            return
          }
        }
        yield* db.delete(SandboxCommandTable).where(eq(SandboxCommandTable.id, id)).run().pipe(Effect.orDie)
      })),
      Effect.map((result) => ({ exitCode: result.exitCode, timedOut: false, truncated: result.truncated,
        output: result.truncated ? `${result.output}\nFull output: ${file}` : result.output })),
    )
    const execution = input.timeoutMs && input.timeoutMs > 0 ? observe.pipe(Effect.timeoutOrElse({
      duration: input.timeoutMs,
      orElse: () => Effect.succeed({ exitCode: null, timedOut: true, truncated: true, output: `Command timed out.${cancellationConfirmed ? "" : " Remote cancellation is unconfirmed; operation remains recorded."} Full output: ${file}` }),
    })) : observe
    const heartbeat = Effect.sleep("10 seconds").pipe(Effect.andThen(touch(sessionID, active)), Effect.forever)
    return yield* Effect.raceFirst(execution, heartbeat)
  })

  const files = <A>(sessionID: string, operation: (fs: FileSystem, signal: AbortSignal) => Promise<A>) => Effect.gen(function* () {
    const id = yield* key(sessionID)
    const active = yield* boot(id)
    yield* touch(id, active)
    return yield* gate.admit(sessionID, active.generation, () => attempt((signal) => operation(new FileSystem(active.session), signal)).pipe(Effect.timeout(config.filesTimeoutSeconds * 1000)))
  })
  const nullable = async <A>(operation: () => Promise<A>): Promise<A | null> => {
    try { return await operation() } catch (error) { if (absent(error)) return null; throw error }
  }
  const connectedRow = (sessionID: string) => Effect.flatMap(key(sessionID), row).pipe(Effect.tap((record) => Effect.sync(() => check(record))))
  const unsupported = (feature: string) => Effect.fail(new Error(`Vercel ${feature} is not enabled in this provider`))
  const ready = (sessionID: string) => Effect.gen(function* () {
    const record = yield* connectedRow(sessionID)
    if (!record || record.state !== "running") return false
    return yield* readActive(record).pipe(Effect.as(true), Effect.timeout(3000), Effect.catch(() => Effect.succeed(false)))
  })

  /**
   * Public routes need an in-sandbox gate in front of every internal service;
   * the optional Code Mode runner bundle is copied into place once because the
   * stock Vercel image does not carry the sandbox image's /opt tooling.
   */
  const ensureAssets = (active: ActiveConnection) => Effect.gen(function* () {
    const fs = new FileSystem(active.session)
    // The stock Vercel image omits ripgrep, so glob/grep would fail for every
    // session. Install it once per sandbox generation (snapshots retain it).
    if (config.vercel?.installRipgrep !== false) {
      const probe = yield* attempt((signal) => active.session.runCommand({ cmd: "sh", args: ["-c", "command -v rg"], timeoutMs: 10_000, signal }))
      if (probe.exitCode !== 0) {
        const installed = yield* attempt((signal) => active.session.runCommand({
          cmd: "sh",
          args: ["-c", "sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep"],
          timeoutMs: 180_000,
          signal,
        }))
        if (installed.exitCode !== 0)
          yield* Effect.logWarning("Vercel sandbox lacks ripgrep and installation failed", { exitCode: installed.exitCode })
      }
    }
    const gateReady = yield* attempt((signal) => fs.stat(PortGate.path, { signal })).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)))
    if (!gateReady) {
      yield* attempt((signal) => fs.mkdir("/workspace/.opencode/.port-gate", { recursive: true, signal }))
      yield* attempt((signal) => fs.writeFile(PortGate.path, PortGate.script, { signal }))
    }
    const asset = config.vercel?.runnerAsset
    if (!asset) return
    const installed = yield* attempt((signal) => active.session.runCommand({ cmd: "sh", args: ["-c", "test -f /opt/opencode-codemode-runner.mjs"], timeoutMs: 10_000, signal }))
    if (installed.exitCode === 0) return
    const packed = yield* Effect.tryPromise({
      try: () => readFile(asset),
      catch: (cause) => new Error(`Vercel Code Mode runner asset is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`),
    })
    yield* attempt((signal) => fs.writeFile("/workspace/.opencode/.port-gate/codemode-runner.mjs.gz", packed, { signal }))
    const install = yield* attempt((signal) => active.session.runCommand({
      cmd: "sh",
      args: ["-c", "gunzip -c /workspace/.opencode/.port-gate/codemode-runner.mjs.gz > /tmp/opencode-codemode-runner.mjs && sudo install -m 0755 /tmp/opencode-codemode-runner.mjs /opt/opencode-codemode-runner.mjs"],
      timeoutMs: 60_000, signal,
    }))
    if (install.exitCode !== 0) return yield* Effect.fail(new Error("Vercel Code Mode runner installation failed"))
  })

  // The remote update replaces all ports. Lock the PG generation and re-read
  // remote routes inside that lock so replicas cannot overwrite each other.
  const ensurePort = (record: typeof SandboxTable.$inferSelect, gatePort: number) =>
    db.transaction((tx) =>
      Effect.gen(function* () {
        const locked = yield* tx.update(SandboxTable).set({ time_updated: sql`${SandboxTable.time_updated}` })
          .where(and(current(record.session_id, record.id), eq(SandboxTable.state, "running")))
          .returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
        if (!locked.length) return yield* Effect.fail(new Error("Vercel port registration generation changed"))
        const active = yield* readActive(record)
        if (!active.sandbox.routes.some((route) => route.port === gatePort)) {
          const ports = PortGate.withGatePort(active.sandbox.routes.map((route) => route.port), gatePort)
          yield* attempt((signal) => active.sandbox.update({ ports }, { signal }))
        }
        return active
      }),
    )

  const endpointFor = Effect.fn("VercelSandbox.endpoint")(function* (sessionID: string, port: number) {
    const record = yield* connectedRow(sessionID)
    if (!record?.remote_name || record.state !== "running") return { _tag: "no-sandbox" } as const
    const gatePort = port + PortGate.GATE_OFFSET
    if (!Number.isInteger(port) || port < 1 || gatePort > 65_535) return { _tag: "resolve-failed" } as const
    let token = record.endpoint_token
    if (!token) {
      token = randomBytes(18).toString("base64url")
      const stored = yield* db.update(SandboxTable).set({ endpoint_token: token })
        .where(and(current(record.session_id, record.id), sql`${SandboxTable.endpoint_token} is null`))
        .returning({ token: SandboxTable.endpoint_token }).all().pipe(Effect.orDie)
      if (!stored.length) token = (yield* row(record.session_id))?.endpoint_token ?? token
    }
    const active = yield* ensurePort(record, gatePort)
    yield* ensureAssets(active)
    // The gate must be listening before the route URL is any use (addressability
    // is not readiness), so the idempotent launcher includes a readiness probe.
    yield* attempt((signal) => active.session.runCommand({
      cmd: "sh", args: ["-c", PortGate.startCommand({ listen: gatePort, target: port, token })], timeoutMs: 20_000, signal,
    }))
    yield* touch(record.session_id, active)
    const domain = yield* Effect.try({
      try: () => active.sandbox.domain(gatePort),
      catch: (cause) => new Error(`Vercel route for gate port ${gatePort} is missing: ${cause instanceof Error ? cause.message : String(cause)}`),
    })
    return { _tag: "resolved" as const, sandboxId: record.id, endpoint: `${domain.replace(/\/+$/, "")}${PortGate.TOKEN_PREFIX}${token}` }
  })

  const sweep = Effect.gen(function* () {
    const records = yield* db.select().from(SandboxTable).where(and(
      eq(SandboxTable.provider, "vercel"), eq(SandboxTable.provider_scope, scope),
    )).all().pipe(Effect.orDie)
    for (const record of records) {
      const work = Effect.gen(function* () {
        if (record.state === "snapshotting" && record.time_updated < Date.now() - leaseMs) {
          yield* destroy(record.session_id)
        } else if (record.state === "running") {
          if (config.idleReapSeconds > 0 && record.time_updated < Date.now() - config.idleReapSeconds * 1000) {
            yield* destroy(record.session_id)
          } else if (record.keep_alive) {
            const active = yield* readActive(record)
            const remaining = active.sandbox.expiresAt?.getTime()
            if (!remaining || remaining - Date.now() < 120_000) {
              yield* attempt((signal) => active.session.extendTimeout(config.timeoutSeconds * 1000, { signal }))
            }
          }
        }
      }).pipe(Effect.catch((error) => Effect.logWarning("Vercel lifecycle reconciliation failed", { sessionID: record.session_id, error: error.message })))
      yield* work
    }
  })
  yield* Effect.forkScoped(sweep.pipe(Effect.andThen(Effect.sleep("15 seconds")), Effect.forever))

  const provider: Interface = {
    enabled: true,
    boot: (sessionID) => Effect.flatMap(key(sessionID), (id) => Effect.map(boot(id), (active) => active.generation)).pipe(Effect.timeout(leaseMs)),
    run: (input) => Effect.flatMap(key(input.sessionID), (sessionID) => Effect.suspend(() => {
      if (input.isolated || input.detached) return run(input)
      let lock = locks.get(sessionID)
      if (!lock) { lock = Semaphore.makeUnsafe(1); locks.set(sessionID, lock) }
      return lock.withPermits(1)(run(input))
    })),
    interrupt: (sessionID, operationID) => Effect.flatMap(key(sessionID), (id) => interrupt(id, operationID)).pipe(Effect.orDie),
    destroy: (sessionID) => Effect.flatMap(key(sessionID), destroy).pipe(Effect.orDie),
    keepAlive: (sessionID) => Effect.flatMap(key(sessionID), (id) => setKeepAlive(id, true)),
    release: (sessionID) => Effect.flatMap(key(sessionID), (id) => setKeepAlive(id, false).pipe(Effect.andThen(destroy(id)))).pipe(Effect.orDie),
    activity: (sessionID) => Effect.gen(function* () {
      const id = yield* key(sessionID)
      const record = yield* row(id)
      if (!record || record.state !== "running") return yield* Effect.die(new Error("Vercel sandbox is not running"))
      const active = yield* readActive(record)
      yield* touch(id, active)
      yield* Effect.forkScoped(Effect.sleep("5 seconds").pipe(Effect.andThen(touch(id, active)), Effect.forever))
    }).pipe(Effect.orDie),
    isKeepAlive: (sessionID) => connectedRow(sessionID).pipe(Effect.map((record) => record?.keep_alive ?? false)),
    sandboxId: (sessionID) => connectedRow(sessionID).pipe(Effect.map((record) => record?.state === "running" ? record.id : null)),
    lifecycle: (sessionID) => Effect.gen(function* () {
      const id = yield* key(sessionID)
      const record = yield* connectedRow(id)
      const resource = yield* sessionResource(id)
      return { sandboxID: record?.id ?? null, state: record?.state ?? null, persistMode: resource?.sandbox?.persistMode ?? "snapshot" }
    }),
    isReady: ready,
    endpoint: (sessionID, port) => Effect.flatMap(key(sessionID), (id) => endpointFor(id, port))
      .pipe(Effect.catch(() => Effect.succeed({ _tag: "resolve-failed" } as const))),
    snapshot: () => unsupported("online snapshots"),
    latestSnapshot: () => unsupported("snapshot catalog"),
    snapshotStats: () => unsupported("snapshot statistics"),
    deleteSnapshots: (sessionID) => Effect.gen(function* () {
      const record = yield* connectedRow(sessionID)
      if (!record?.remote_name || !config.snapshot.deleteEnabled) return
      const name = record.remote_name
      yield* attempt(async (signal) => {
        const snapshots = await Snapshot.list({ ...connection(name), limit: 50, signal })
        for await (const snapshot of snapshots) {
          if (snapshot.status !== "deleted") await (await Snapshot.get({ ...connection(name), snapshotId: snapshot.id, signal })).delete({ signal })
        }
      })
    }).pipe(Effect.orDie),
    purge: (sessionID) => Effect.gen(function* () {
      const record = yield* connectedRow(sessionID)
      if (!record?.remote_name) return
      if (record.state !== "destroyed") return yield* Effect.fail(new Error("Stop Vercel sandbox before permanent removal"))
      yield* attempt(async (signal) => {
        try {
          const sandbox = await Sandbox.get({ ...connection(record.remote_name ?? ""), resume: false, signal })
          await sandbox.delete({ deleteOrphanSnapshots: config.snapshot.deleteEnabled, signal })
        } catch (error) { if (!missing(error)) throw error }
      })
      yield* db.update(SandboxTable).set({ remote_name: null, endpoint_token: null }).where(current(record.session_id, record.id)).run().pipe(Effect.orDie)
      locks.delete(record.session_id)
    }).pipe(Effect.orDie),
    fileStat: (sessionID, target) => files(sessionID, async (fs, signal) => {
      const stat = await nullable(() => fs.stat(target, { signal }))
      return stat ? { isDirectory: stat.isDirectory(), size: stat.size } : null
    }),
    fileRead: (sessionID, target) => files(sessionID, async (fs, signal) => {
      const stat = await nullable(() => fs.stat(target, { signal }))
      if (!stat) return null
      if (stat.size > 32 * 1024 * 1024) throw new Error("Vercel file exceeds 32 MiB read limit")
      return fs.readFile(target, { encoding: "utf8", signal })
    }),
    fileReadBytes: (sessionID, target, options) => files(sessionID, async (fs, signal) => {
      const stat = await nullable(() => fs.stat(target, { signal }))
      if (!stat) return null
      if (stat.size > 32 * 1024 * 1024) throw new Error("Vercel file exceeds 32 MiB read limit")
      const data = await fs.readFile(target, { signal })
      if (!options?.range) return data
      const range = /^bytes=(\d*)-(\d*)$/.exec(options.range)
      if (!range || (!range[1] && !range[2])) throw new Error("Invalid byte range")
      const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]))
      const end = range[1] && range[2] ? Number(range[2]) + 1 : data.length
      if (start >= data.length || end <= start) throw new Error("Unsatisfiable byte range")
      return data.subarray(start, Math.min(end, data.length))
    }),
    fileWrite: (sessionID, target, data) => files(sessionID, async (fs, signal) => {
      await fs.mkdir(path.posix.dirname(target), { recursive: true, signal })
      await fs.writeFile(target, data, { signal })
    }),
    fileDelete: (sessionID, target) => files(sessionID, (fs, signal) => fs.rm(target, { recursive: true, force: true, signal })),
    fileList: (sessionID, target) => files(sessionID, async (fs, signal) => (await fs.readdir(target, { withFileTypes: true, signal })).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))),
    fileFind: (sessionID, target, query) => files(sessionID, async (fs, signal) => {
      const found: { path: string; isDirectory: boolean }[] = []
      const pending = [target]
      while (pending.length && found.length < 1000) {
        const dir = pending.shift()
        if (!dir) break
        for (const entry of await fs.readdir(dir, { withFileTypes: true, signal })) {
          const file = path.posix.join(dir, entry.name)
          if (Glob.match(query, entry.name)) found.push({ path: file, isDirectory: entry.isDirectory() })
          if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) pending.push(file)
        }
      }
      return found
    }),
  }
  return provider
})
