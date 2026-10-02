import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeModeRunner } from "../src/codemode/runner"

describe("CodeModeRunner", () => {
  test("starts a detached image-baked runner without passing execution data", () => {
    const command = CodeModeRunner.startCommand()
    expect(command).toContain("nohup node /opt/opencode-codemode-runner.mjs")
    expect(command).toContain("</dev/null")
    expect(command).toContain("/tmp/opencode-codemode-runner.pid")
    expect(command).not.toContain("capability")
    expect(command).not.toContain("workspace")
  })

  test("closes the launcher lock fd so the daemon cannot hold it forever", () => {
    // The nohup'd daemon inherits open fds. Without `flock -o` it inherits the
    // exclusive lock fd and holds it for its lifetime, so the next start in the
    // same session blocks on flock until the launcher command times out
    // ("Failed to start Code Mode Runner: Command exceeded timeout of 10000 ms").
    const command = CodeModeRunner.startCommand()
    expect(command).toContain("flock -x -o")
  })

  test("stops only the runner process and removes its private runtime files", () => {
    const command = CodeModeRunner.stopCommand()
    expect(command).toContain('kill "$pid"')
    expect(command).toContain("/tmp/opencode-codemode-runner.pid")
    expect(command).toContain("/tmp/opencode-codemode-runner.log")
  })

  test("uses its reserved internal endpoint port", () => {
    expect(CodeModeRunner.port).toBe(9911)
  })

  test("starts the idempotent daemon even when the gateway can already resolve its port", async () => {
    let starts = 0
    const endpoint = { _tag: "resolved" as const, sandboxId: "sb_runner", endpoint: "gateway:9911" }
    const provider = {
      endpoint: () => Effect.succeed(endpoint),
      run: () => {
        starts++
        return Effect.succeed({ exitCode: 0, output: "runner-started", timedOut: false })
      },
    }
    await expect(
      Effect.runPromise(
        CodeModeRunner.start({ provider: provider as never, sessionID: "ses_runner", hostWorkdir: "/workspace" }),
      ),
    ).resolves.toEqual(endpoint)
    expect(starts).toBe(1)
  })

  test("dispatches Runner tool.call frames through the SaaS tool callback", async () => {
    let server: ReturnType<typeof Bun.serve>
    const updates: Array<ReadonlyArray<{ tool: string; status: "running" | "completed" | "error" }>> = []
    server = Bun.serve({
      port: 0,
      fetch(request, current) {
        if (current.upgrade(request, { data: undefined })) return undefined
        return new Response("websocket required", { status: 400 })
      },
      websocket: {
        message(socket, raw) {
          const frame = JSON.parse(String(raw))
          if (frame.type === "execute") {
            expect(frame.web).toBe(false)
            socket.send(
              JSON.stringify({
                type: "execution.progress",
                executionID: frame.executionID,
                toolCalls: [{ tool: "math.add", status: "running" }],
              }),
            )
            socket.send(
              JSON.stringify({
                type: "tool.call",
                executionID: frame.executionID,
                ordinal: 0,
                tool: "math.add",
                input: { a: 2, b: 3 },
              }),
            )
          }
          if (frame.type === "tool.result")
            socket.send(
              JSON.stringify({
                type: "execution.result",
                executionID: frame.executionID,
                result: { ok: true, value: frame.output, toolCalls: [{ name: "math.add" }] },
              }),
            )
        },
      },
    })
    try {
      const result = await CodeModeRunner.execute({
        endpoint: `127.0.0.1:${server.port}`,
        executionID: "cme_test",
        code: "",
        web: false,
        tools: [],
        limits: {},
        progress: async (toolCalls) => {
          updates.push(toolCalls)
        },
        tool: async (call) => {
          expect(call).toMatchObject({ tool: "math.add", input: { a: 2, b: 3 } })
          return 5
        },
      })
      expect(result).toEqual({ ok: true, value: 5, toolCalls: [{ name: "math.add" }] })
      expect(updates).toEqual([[{ tool: "math.add", status: "running" }]])
    } finally {
      server.stop(true)
    }
  })

  test("sends Runner cancellation when the owning Effect is interrupted", async () => {
    let receivedCancel!: (frame: unknown) => void
    const cancelled = new Promise<unknown>((resolve) => {
      receivedCancel = resolve
    })
    const server = Bun.serve({
      port: 0,
      fetch(request, current) {
        if (current.upgrade(request, { data: undefined })) return undefined
        return new Response("websocket required", { status: 400 })
      },
      websocket: {
        message(socket, raw) {
          const frame = JSON.parse(String(raw))
          if (frame.type === "execute")
            socket.send(
              JSON.stringify({
                type: "tool.call",
                executionID: frame.executionID,
                ordinal: 0,
                tool: "math.wait",
                input: {},
              }),
            )
          if (frame.type === "cancel") receivedCancel(frame)
        },
      },
    })
    const controller = new AbortController()
    try {
      const execution = CodeModeRunner.execute({
        endpoint: `127.0.0.1:${server.port}`,
        executionID: "cme_cancel_test",
        code: "",
        web: false,
        tools: [],
        limits: {},
        signal: controller.signal,
        tool: (_call, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
            controller.abort()
          }),
      })
      await expect(execution).rejects.toThrow("interrupted")
      expect(await cancelled).toEqual({ type: "cancel", executionID: "cme_cancel_test", reason: "interrupted" })
    } finally {
      server.stop(true)
    }
  })
})
