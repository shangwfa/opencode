import { CodeMode, Extension, Tool } from "@opencode/codemode"
import { Effect } from "effect"
import { WebSocketServer, type WebSocket } from "ws"

type JsonSchema = Parameters<typeof Tool.make>[0]["input"]
type Execute = {
  type: "execute"
  executionID: string
  code: string
  web: boolean
  tools: Array<{ path: string; description: string; inputSchema: JsonSchema; outputSchema?: JsonSchema }>
  limits: CodeMode.ExecutionLimits
}
type Frame =
  | Execute
  | { type: "tool.result" | "tool.error"; executionID: string; ordinal: number; output?: unknown; error?: string }
  | { type: "cancel"; executionID: string; reason?: string }
  | { type: "execution.progress"; executionID: string; toolCalls: Array<Call> }
type Call = {
  tool: string
  status: "running" | "completed" | "error"
  input?: Record<string, unknown>
}
type Tree = Record<string, ReturnType<typeof Tool.make>>

const port = Number(process.env["OPENCODE_CODEMODE_RUNNER_PORT"] ?? 9911)
// This is a transport safety bound, not a Code Mode output limit. Tool results
// are intermediate Sandbox data, so it must admit the 1 MiB-plus aggregation
// workload while remaining bounded against a single untrusted WebSocket frame.
const maxPayload = 16 * 1024 * 1024
// SaaS reaches this port exclusively through SandboxProvider.endpoint(..., true)
// (the OpenSandbox server gateway), never through the browser proxy route.
const server = new WebSocketServer({ host: "0.0.0.0", port, perMessageDeflate: false, maxPayload })

const displayInput = (input: unknown): Record<string, unknown> | undefined => {
  if (input === null || input === undefined) return
  if (typeof input !== "object" || Array.isArray(input)) return { input }
  if (Object.keys(input).length === 0) return
  return input as Record<string, unknown>
}

type FetchInit = {
  readonly method?: string
  readonly headers?: Record<string, string> | Array<[string, string]>
  readonly body?: string
}

/** This function runs in the Sandbox Runner process, never in the SaaS control plane. */
const sandboxFetch = async (input: string | URL, init: FetchInit = {}) => {
  const response = await globalThis.fetch(input, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(30_000),
  })
  const bytes = new Uint8Array(await response.arrayBuffer())
  const headers = Object.fromEntries(response.headers)
  const text = () => new TextDecoder().decode(bytes)
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
      has: (name: string) => name.toLowerCase() in headers,
      entries: () => Object.entries(headers),
    },
    text: async () => text(),
    json: async () => JSON.parse(text()) as unknown,
    bytes: async () => bytes,
  }
}

const displayFetch = (args: ReadonlyArray<unknown>) => {
  const [input, init] = args as [string | URL, FetchInit | undefined]
  return { method: init?.method?.toUpperCase() ?? "GET", url: String(input) }
}

