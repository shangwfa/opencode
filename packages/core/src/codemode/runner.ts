export * as CodeModeRunner from "./runner.js"

const PORT = 9911
const PID_FILE = "/tmp/opencode-codemode-runner.pid"
const LOG_FILE = "/tmp/opencode-codemode-runner.log"

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/** Start the image-baked Runner as a detached daemon. No source or credential is passed here. */
export function startCommand() {
  const command = "node /opt/opencode-codemode-runner.mjs"
  const start = `if [ -s ${quote(PID_FILE)} ] && kill -0 "$(cat ${quote(PID_FILE)})" 2>/dev/null; then echo runner-already-running; else rm -f ${quote(PID_FILE)}; nohup ${command} > ${quote(LOG_FILE)} 2>&1 </dev/null & pid=$!; echo "$pid" > ${quote(PID_FILE)}; echo "runner-started:$pid"; fi`
  // `-o` closes the lock fd before running the launcher: the nohup'd daemon
  // inherits open fds, and an inherited flock fd would hold this exclusive
  // lock for the daemon's whole lifetime, so every later start in the session
  // would block on flock until the launcher command times out.
  return `flock -x -o ${quote(`${PID_FILE}.lock`)} -c ${quote(start)}`
}

/** Stop only the Runner daemon; this does not interrupt other Sandbox commands. */
export function stopCommand() {
  return `if [ -s ${quote(PID_FILE)} ]; then pid="$(cat ${quote(PID_FILE)})"; kill "$pid" 2>/dev/null || true; for i in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done; kill -9 "$pid" 2>/dev/null || true; fi; rm -f ${quote(PID_FILE)} ${quote(LOG_FILE)}`
}

export const port = PORT

import { Effect, Schema } from "effect"
import { CodeMode } from "@opencode/codemode"
import type { SandboxProvider } from "../sandbox/provider.js"

/** Ensure the Session-local daemon is running and resolve it through the server gateway only. */
export const start = Effect.fn("CodeModeRunner.start")(function* (input: {
  provider: SandboxProvider.Interface
  sessionID: string
  hostWorkdir: string
}) {
  const resolve = () => input.provider.endpoint(input.sessionID, PORT, true)
  // A server-gateway endpoint can be resolved before its target port listens;
  // it is addressability, not a Runner readiness probe. Always run the
  // idempotent launcher first, then resolve the endpoint for connection.
  // Keep the daemon out of a disposable isolated command context; deleting
  // that context after startup could also reap its background child process.
  const started = yield* input.provider.run({
    sessionID: input.sessionID,
    hostWorkdir: input.hostWorkdir,
    command: startCommand(),
    timeoutMs: 10_000,
  })
  if (started.exitCode !== 0)
    return yield* Effect.fail(new Error(`Failed to start Code Mode Runner: ${started.output}`))

  let last = yield* resolve()
  for (let attempt = 0; attempt < 20; attempt++) {
    if (last._tag === "resolved") return last
    yield* Effect.sleep("250 millis")
    last = yield* resolve()
  }
  return yield* Effect.fail(new Error(`Code Mode Runner did not become reachable: ${last._tag}`))
})

/** Stop the daemon without interrupting regular Session commands. */
export const stop = Effect.fn("CodeModeRunner.stop")(function* (input: {
  provider: SandboxProvider.Interface
  sessionID: string
  hostWorkdir: string
}) {
  if (!input.provider.enabled) return
  yield* input.provider
    .run({
      sessionID: input.sessionID,
      hostWorkdir: input.hostWorkdir,
      command: stopCommand(),
      timeoutMs: 10_000,
      isolated: true,
      operationID: `codemode-runner-stop:${input.sessionID}`,
    })
    .pipe(Effect.ignore)
})

