import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { FileNotFoundError, SandboxNotFoundError } from "e2b"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Glob } from "@opencode/util/glob"
import { Database } from "../../database/database.js"
import { SessionTable } from "../../session/sql.js"
import { SessionSchema } from "../../session/schema.js"
import { SessionToolGate } from "../../session/tool-gate.js"
import { SandboxTable, SandboxCommandTable, AliyunSnapshotTable as Snapshots } from "../sql.js"
import { SandboxPath } from "../path.js"
import { rootSessionID, type Interface, type RunInput } from "../contract.js"
import type { SandboxConfig } from "../config.js"
import * as CreateLease from "../lifecycle/create-lease.js"
import { client, type Api, type Remote } from "./client.js"

type Active = Remote & { readonly generation: string }
type ReapCandidate = Pick<typeof SandboxTable.$inferSelect, "id" | "state" | "time_updated">

const attempt = <A>(run: () => Promise<A>) => Effect.tryPromise({
  try: run, catch: (error) => error instanceof Error ? error : new Error(String(error)),
})
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const nullable = async <A>(run: () => Promise<A>): Promise<A | null> => {
  try { return await run() } catch (error) { if (error instanceof FileNotFoundError) return null; throw error }
}

export function byteRange(data: Uint8Array, range?: string) {
  if (!range) return data
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid byte range")
  const first = match[1] ? Number(match[1]) : Math.max(0, data.length - Number(match[2]))
  const last = match[1] && match[2] ? Number(match[2]) + 1 : data.length
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first >= data.length || last <= first)
    throw new Error("Unsatisfiable byte range")
  return data.subarray(first, Math.min(last, data.length))
}