server.on("connection", (socket) => {
  // Human approvals can be idle for minutes. Control frames keep provider
  // gateways alive without exposing a new application message or credentials.
  const heartbeat = setInterval(() => {
    if (socket.readyState === 1) socket.ping()
  }, 15_000)
  heartbeat.unref()
  socket.once("close", () => clearInterval(heartbeat))
  let active:
    | {
        executionID: string
        nextOrdinal: number
        pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>
        controller: AbortController
        calls: Array<Call>
        rows: WeakMap<object, number>
      }
    | undefined
  const send = (value: unknown) => socket.send(JSON.stringify(value))
  const fail = (message: string) => send({ type: "runner.error", message })
  // `ws` emits an error instead of routing an oversized/bad frame through the
  // message handler. Handle it so an invalid peer cannot terminate the daemon.
  socket.on("error", () => undefined)

  socket.on("message", async (raw) => {
    let frame: Frame
    try {
      frame = JSON.parse(String(raw)) as Frame
    } catch {
      fail("Invalid JSON frame")
      return
    }
    if (frame.type === "tool.result" || frame.type === "tool.error") {
      if (!active || active.executionID !== frame.executionID) return
      const pending = active.pending.get(frame.ordinal)
      if (!pending) return
      active.pending.delete(frame.ordinal)
      if (frame.type === "tool.error") pending.reject(new Error(frame.error ?? "Tool failed"))
      else pending.resolve(frame.output)
      return
    }
    if (frame.type === "cancel") {
      if (!active || active.executionID !== frame.executionID) return
      active.controller.abort()
      for (const pending of active.pending.values()) pending.reject(new Error(frame.reason ?? "Execution cancelled"))
      active.pending.clear()
      return
    }
    if (frame.type !== "execute" || active) {
      fail("Runner accepts one active execute request per connection")
      return
    }
    active = {
      executionID: frame.executionID,
      nextOrdinal: 0,
      pending: new Map(),
      controller: new AbortController(),
      calls: [],
      rows: new WeakMap(),
    }
    try {
      const root: Tree = Object.create(null)
      for (const entry of frame.tools) {
        const parts = entry.path.split(".")
        if (
          parts.some(
            (part) =>
              !/^[A-Za-z0-9_-]{1,64}$/.test(part) ||
              part === "__proto__" ||
              part === "prototype" ||
              part === "constructor",
          )
        )
          throw new Error(`Invalid tool path: ${entry.path}`)
        if (Object.hasOwn(root, entry.path)) throw new Error(`Duplicate tool path: ${entry.path}`)
        root[entry.path] = Tool.make({
          description: entry.description,
          input: entry.inputSchema,
          ...(entry.outputSchema === undefined ? {} : { output: entry.outputSchema }),
          execute: (input) =>
            Effect.tryPromise({
              try: (signal) =>
                new Promise((resolve, reject) => {
                  const ordinal = active!.nextOrdinal++
                  active!.pending.set(ordinal, { resolve, reject })
                  signal.addEventListener(
                    "abort",
                    () => {
                      active?.pending.delete(ordinal)
                      reject(new Error("Execution interrupted"))
                    },
                    { once: true },
                  )
                  send({ type: "tool.call", executionID: active!.executionID, ordinal, tool: entry.path, input })
                }),
              catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
            }),
        })
      }
      const record = (call: object, name: string, input: unknown) => {
        const index = active!.calls.length
        active!.rows.set(call, index)
        active!.calls.push({ tool: name, status: "running", ...(displayInput(input) ? { input: displayInput(input) } : {}) })
        send({ type: "execution.progress", executionID: frame.executionID, toolCalls: [...active!.calls] })
      }
      const settle = (call: object, result: CodeMode.CallResult) => {
        const index = active!.rows.get(call)
        if (index === undefined) return
        active!.calls[index] = { ...active!.calls[index]!, status: result.status === "success" ? "completed" : "error" }
        send({ type: "execution.progress", executionID: frame.executionID, toolCalls: [...active!.calls] })
      }
      const cancelled = Effect.tryPromise({
        try: () =>
          new Promise<never>((_resolve, reject) => {
            const fail = () => reject(new Error("Execution interrupted"))
            if (active!.controller.signal.aborted) fail()
            else active!.controller.signal.addEventListener("abort", fail, { once: true })
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      })
      const result = await Effect.runPromise(
        Effect.raceFirst(
          CodeMode.execute({
            tools: root,
            code: frame.code,
            limits: frame.limits,
            ...(frame.web ? { extensions: [Extension.make({ name: "web", globals: { fetch: sandboxFetch } })] } : {}),
            hooks: {
              "tool.before": (call) => Effect.sync(() => record(call, call.name, call.input)),
              "tool.after": (call, outcome) => Effect.sync(() => settle(call, outcome)),
              "extension.before": (call) => Effect.sync(() => record(call, call.name, displayFetch(call.args))),
              "extension.after": (call, outcome) => Effect.sync(() => settle(call, outcome)),
            },
          }),
          cancelled,
        ),
      )
      send({ type: "execution.result", executionID: frame.executionID, result })
    } catch (error) {
      send({
        type: "execution.error",
        executionID: frame.executionID,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      active = undefined
    }
  })
  socket.on("close", () => {
    if (!active) return
    active.controller.abort()
    for (const pending of active.pending.values()) pending.reject(new Error("SaaS Runner connection closed"))
    active.pending.clear()
  })
})

server.on("listening", () => process.stdout.write(`codemode-runner:${port}\n`))