export type ExecuteInput = {
  readonly endpoint: string
  readonly executionID: string
  readonly code: string
  /** Whether the Runner may expose its Sandbox-local fetch extension. */
  readonly web: boolean
  readonly tools: ReadonlyArray<{
    readonly path: string
    readonly description: string
    readonly inputSchema: unknown
    readonly outputSchema?: unknown
  }>
  readonly limits: import("@opencode/codemode").CodeMode.ExecutionLimits
  readonly signal?: AbortSignal
  readonly tool: (
    input: { executionID: string; ordinal: number; tool: string; input: unknown },
    signal?: AbortSignal,
  ) => Promise<unknown>
  readonly progress?: (toolCalls: ReadonlyArray<{
    readonly tool: string
    readonly status: "running" | "completed" | "error"
    readonly input?: Record<string, typeof Schema.Json.Type>
  }>) => Promise<void>
}

/** Run one immutable execution over an SaaS-initiated Runner WebSocket. */
export function execute(input: ExecuteInput): Promise<CodeMode.Result> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${input.endpoint}/`)
    let settled = false
    const finish = (error?: Error, value?: CodeMode.Result) => {
      if (settled) return
      settled = true
      input.signal?.removeEventListener("abort", abort)
      socket.close()
      if (error) reject(error)
      else if (value !== undefined) resolve(value)
      else reject(new Error("Runner completed without a result"))
    }
    const abort = () => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "cancel", executionID: input.executionID, reason: "interrupted" }))
      finish(new Error("Code Mode execution interrupted"))
    }
    input.signal?.addEventListener("abort", abort, { once: true })
    socket.addEventListener(
      "open",
      () => {
        socket.send(
          JSON.stringify({
            type: "execute",
            executionID: input.executionID,
            code: input.code,
            web: input.web,
            tools: input.tools,
            limits: input.limits,
          }),
        )
      },
      { once: true },
    )
    socket.addEventListener("message", async (event) => {
      if (typeof event.data !== "string") return finish(new Error("Runner sent a non-text frame"))
      let frame: Record<string, unknown>
      try {
        frame = JSON.parse(event.data) as Record<string, unknown>
      } catch {
        return finish(new Error("Runner sent invalid JSON"))
      }
      if (frame.executionID !== input.executionID) return finish(new Error("Runner execution ID mismatch"))
      if (frame.type === "execution.progress") {
        if (!Array.isArray(frame.toolCalls)) return finish(new Error("Runner sent invalid progress"))
        try {
          await input.progress?.(frame.toolCalls as Parameters<NonNullable<ExecuteInput["progress"]>>[0])
        } catch (cause) {
          finish(cause instanceof Error ? cause : new Error(String(cause)))
        }
        return
      }
      if (frame.type === "tool.call") {
        const call = frame as { executionID: string; ordinal: number; tool: string; input: unknown }
        void input.tool(call, input.signal).then(
          (output) => {
            if (!settled && socket.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({ type: "tool.result", executionID: input.executionID, ordinal: call.ordinal, output }),
              )
          },
          (error) => {
            if (!settled && socket.readyState === WebSocket.OPEN)
              socket.send(
                JSON.stringify({
                  type: "tool.error",
                  executionID: input.executionID,
                  ordinal: call.ordinal,
                  error: error instanceof Error ? error.message : String(error),
                }),
              )
          },
        )
        return
      }
      if (frame.type === "execution.result") {
        try {
          return finish(undefined, Schema.decodeUnknownSync(CodeMode.Result)(frame.result))
        } catch (cause) {
          return finish(cause instanceof Error ? cause : new Error(String(cause)))
        }
      }
      if (frame.type === "execution.error" || frame.type === "runner.error")
        return finish(new Error(String(frame.error ?? frame.message ?? "Runner failed")))
    })
    socket.addEventListener("error", () => finish(new Error("Code Mode Runner WebSocket failed")), { once: true })
    socket.addEventListener(
      "close",
      () => {
        if (!settled) finish(new Error("Code Mode Runner connection closed before completion"))
      },
      { once: true },
    )
    if (input.signal?.aborted) abort()
  })
}
