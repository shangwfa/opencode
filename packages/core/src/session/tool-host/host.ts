import http from "node:http"
import { fork, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { budgets, prefix, protocolVersion, versionHash, HostError } from "../tool-host-protocol"

type Frame = Record<string, any>
type Worker = {
  key: string
  child: ChildProcess
  manifest?: Frame
  loaded: Promise<Frame>
  calls: Set<string>
  touched: number
}
type Call = {
  id: string
  key: string
  input: Frame
  response?: http.ServerResponse
  ordinal: number
  state: string
  timer: ReturnType<typeof setTimeout>
  result?: Frame
  completed?: number
  bytes: number
  resultBytes?: number
}
type Session = { epoch: number; generation: number; closed: boolean }

/** The supervisor never imports user modules. Only version workers execute source. */
export function createHost(options: { sandboxID: string; root?: string; worker?: string }) {
  const hostEpoch = crypto.randomUUID()
  const root = options.root ?? "/workspace"
  const workerFile = options.worker ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "session-tool-worker.mjs")
  const sessions = new Map<string, Session>()
  const owners = new Map<string, { expires: number; leaseID: string }>()
  const workers = new Map<string, Worker>()
  const loading = new Map<string, Promise<Worker>>()
  const calls = new Map<string, Call>()
  const cancelled = new Set<string>()
  const snapshots = new Map<string, { owner: string; session: string; versions: Map<string, string> }>()
  const pendingAcks = new Map<string, { worker: Worker; call: Call; timer: ReturnType<typeof setTimeout> }>()
  let active = 0
  let cachedBytes = 0
  let closed = false
  const queue: Call[] = []
  const identity = (input: Frame) => `${input.logicalSessionID}:${input.executionID}`
  const ownerKey = (input: Frame) => `${input.ownerID}:${input.logicalSessionID}`
  const snapshotKey = (input: Frame) => `${ownerKey(input)}:${input.snapshotID}`
  const workerKey = (input: Frame) => `${input.logicalSessionID}:${input.versionHash}`
  const fault = (code: string, message: string): never => {
    throw new HostError(code, message)
  }

  function validate(input: Frame) {
    if (input.protocolVersion !== protocolVersion) fault("protocol-mismatch", "Unsupported Session Tool protocol")
    if (input.sandboxID !== options.sandboxID || input.hostEpoch !== hostEpoch)
      fault("stale-epoch", "Sandbox host identity changed")
    const session = sessions.get(input.logicalSessionID)
    if (!session || session.closed || session.epoch !== input.lifecycleEpoch || session.generation !== input.generation)
      fault("admission-closed", "Session admission is closed")
    const owner = owners.get(ownerKey(input))
    if (!owner || owner.expires < Date.now() || input.ownerLeaseID !== owner.leaseID)
      fault("owner-expired", "Owner lease expired")
  }

  function emit(call: Call, frame: Frame) {
    const value = { ...frame, executionID: call.id, ordinal: ++call.ordinal }
    const json = JSON.stringify(value)
    if (Buffer.byteLength(json) > budgets.result)
      return finish(call, { type: "error", code: "result-too-large", message: "Tool result exceeds transport budget" })
    if (call.response && !call.response.destroyed) call.response.write(`${json}\n`)
    return value
  }

  function finish(call: Call, frame: Frame) {
    if (!["queued", "running"].includes(call.state)) return
    if (Buffer.byteLength(JSON.stringify(frame)) > budgets.result)
      frame = { type: "error", code: "result-too-large", message: "Tool result exceeds transport budget" }
    clearTimeout(call.timer)
    const running = call.state === "running"
    call.state = frame.type === "result" ? "completed" : frame.code === "cancelled" ? "cancelled" : "failed"
    call.completed = Date.now()
    call.result = { ...frame, executionID: call.id, ordinal: ++call.ordinal }
    const json = JSON.stringify(call.result)
    call.resultBytes = Buffer.byteLength(json)
    cachedBytes += call.resultBytes
    call.response?.end(`${json}\n`)
    call.response = undefined
    if (cachedBytes > budgets.cachedResults) {
      for (const cached of [...calls.values()]
        .filter((value) => value.result)
        .sort((a, b) => (a.completed ?? 0) - (b.completed ?? 0))) {
        if (cachedBytes <= budgets.cachedResults) break
        expireResult(cached)
      }
    }
    const worker = workers.get(call.key)
    worker?.calls.delete(identity(call.input))
    for (const [id, ack] of pendingAcks) {
      if (ack.call !== call) continue
      clearTimeout(ack.timer)
      pendingAcks.delete(id)
    }
    if (running) active--
    queueMicrotask(drain)
  }

  function expireResult(call: Call) {
    cachedBytes -= call.resultBytes ?? 0
    call.resultBytes = undefined
    call.result = undefined
  }

  function terminate(worker: Worker, code: string, message: string) {
    if (workers.get(worker.key) !== worker) return
    workers.delete(worker.key)
    try {
      if (worker.child.pid) process.kill(-worker.child.pid, "SIGTERM")
    } catch {}
    const killer = setTimeout(() => {
      try {
        if (worker.child.pid) process.kill(-worker.child.pid, "SIGKILL")
      } catch {}
    }, budgets.grace)
    killer.unref()
    for (const key of worker.calls) {
      const call = calls.get(key)
      if (call) finish(call, { type: "error", code, message })
    }
  }

  function load(input: Frame): Promise<Worker> {
    const key = workerKey(input)
    const pending = loading.get(key)
    if (pending) return pending
    const promise = createWorker(input).finally(() => loading.delete(key))
    loading.set(key, promise)
    return promise
  }

  async function createWorker(input: Frame): Promise<Worker> {
    const key = workerKey(input)
    const cached = workers.get(key)
    if (cached) {
      cached.touched = Date.now()
      await cached.loaded
      return cached
    }
    if (workers.size >= budgets.workers) {
      const idle = [...workers.values()]
        .filter((w) => w.calls.size === 0 && w.manifest)
        .sort((a, b) => a.touched - b.touched)[0]
      if (!idle) fault("resource-busy", "All version workers are active")
      terminate(idle, "worker-terminated", "Idle worker evicted")
    }
    const expected = path.join(
      root,
      ".opencode",
      ".session-tools",
      input.logicalSessionID,
      input.versionHash,
      "source.ts",
    )
    if (input.sourcePath !== expected) fault("source-invalid", "Source path is not canonical")
    const canonical = await fs.realpath(expected)
    if (canonical !== expected) fault("source-invalid", "Source symlinks are not supported")
    const source = await fs.readFile(expected, "utf8")
    if (versionHash(source) !== input.versionHash) fault("source-invalid", "Source hash mismatch")
    const child = fork(workerFile, [], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      execArgv: [],
      serialization: "json",
      env: { ...process.env },
    })
    let resolve!: (manifest: Frame) => void
    let reject!: (error: Error) => void
    const loaded = new Promise<Frame>((yes, no) => {
      resolve = yes
      reject = no
    })
    const worker: Worker = { key, child, loaded, calls: new Set(), touched: Date.now() }
    workers.set(key, worker)
    const timeout = setTimeout(() => {
      reject(new HostError("deadline-exceeded", "Tool module discovery timed out"))
      terminate(worker, "deadline-exceeded", "Tool discovery timed out")
    }, budgets.discover)
    const log = (chunk: Buffer) => {
      for (const id of worker.calls) {
        const call = calls.get(id)
        if (!call || call.bytes >= budgets.log) continue
        const remaining = budgets.log - call.bytes
        const text = chunk.subarray(0, remaining).toString()
        call.bytes += chunk.length
        emit(call, { type: "log", text, truncated: call.bytes >= budgets.log })
      }
    }
    child.stdout?.on("data", log)
    child.stderr?.on("data", log)
    child.on("message", (raw) => {
      const frame = raw as Frame
      if (frame.type === "manifest") {
        if (Buffer.byteLength(JSON.stringify(frame.manifest)) > budgets.manifest) {
          reject(new HostError("result-too-large", "Manifest exceeds budget"))
          terminate(worker, "worker-terminated", "Manifest too large")
          return
        }
        clearTimeout(timeout)
        worker.manifest = frame.manifest
        resolve(frame.manifest)
        return
      }
      if (!frame.executionID) {
        clearTimeout(timeout)
        reject(new HostError(frame.code ?? "source-invalid", String(frame.error ?? "Module load failed")))
        terminate(worker, "worker-terminated", "Invalid tool module")
        return
      }
      const call = calls.get(`${input.logicalSessionID}:${frame.executionID}`)
      if (!call || call.key !== key || call.state !== "running") return
      if (frame.type === "progress") {
        const timer = setTimeout(() => {
          pendingAcks.delete(frame.progressID)
          child.send({ type: "ack", progressID: frame.progressID, error: "Progress acknowledgement timed out" })
        }, 5000)
        pendingAcks.set(frame.progressID, { worker, call, timer })
        emit(call, frame)
      } else if (frame.type === "result") finish(call, frame)
      else if (frame.type === "error")
        finish(call, { type: "error", code: frame.code ?? "tool-execution-failed", message: String(frame.error) })
    })
    child.on("error", (error) => {
      clearTimeout(timeout)
      reject(error)
      terminate(worker, "worker-terminated", error.message)
    })
    child.on("exit", () => {
      clearTimeout(timeout)
      reject(new HostError("worker-terminated", "Worker exited"))
      terminate(worker, "worker-terminated", "Worker exited")
    })
    child.send({ type: "load", sourcePath: expected, versionHash: input.versionHash })
    await loaded
    return worker
  }

  async function start(call: Call) {
    if (call.state !== "queued") return
    call.state = "running"
    active++
    try {
      validate(call.input)
      const worker = await load(call.input)
      if (call.state !== "running") return
      if (worker.manifest?.manifestHash !== call.input.manifestHash) fault("manifest-mismatch", "Tool manifest changed")
      worker.calls.add(identity(call.input))
      worker.child.send({ type: "execute", executionID: call.id, args: call.input.args, context: call.input.context })
    } catch (error) {
      finish(call, {
        type: "error",
        code: error instanceof HostError ? error.code : "not-ready",
        message: String(error),
      })
    }
  }

  function drain() {
    while (active < budgets.active && queue.length) {
      const call = queue.shift()!
      if (call.state === "queued") void start(call)
    }
  }

  function cancel(input: Frame) {
    const key = identity(input)
    if (cancelled.size >= budgets.tombstones && !cancelled.has(key))
      fault("resource-busy", "Cancellation identity budget exceeded")
    cancelled.add(key)
    const call = calls.get(key)
    if (call?.state === "running") {
      const worker = workers.get(call.key)
      finish(call, { type: "error", code: "cancelled", message: "Execution cancelled" })
      if (worker) terminate(worker, "worker-terminated", "Sibling execution cancelled")
    } else if (call?.state === "queued")
      finish(call, { type: "error", code: "cancelled", message: "Execution cancelled" })
    return { state: call?.state ?? "tombstoned" }
  }

  async function operation(name: string, input: Frame, response: http.ServerResponse) {
    if (name === "prepare") {
      if (closed || input.sandboxID !== options.sandboxID || input.protocolVersion !== protocolVersion)
        fault("admission-closed", "Sandbox closed or protocol incompatible")
      if (!/^[A-Za-z0-9_-]+$/.test(input.logicalSessionID) || !Number.isSafeInteger(input.lifecycleEpoch))
        fault("source-invalid", "Invalid session identity")
      let session = sessions.get(input.logicalSessionID)
      if (session && (session.closed || input.lifecycleEpoch !== session.epoch))
        fault("admission-closed", "Session admission closed")
      if (!session) {
        session = { epoch: input.lifecycleEpoch, generation: 1, closed: false }
        sessions.set(input.logicalSessionID, session)
      }
      const owner = owners.get(ownerKey(input))
      const leaseID = owner && owner.expires >= Date.now() ? owner.leaseID : crypto.randomUUID()
      owners.set(ownerKey(input), { expires: Date.now() + budgets.owner, leaseID })
      return { hostEpoch, generation: session.generation, ownerLeaseID: leaseID }
    }
    if (name === "release") {
      if (input.hostEpoch !== hostEpoch) fault("stale-epoch", "Host changed")
      if (input.scope === "sandbox") closed = true
      for (const [id, session] of sessions) {
        if (input.scope !== "sandbox" && id !== input.logicalSessionID) continue
        session.closed = true
        for (const call of calls.values()) if (call.input.logicalSessionID === id) cancel(call.input)
        for (const worker of [...workers.values()])
          if (worker.key.startsWith(`${id}:`)) terminate(worker, "cancelled", "Session released")
      }
      return { state: "closed" }
    }
    validate(input)
    if (name === "renew") {
      owners.set(ownerKey(input), { expires: Date.now() + budgets.owner, leaseID: input.ownerLeaseID })
      return { state: "renewed" }
    }
    if (name === "owner-release") {
      owners.delete(ownerKey(input))
      for (const call of calls.values()) if (ownerKey(call.input) === ownerKey(input)) cancel(call.input)
      for (const [key, value] of snapshots)
        if (value.owner === input.ownerID && value.session === input.logicalSessionID) snapshots.delete(key)
      return { state: "released" }
    }
    if (name === "discover") return (await load(input)).manifest
    if (name === "snapshot-acquire") {
      snapshots.set(snapshotKey(input), {
        owner: input.ownerID,
        session: input.logicalSessionID,
        versions: new Map(input.manifests.map((m: Frame) => [m.versionHash, m.manifestHash])),
      })
      return { state: "acquired" }
    }
    if (name === "snapshot-release") {
      snapshots.delete(snapshotKey(input))
      return { state: "released" }
    }
    if (name === "cancel") return cancel(input)
    if (name === "status") {
      const call = calls.get(identity(input))
      return { state: call?.state ?? "unknown", ...(call?.result ? { terminal: call.result } : {}) }
    }
    if (name === "progress-ack") {
      const ack = pendingAcks.get(input.progressID)
      if (ack && identity(ack.call.input) === identity(input) && ack.call.input.ownerID === input.ownerID) {
        clearTimeout(ack.timer)
        pendingAcks.delete(input.progressID)
        ack.worker.child.send({
          type: "ack",
          progressID: input.progressID,
          ...(input.outcome === "error" ? { error: input.message ?? "Progress failed" } : {}),
        })
      }
      return { state: "acknowledged" }
    }
    if (name !== "execute") fault("protocol-mismatch", "Unknown operation")
    const key = identity(input)
    if (cancelled.has(key)) fault("cancelled", "Execution already cancelled")
    if (calls.has(key)) fault("result-unknown", "Duplicate execution; query status instead")
    if (calls.size >= budgets.tombstones) fault("resource-busy", "Execution identity budget exceeded")
    if (queue.length >= budgets.queue) fault("resource-busy", "Execution queue full")
    if (snapshots.get(snapshotKey(input))?.versions.get(input.versionHash) !== input.manifestHash)
      fault("manifest-mismatch", "No matching snapshot lease")
    const duration = Math.min(budgets.execute, Math.max(1, input.deadlineMs ?? budgets.execute))
    const call: Call = {
      id: input.executionID,
      key: workerKey(input),
      input,
      response,
      ordinal: 0,
      state: "queued",
      bytes: 0,
      timer: setTimeout(() => {
        const worker = workers.get(workerKey(input))
        finish(call, { type: "error", code: "deadline-exceeded", message: "Execution deadline exceeded" })
        if (worker) terminate(worker, "worker-terminated", "Sibling deadline exceeded")
      }, duration),
    }
    calls.set(key, call)
    response.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" })
    emit(call, { type: "accepted" })
    queue.push(call)
    drain()
    return undefined
  }

  const timer = setInterval(() => {
    for (const [key, snapshot] of snapshots) {
      if ((owners.get(`${snapshot.owner}:${snapshot.session}`)?.expires ?? 0) < Date.now()) snapshots.delete(key)
    }
    for (const call of calls.values()) {
      if (["queued", "running"].includes(call.state) && (owners.get(ownerKey(call.input))?.expires ?? 0) < Date.now())
        cancel(call.input)
      if (call.completed && call.result && Date.now() - call.completed > budgets.cache) expireResult(call)
    }
    for (const worker of [...workers.values()])
      if (!worker.calls.size && worker.manifest && Date.now() - worker.touched > budgets.idle)
        terminate(worker, "worker-terminated", "Idle worker expired")
  }, 1000)
  timer.unref()
  const server = http.createServer(async (request, response) => {
    try {
      const name = request.url?.startsWith(prefix) ? request.url.slice(prefix.length) : ""
      if (name === "health" && request.method === "GET") {
        response.end(
          JSON.stringify({
            protocolVersion,
            sandboxID: options.sandboxID,
            hostEpoch,
            capabilities: ["worker", "progress", "snapshot"],
          }),
        )
        return
      }
      if (request.method !== "POST") fault("protocol-mismatch", "Expected POST")
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > budgets.body) fault("result-too-large", "Request too large")
        chunks.push(chunk)
      }
      const result = await operation(name, JSON.parse(Buffer.concat(chunks).toString()), response)
      if (result !== undefined) {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(result))
      }
    } catch (error) {
      const code = error instanceof HostError ? error.code : "not-ready"
      if (!response.headersSent) response.writeHead(400, { "content-type": "application/json" })
      response.end(
        JSON.stringify({ code, message: error instanceof Error ? error.message : String(error), retryable: false }),
      )
    }
  })
  return {
    server,
    async close() {
      closed = true
      clearInterval(timer)
      for (const call of calls.values()) finish(call, { type: "error", code: "cancelled", message: "Host stopped" })
      for (const worker of [...workers.values()]) terminate(worker, "cancelled", "Host stopped")
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

if (process.argv.includes("--serve")) {
  const host = createHost({ sandboxID: process.env.OPENCODE_SESSION_TOOL_SANDBOX_ID ?? "unknown" })
  host.server.listen(9912, "0.0.0.0")
  process.on("SIGTERM", () => {
    void host.close().then(() => process.exit(0))
  })
}