export const make = (config: SandboxConfig.Config, supplied?: Api) => Effect.gen(function* () {
  const settings = config.aliyun
  if (!settings) return yield* Effect.die(new Error("Aliyun sandbox credentials are not configured"))
  const api = supplied ?? client(settings, config.createTimeoutSeconds * 1000)
  const { db } = yield* Database.Service
  const gate = SessionToolGate.make(db)
  const scope = settings.apiUrl
  const leaseMs = (config.createTimeoutSeconds + 60) * 1000
  const lease = (database: unknown = db) => CreateLease.create({ db: database, host: settings.domain, provider: "aliyun", providerScope: scope, leaseMs })
  const key = (id: string) => rootSessionID(id, (id) => db.select({ parentID: SessionTable.parent_id }).from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(id))).get().pipe(Effect.orDie))
  const row = (id: string) => db.select().from(SandboxTable).where(eq(SandboxTable.session_id, id)).get().pipe(Effect.orDie)
  const current = (id: string, remote: string) => and(eq(SandboxTable.session_id, id), eq(SandboxTable.provider, "aliyun"), eq(SandboxTable.provider_scope, scope), eq(SandboxTable.id, remote))
  const check = (record: typeof SandboxTable.$inferSelect | undefined) => {
    if (record && (record.provider !== "aliyun" || record.provider_scope !== scope)) throw new Error("Aliyun sandbox binding belongs to another provider or endpoint")
  }
  const bound = (id: string) => key(id).pipe(Effect.flatMap(row), Effect.tap((record) => Effect.sync(() => check(record))))
  const resource = (id: string) => db.select({ sandbox: SessionTable.sandbox }).from(SessionTable)
    .where(eq(SessionTable.id, SessionSchema.ID.make(id))).get().pipe(Effect.orDie)
  const persistent = (id: string) => resource(id).pipe(Effect.map((value) => value?.sandbox?.persistMode === "snapshot"))
  const snapshots = (id: string) => db.select().from(Snapshots)
    .where(and(eq(Snapshots.session_id, id), eq(Snapshots.provider_scope, scope)))
    .orderBy(desc(Snapshots.time_created), desc(Snapshots.id)).all().pipe(Effect.orDie)
  const prepare = (remote: Remote) => Effect.gen(function* () {
    const run = (command: string) => attempt(async () => {
      const task = await remote.start(command, { user: "root", timeoutMs: 120_000 })
      return task.wait()
    })
    const initialized = yield* run("mkdir -p /workspace && chmod 0777 /workspace")
    if (initialized.exitCode !== 0) return yield* Effect.fail(new Error("Aliyun workspace initialization failed"))
    if (settings.installRipgrep !== false) {
      const installed = yield* run("command -v rg >/dev/null 2>&1 || (DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep)")
      if (installed.exitCode !== 0) return yield* Effect.fail(new Error("Aliyun ripgrep installation failed; use a template with ripgrep preinstalled"))
    }
    if (!settings.runnerAsset) return
    const exists = yield* run("test -f /opt/opencode-codemode-runner.mjs")
    if (exists.exitCode === 0) return
    const asset = yield* attempt(() => readFile(settings.runnerAsset ?? ""))
    yield* attempt(() => remote.mkdir("/workspace/.opencode"))
    yield* attempt(() => remote.write("/workspace/.opencode/runner.b64", asset.toString("base64")))
    const installed = yield* run("mkdir -p /opt && base64 -d /workspace/.opencode/runner.b64 | gzip -dc > /opt/opencode-codemode-runner.mjs && rm -f /workspace/.opencode/runner.b64 && chmod 0755 /opt/opencode-codemode-runner.mjs")
    if (installed.exitCode !== 0) return yield* Effect.fail(new Error("Aliyun Code Mode runner installation failed"))
  })
  const info = (id: string) => attempt(() => api.info(id))
  const inspect = (id: string) => info(id).pipe(Effect.catch((error) =>
    error instanceof SandboxNotFoundError ? Effect.succeed(null) : Effect.fail(error)))
  const retireGone = (record: typeof SandboxTable.$inferSelect) => Effect.gen(function* () {
    const saved = (yield* snapshots(record.session_id))[0]
    const lost = (yield* persistent(record.session_id)) && (!saved?.snapshot_id || saved.state !== "ready")
    const closure = yield* gate.close(record.session_id, true, record.id)
    if (!closure) return false
    const changed = yield* db.update(SandboxTable).set({ state: "destroyed", time_updated: Date.now(),
      remote_name: lost ? `lost:${record.remote_name ?? record.id}` : null, endpoint_token: null, command_session_id: null,
    }).where(and(current(record.session_id, record.id), eq(SandboxTable.state, record.state), eq(SandboxTable.time_updated, record.time_updated)))
      .returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (!changed.length) {
      yield* gate.retained(record.session_id, closure)
      return false
    }
    yield* gate.destroyed(record.session_id, closure)
    yield* db.delete(SandboxCommandTable).where(and(eq(SandboxCommandTable.session_id, record.session_id), eq(SandboxCommandTable.sandbox_id, record.id))).run().pipe(Effect.orDie)
    return true
  })
  const touch = (id: string, remote: Active) => Effect.gen(function* () {
    const changed = yield* db.update(SandboxTable).set({ time_updated: sql`max(${SandboxTable.time_updated} + 1, ${Date.now()})` })
      .where(and(current(id, remote.generation), eq(SandboxTable.state, "running"))).returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (!changed.length) return yield* Effect.fail(new Error("Aliyun sandbox generation is no longer running"))
    yield* attempt(() => remote.extend(config.timeoutSeconds * 1000))
  })
  const boot = Effect.fn("AliyunSandbox.boot")(function* (id: string): Effect.fn.Return<Active, Error> {
    const until = Date.now() + leaseMs
    while (Date.now() < until) {
      const prior = yield* row(id)
      yield* Effect.try({ try: () => check(prior), catch: (error) => error instanceof Error ? error : new Error(String(error)) })
      if (prior?.remote_name?.startsWith("lost:"))
        return yield* Effect.fail(new Error("Aliyun workspace disappeared without a confirmed snapshot; refusing an empty workspace. Explicit deletion is still available"))
      if (prior?.state === "running") {
        const status = yield* inspect(prior.remote_name ?? "")
        if (!status) {
          yield* retireGone(prior)
          continue
        }
        if (status.state === "running") {
          const remote = yield* attempt(() => api.connect(prior.remote_name ?? ""))
          if (!remote.token) return yield* Effect.fail(new Error("Aliyun traffic access token is unavailable"))
          yield* db.update(SandboxTable).set({ endpoint_token: remote.token }).where(current(id, prior.id)).run().pipe(Effect.orDie)
          yield* gate.booted(id, prior.id)
          return { ...remote, generation: prior.id }
        }
        return yield* Effect.fail(new Error("Aliyun sandbox requires lifecycle reconciliation; automatic resume is disabled"))
      }
      const claim = yield* gate.creating(id, (tx) => lease(tx).claim(id))
      if (claim._tag !== "claimed") { yield* Effect.sleep("250 millis"); continue }
      const work = Effect.gen(function* () {
        const record = yield* row(id)
        if (!record) return yield* Effect.fail(new Error("Aliyun creation intent disappeared"))
        const options = (yield* resource(id))?.sandbox
        if (options?.persistMode === "pvc") return yield* Effect.fail(new Error("Aliyun does not support OpenSandbox PVC persistence"))
        const retain = options?.persistMode === "snapshot"
        const snapshot = retain ? (yield* snapshots(id))[0] : undefined
        if (snapshot && (snapshot.state !== "ready" || !snapshot.snapshot_id))
          return yield* Effect.fail(new Error("Aliyun snapshot outcome requires reconciliation; refusing an empty workspace"))
        // CPU/memory are template properties in E2B, not per-create resource overrides.
        let remote: Remote
        if (record.remote_name && !record.remote_name.startsWith("intent:")) {
          if ((yield* info(record.remote_name)).state !== "running")
            return yield* Effect.fail(new Error("Aliyun workspace is not running; automatic resume is disabled"))
          remote = yield* attempt(() => api.connect(record.remote_name ?? ""))
        } else if (record.remote_name) {
          const found = yield* attempt(() => api.find(record.remote_name ?? ""))
          if (found.length !== 1) return yield* Effect.fail(new Error("Aliyun create outcome is ambiguous; reconcile the retained creation intent before retrying"))
          remote = yield* attempt(() => api.connect(found[0] ?? ""))
        } else {
          const intent = `intent:${randomUUID()}`
          const saved = yield* db.update(SandboxTable).set({ remote_name: intent })
            .where(current(id, CreateLease.creatingID(claim.owner))).returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
          if (!saved.length) return yield* Effect.fail(new Error("Aliyun creation lease lost before dispatch"))
          remote = yield* attempt(() => api.create(snapshot?.snapshot_id ?? options?.image ?? settings.template, {
            secure: true, network: { allowPublicTraffic: false }, timeoutMs: config.timeoutSeconds * 1000,
            // Aliyun permits user metadata and lifecycle overrides on restore,
            // but rejects envs, mounts, image and fc.* system metadata.
            lifecycle: { onTimeout: "kill", autoResume: false },
            metadata: { opencode_session: id, opencode_intent: intent },
          }))
        }
        // Persist the acknowledged cloud identity before preparation can fail.
        const acknowledged = yield* db.update(SandboxTable).set({ remote_name: remote.id, endpoint_token: remote.token })
          .where(current(id, CreateLease.creatingID(claim.owner))).returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
        if (!acknowledged.length) return yield* Effect.fail(new Error("Aliyun creation lease lost; remote workspace retained for reconciliation"))
        if (!remote.token) return yield* Effect.fail(new Error("Aliyun did not return a traffic access token; public access is not permitted"))
        if (options) {
          const actual = yield* info(remote.id)
          const memory = /^(\d+)(Gi|Mi)$/.exec(options.memory)
          const mb = memory ? Number(memory[1]) * (memory[2] === "Gi" ? 1024 : 1) : NaN
          if (Number(options.cpu) !== actual.cpuCount || mb !== actual.memoryMB)
            return yield* Effect.fail(new Error("Aliyun CPU and memory are template properties; requested resources do not match the selected template"))
        }
        yield* prepare(remote)
        const saved = yield* db.update(SandboxTable).set({ remote_name: remote.id, endpoint_token: remote.token })
          .where(current(id, CreateLease.creatingID(claim.owner))).returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
        if (!saved.length) return yield* Effect.fail(new Error("Aliyun creation lease lost; remote workspace retained for reconciliation"))
        // Every physical restore advances SaaS fencing identity.
        const generation = `${remote.id}:${randomUUID()}`
        if (!(yield* gate.creating(id, (tx) => lease(tx).complete(id, claim.owner, generation))))
          return yield* Effect.fail(new Error("Aliyun creation lease lost during persistence"))
        if (snapshot) yield* db.update(Snapshots).set({ restored_count: sql`${Snapshots.restored_count} + 1` })
          .where(eq(Snapshots.id, snapshot.id)).run().pipe(Effect.orDie)
        yield* gate.booted(id, generation)
        return { ...remote, generation }
      }).pipe(Effect.onError(() => lease().release(id, claim.owner)))
      return yield* Effect.raceFirst(work, Effect.sleep("10 seconds").pipe(Effect.andThen(lease().heartbeat(id, claim.owner)), Effect.forever))
    }
    return yield* Effect.fail(new Error("Aliyun sandbox creation lease wait timed out"))
  })
  const capture = Effect.fn("AliyunSandbox.capture")(function* (id: string, stop: boolean, expected?: ReapCandidate) {
    const record = yield* bound(id)
    if (!record || record.state === "destroyed") return
    // A scan must not claim a generation or activity watermark newer than its candidate.
    if (expected && (record.id !== expected.id || record.state !== expected.state || record.time_updated !== expected.time_updated)) return
    if (record.state === "creating") return yield* Effect.fail(new Error("Aliyun sandbox is still being created"))
    // Recovery follows the persisted operation, not the caller that found it stale.
    if (record.state === "snapshotting") stop = !record.command_session_id?.startsWith("capture:")
    const retain = !stop || (yield* persistent(id))
    if (record.state === "snapshotting" && record.time_updated > Date.now() - 360000)
      return yield* Effect.fail(new Error("Aliyun stop is already in progress"))
    const stamp = Math.max(Date.now(), record.time_updated + 1)
    const owner = `oc-${randomUUID()}`
    const intent = record.state === "snapshotting" ? record.command_session_id?.split(":").at(-1) ?? owner : owner
    const token = `${stop ? "stop" : "capture"}:${owner}:${intent}`
    const owned = and(current(id, record.id), eq(SandboxTable.state, "snapshotting"), eq(SandboxTable.command_session_id, token))
    const claimed = yield* db.update(SandboxTable).set({ state: "snapshotting", time_updated: stamp, command_session_id: token })
      .where(and(current(id, record.id), eq(SandboxTable.state, record.state), eq(SandboxTable.time_updated, record.time_updated)))
      .returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (!claimed.length) {
      if (expected) return
      return yield* Effect.fail(new Error("Aliyun stop generation changed"))
    }
    const closure = yield* gate.close(id, true, record.id)
    if (!closure) return yield* Effect.fail(new Error("Aliyun execution gate could not be closed"))
    const work = Effect.gen(function* () {
    const status = yield* inspect(record.remote_name ?? "")
    if (!status) {
      const claimedRecord = yield* bound(id)
      if (claimedRecord?.command_session_id === token) yield* retireGone(claimedRecord)
      return
    }
    const commands = yield* db.select().from(SandboxCommandTable)
      .where(and(eq(SandboxCommandTable.session_id, id), eq(SandboxCommandTable.sandbox_id, record.id))).all().pipe(Effect.orDie)
    if (commands.length) {
      let remaining = commands.length
      const observed = yield* attempt(async () => {
        if (status.state !== "running") throw new Error("Aliyun command reconciliation requires a running source")
        return (await api.connect(record.remote_name ?? "")).listCommands()
      }).pipe(Effect.result)
      if (observed._tag === "Success") {
        const live = new Set(observed.success.map((command) => String(command.pid)))
        const ended = commands.filter((command) => !live.has(command.command_id))
        if (ended.length) yield* db.delete(SandboxCommandTable).where(and(
          eq(SandboxCommandTable.session_id, id), eq(SandboxCommandTable.sandbox_id, record.id),
          inArray(SandboxCommandTable.id, ended.map((command) => command.id)),
        )).run().pipe(Effect.orDie)
        remaining -= ended.length
      }
      if (remaining) {
        yield* db.update(SandboxTable).set({ state: "running", command_session_id: null }).where(owned).run().pipe(Effect.orDie)
        yield* gate.retained(id, closure)
        if (observed._tag === "Failure") return yield* Effect.fail(observed.failure)
        return yield* Effect.fail(new Error("Aliyun snapshot requires all commands to finish or be cancelled"))
      }
    }
    let saved: typeof Snapshots.$inferSelect | undefined
    if (retain) {
      // A stale operation only reconciles its persisted intent; never replay create.
      saved = record.state === "snapshotting" ? (yield* snapshots(id)).find((value) => value.id === intent) : undefined
      if (!saved) {
        if (status.state !== "running")
          return yield* Effect.fail(new Error("Aliyun snapshot source must be running; automatic resume is disabled"))
        const pending = { id: intent, session_id: id, provider_scope: scope,
          sandbox_id: record.id, remote_name: record.remote_name ?? "", state: "creating" as const }
        saved = (yield* db.insert(Snapshots).values(pending).returning().all().pipe(Effect.orDie))[0]
        if (!saved) return yield* Effect.fail(new Error("Aliyun snapshot intent was not persisted"))
        const remote = yield* attempt(() => api.connect(record.remote_name ?? ""))
        yield* attempt(() => remote.extend(Math.max(config.timeoutSeconds, 360) * 1000))
        const snapshotID = yield* attempt(() => remote.snapshot(pending.id))
        saved = (yield* db.update(Snapshots).set({ snapshot_id: snapshotID, state: "ready" })
          .where(eq(Snapshots.id, pending.id)).returning().all().pipe(Effect.orDie))[0]
      } else if (saved.state === "creating") {
        const name = saved.id
        const found = (yield* attempt(() => api.snapshots(record.remote_name ?? "")))
          .filter((value) => value.names.some((value) => value.split("/").at(-1)?.split(":")[0] === name))
        if (found.length !== 1) return yield* Effect.fail(new Error("Aliyun snapshot outcome is ambiguous; source retained, creation will not be replayed"))
        saved = (yield* db.update(Snapshots).set({ snapshot_id: found[0]!.snapshotId, state: "ready" })
          .where(eq(Snapshots.id, name)).returning().all().pipe(Effect.orDie))[0]
      }
      if (!saved?.snapshot_id) return yield* Effect.fail(new Error("Aliyun snapshot was not confirmed; source retained"))
    }
    if (!stop) {
      yield* db.update(SandboxTable).set({ state: "running", time_updated: Date.now() })
        .where(owned).run().pipe(Effect.orDie)
      yield* gate.retained(id, closure)
      return saved
    }
    const confirmed = yield* db.update(SandboxTable).set({ time_updated: Date.now() }).where(owned)
      .returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (!confirmed.length) return yield* Effect.fail(new Error("Aliyun snapshot lease lost; source retained"))
    yield* attempt(() => api.kill(record.remote_name ?? ""))
    const changed = yield* db.update(SandboxTable).set({ state: "destroyed", time_updated: Date.now(),
      remote_name: null, endpoint_token: null, command_session_id: null,
    }).where(owned)
      .returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (changed.length) {
      yield* gate.destroyed(id, closure)
      yield* db.delete(SandboxCommandTable).where(and(eq(SandboxCommandTable.session_id, id), eq(SandboxCommandTable.sandbox_id, record.id))).run().pipe(Effect.orDie)
    }
    return saved
    })
    const heartbeat = Effect.suspend(() => db.update(SandboxTable)
      .set({ time_updated: sql`max(${SandboxTable.time_updated} + 1, ${Date.now()})` }).where(owned).run().pipe(Effect.orDie))
    return yield* Effect.raceFirst(work, Effect.sleep("10 seconds").pipe(Effect.andThen(heartbeat), Effect.forever))
  })
  const destroy = (id: string, expected?: ReapCandidate) => capture(id, true, expected).pipe(Effect.asVoid)
  const deleteSnapshots = (sessionID: string) => Effect.gen(function* () {
    const id = yield* key(sessionID)
    const record = yield* bound(id)
    if (record && record.state !== "destroyed") return yield* Effect.fail(new Error("Stop Aliyun sandbox before deleting snapshots"))
    for (const saved of yield* snapshots(id)) {
      if (!saved.snapshot_id) return yield* Effect.fail(new Error("Reconcile pending Aliyun snapshot before permanent removal"))
      // Termination acknowledgement may precede release of the snapshot reference.
      let deleted = false
      for (let index = 0; index < 5; index++) {
        const result = yield* attempt(() => api.deleteSnapshot(saved.snapshot_id!)).pipe(Effect.result)
        if (result._tag === "Success") { deleted = true; break }
        if (index === 4) return yield* Effect.fail(result.failure)
        yield* Effect.sleep("1 second")
      }
      if (deleted) yield* db.delete(Snapshots).where(eq(Snapshots.id, saved.id)).run().pipe(Effect.orDie)
    }
  })
  const run = Effect.fn("AliyunSandbox.run")(function* (input: RunInput) {
    const id = yield* key(input.sessionID)
    const remote = yield* boot(id)
    yield* touch(id, remote)
    const operation = randomUUID()
    const file = `/workspace/.opencode/output/${operation}.log`
    const task = yield* gate.admit(input.sessionID, remote.generation, () => Effect.gen(function* () {
      const task = yield* attempt(() => remote.start(`mkdir -p /workspace/.opencode/output; (\n${input.command}\n) >${quote(file)} 2>&1`, {
        cwd: input.cwd ? SandboxPath.toSandboxCwd(input.cwd, input.hostWorkdir) : "/workspace", timeoutMs: 0,
      }))
      yield* db.insert(SandboxCommandTable).values({ id: operation, session_id: id, sandbox_id: remote.generation,
        command_id: String(task.pid), operation_id: input.operationID ?? operation }).run().pipe(
          Effect.onError(() => attempt(() => remote.killCommand(task.pid)).pipe(Effect.ignore)), Effect.orDie,
        )
      return task
    }))
    let completed = false
    const wait = attempt(() => task.wait()).pipe(Effect.tap(() => Effect.sync(() => { completed = true })),
      Effect.ensuring(Effect.gen(function* () {
        if (!completed) {
          const cancelled = yield* attempt(() => remote.killCommand(task.pid)).pipe(Effect.result)
          if (cancelled._tag === "Failure") {
            yield* Effect.logWarning("Aliyun command cancellation unconfirmed; PG command retained", { sessionID: id, operation })
            return
          }
        }
        yield* db.delete(SandboxCommandTable).where(eq(SandboxCommandTable.id, operation)).run().pipe(Effect.orDie)
      })), Effect.map((result) => ({ exitCode: result.exitCode, timedOut: false })))
    const observed = input.timeoutMs && input.timeoutMs > 0 ? wait.pipe(Effect.timeoutOrElse({ duration: input.timeoutMs,
      orElse: () => Effect.succeed({ exitCode: null, timedOut: true }),
    })) : wait
    const result = yield* Effect.raceFirst(observed, Effect.sleep("10 seconds").pipe(Effect.andThen(touch(id, remote)), Effect.forever))
    // Read only a bounded prefix; SDK command handles otherwise buffer unlimited output.
    const output = yield* attempt(async () => {
      const head = `${file}.head`
      const task = await remote.start(`head -c 1048576 ${quote(file)} > ${quote(head)}`, { timeoutMs: 10_000 })
      if ((await task.wait()).exitCode !== 0) throw new Error("Aliyun command output could not be read")
      return new TextDecoder().decode(await remote.read(head))
    })
    const size = yield* attempt(() => remote.stat(file))
    return { ...result, output: size.size > 1048576 ? `${output}\nFull output: ${file}` : output, truncated: size.size > 1048576 }
  })
  const files = <A>(sessionID: string, operation: (remote: Remote) => Promise<A>) => Effect.gen(function* () {
    const id = yield* key(sessionID)
    const remote = yield* boot(id)
    yield* touch(id, remote)
    return yield* gate.admit(sessionID, remote.generation, () => attempt(() => operation(remote)).pipe(Effect.timeout(config.filesTimeoutSeconds * 1000)))
  })
  const read = (remote: Remote, target: string) => nullable(async () => {
    if ((await remote.stat(target)).size > 32 * 1024 * 1024) throw new Error("Aliyun file exceeds 32 MiB read limit")
    return remote.read(target)
  })
  const setKeepAlive = (id: string, keep_alive: boolean) => Effect.gen(function* () {
    yield* bound(id)
    const changed = yield* db.insert(SandboxTable).values({ id: `pending-${id}`, session_id: id,
      host: settings.domain, provider: "aliyun", provider_scope: scope, state: "destroyed", keep_alive,
    }).onConflictDoUpdate({ target: SandboxTable.session_id, set: { keep_alive },
      setWhere: and(eq(SandboxTable.provider, "aliyun"), eq(SandboxTable.provider_scope, scope)),
    }).returning({ id: SandboxTable.id }).all().pipe(Effect.orDie)
    if (!changed.length) return yield* Effect.die(new Error("Aliyun keepalive scope changed"))
  })
  const sweep = Effect.gen(function* () {
    const records = yield* db.select().from(SandboxTable).where(and(eq(SandboxTable.provider, "aliyun"), eq(SandboxTable.provider_scope, scope))).all().pipe(Effect.orDie)
    for (const record of records) {
      yield* Effect.gen(function* () {
        if ((record.state === "snapshotting" || record.state === "killed") && record.time_updated < Date.now() - leaseMs)
          yield* destroy(record.session_id, record)
        else if (record.state === "running") {
          if (config.idleReapSeconds > 0 && record.time_updated < Date.now() - config.idleReapSeconds * 1000) yield* destroy(record.session_id, record)
          else {
            // Do not resume a paused VM just because a SaaS Pod restarted.
            const status = yield* inspect(record.remote_name ?? "")
            if (!status) yield* retireGone(record)
            else if (record.keep_alive && status.state === "running") yield* attempt(async () => (await api.connect(record.remote_name ?? "")).extend(config.timeoutSeconds * 1000))
          }
        }
      }).pipe(Effect.catch(() => Effect.logWarning("Aliyun lifecycle reconciliation failed", { sessionID: record.session_id })))
    }
  })
  yield* Effect.forkScoped(Effect.sleep("15 seconds").pipe(Effect.andThen(sweep), Effect.forever))
  return {
    enabled: true,
    boot: (id) => key(id).pipe(Effect.flatMap(boot), Effect.map((remote) => remote.generation), Effect.timeout(leaseMs)),
    run,
    interrupt: (id, operation) => Effect.gen(function* () {
      const record = yield* bound(id)
      if (!record || record.state !== "running") return
      const remote = yield* attempt(() => api.connect(record.remote_name ?? ""))
      const commands = yield* db.select().from(SandboxCommandTable).where(and(eq(SandboxCommandTable.session_id, record.session_id),
        eq(SandboxCommandTable.sandbox_id, record.id), ...(operation ? [eq(SandboxCommandTable.operation_id, operation)] : []))).all().pipe(Effect.orDie)
      for (const command of commands) {
        yield* attempt(() => remote.killCommand(Number(command.command_id)))
        yield* db.delete(SandboxCommandTable).where(and(eq(SandboxCommandTable.id, command.id),
          eq(SandboxCommandTable.sandbox_id, record.id))).run().pipe(Effect.orDie)
      }
    }).pipe(Effect.orDie),
    destroy: (id) => key(id).pipe(Effect.flatMap(destroy), Effect.orDie),
    release: (id) => key(id).pipe(Effect.flatMap((id) => setKeepAlive(id, false).pipe(Effect.andThen(destroy(id)))), Effect.orDie),
    keepAlive: (id) => key(id).pipe(Effect.flatMap((id) => setKeepAlive(id, true))),
    isKeepAlive: (id) => bound(id).pipe(Effect.map((record) => record?.keep_alive ?? false)),
    activity: (id) => Effect.gen(function* () {
      const record = yield* bound(id)
      if (!record || record.state !== "running") return yield* Effect.die(new Error("Aliyun sandbox is not running"))
      if ((yield* info(record.remote_name ?? "")).state !== "running") return yield* Effect.die(new Error("Aliyun sandbox is paused; activity cannot resume it"))
      const remote = { ...yield* attempt(() => api.connect(record.remote_name ?? "")), generation: record.id }
      yield* touch(record.session_id, remote)
      yield* Effect.forkScoped(Effect.sleep("5 seconds").pipe(Effect.andThen(touch(record.session_id, remote)), Effect.forever))
    }).pipe(Effect.orDie),
    sandboxId: (id) => bound(id).pipe(Effect.map((record) => record?.state === "running" ? record.id : null)),
    lifecycle: (id) => Effect.gen(function* () {
      const record = yield* bound(id)
      const retain = yield* persistent(yield* key(id))
      return { sandboxID: record?.id ?? null, state: record?.state ?? null, persistMode: retain ? "snapshot" : "none" }
    }),
    isReady: (id) => Effect.gen(function* () {
      const record = yield* bound(id)
      return !!record && record.state === "running" && (yield* info(record.remote_name ?? "")).state === "running"
    }).pipe(Effect.catch(() => Effect.succeed(false))),
    endpoint: (id, port) => Effect.gen(function* () {
      const record = yield* bound(id)
      if (!record || record.state !== "running") return { _tag: "no-sandbox" } as const
      if (!Number.isInteger(port) || port < 1 || port > 65535 || !record.endpoint_token) return { _tag: "resolve-failed" } as const
      if ((yield* info(record.remote_name ?? "")).state !== "running") return { _tag: "no-sandbox" } as const
      return { _tag: "resolved", sandboxId: record.id, endpoint: `https://${port}-${record.remote_name}.${settings.domain}`,
        headers: { "e2b-traffic-access-token": record.endpoint_token },
      } as const
    }).pipe(Effect.catch(() => Effect.succeed({ _tag: "resolve-failed" } as const))),
    snapshot: (sessionID) => Effect.gen(function* () {
      const id = yield* key(sessionID)
      if (!(yield* persistent(id))) return yield* Effect.fail(new Error("Aliyun snapshots require persistMode=snapshot"))
      yield* boot(id)
      const saved = yield* capture(id, false)
      if (!saved) return yield* Effect.fail(new Error("Aliyun snapshot was not created"))
      return { snapshotID: saved.id, state: saved.state }
    }),
    latestSnapshot: (sessionID) => Effect.gen(function* () {
      const saved = (yield* snapshots(yield* key(sessionID)))[0]
      return saved ? { id: saved.id, state: saved.state, reason: saved.state === "creating" ? "Awaiting cloud reconciliation" : null,
        createdAt: saved.time_created, restoredCount: saved.restored_count } : null
    }),
    snapshotStats: (sessionID) => Effect.gen(function* () {
      const values = yield* snapshots(yield* key(sessionID))
      const counts: Record<string, number> = {}
      for (const value of values) counts[value.state] = (counts[value.state] ?? 0) + 1
      return { snapshots: counts, total: values.length, restoredTotal: values.reduce((sum, value) => sum + value.restored_count, 0),
        operations: { destroy: { byState: {}, total: 0 }, refresh: { byState: {}, total: 0 } } }
    }),
    deleteSnapshots: (id) => deleteSnapshots(id).pipe(Effect.orDie),
    purge: (id) => Effect.gen(function* () {
      const record = yield* bound(id)
      if (record && (record.state !== "destroyed" || record.remote_name?.startsWith("intent:"))) return yield* Effect.fail(new Error("Reconcile or stop Aliyun sandbox before permanent removal"))
      if (record?.remote_name) {
        if (!record.remote_name.startsWith("lost:"))
          yield* attempt(() => api.kill(record.remote_name ?? "")).pipe(Effect.catch((error) => error instanceof SandboxNotFoundError ? Effect.succeed(false) : Effect.fail(error)))
        yield* db.update(SandboxTable).set({ remote_name: null, endpoint_token: null }).where(current(record.session_id, record.id)).run().pipe(Effect.orDie)
      }
      // Fail Session removal if cloud cleanup fails, retaining the recovery ledger.
      yield* deleteSnapshots(id)
    }).pipe(Effect.orDie),
    fileStat: (id, target) => files(id, async (remote) => {
      const value = await nullable(() => remote.stat(target))
      return value ? { size: value.size, isDirectory: value.type === "dir" } : null
    }),
    fileRead: (id, target) => files(id, async (remote) => { const data = await read(remote, target); return data === null ? null : new TextDecoder().decode(data) }),
    fileReadBytes: (id, target, options) => files(id, async (remote) => { const data = await read(remote, target); return data === null ? null : byteRange(data, options?.range) }),
    fileWrite: (id, target, data) => files(id, async (remote) => { await remote.mkdir(path.posix.dirname(target)); await remote.write(target, data) }),
    fileDelete: (id, target) => files(id, async (remote) => { await nullable(() => remote.remove(target)) }),
    fileList: (id, target) => files(id, async (remote) => (await remote.list(target)).map((entry) => ({ name: entry.name, isDirectory: entry.type === "dir" }))),
    fileFind: (id, target, query) => files(id, async (remote) => {
      const found: Array<{ path: string; isDirectory: boolean }> = []
      const pending = [target]
      while (pending.length && found.length < 1000) {
        const directory = pending.shift()
        if (!directory) break
        for (const entry of await remote.list(directory)) {
          const file = path.posix.join(directory, entry.name)
          if (Glob.match(query, entry.name)) found.push({ path: file, isDirectory: entry.type === "dir" })
          if (entry.type === "dir" && ![".git", "node_modules"].includes(entry.name)) pending.push(file)
        }
      }
      return found
    }),
  } satisfies Interface
})
