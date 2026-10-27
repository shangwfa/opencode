import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeModeRunner } from "../src/codemode/runner"
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import net from "node:net"
import { createRequire } from "node:module"
import { it } from "./lib/effect"

test("sandbox Runner sends WebSocket control heartbeats while awaiting human input", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "runner-heartbeat-"))
  const require = createRequire(import.meta.url)
  const wsPath = require.resolve("ws", { paths: [path.resolve(import.meta.dir, "../../cli")] })
  const { WebSocket } = require(wsPath)
  const listener = net.createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("missing fixture port")
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const source = (
    await readFile(path.resolve(import.meta.dir, "../../containers/sandbox/opt/codemode-runner.ts"), "utf8")
  )
    .replace('from "@opencode/codemode"', `from ${JSON.stringify(import.meta.resolve("@opencode/codemode"))}`)
    .replace('from "effect"', `from ${JSON.stringify(import.meta.resolve("effect"))}`)
    .replace('from "ws"', `from ${JSON.stringify(wsPath)}`)
    .replace("15_000", "20")
  const script = path.join(directory, "runner.ts")
  await writeFile(script, source)
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, OPENCODE_CODEMODE_RUNNER_PORT: String(address.port) },
    stdout: "pipe",
    stderr: "pipe",
  })
  let socket: InstanceType<typeof WebSocket> | undefined
  try {
    const ready = child.stdout.getReader()
    await ready.read()
    ready.releaseLock()
    socket = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runner heartbeat missing")), 5000)
      let pings = 0
      socket.on("ping", () => {
        if (++pings === 2) {
          clearTimeout(timer)
          resolve()
        }
      })
      socket.once("error", reject)
    })
    expect(socket.readyState).toBe(WebSocket.OPEN)
  } finally {
    socket?.terminate()
    child.kill()
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

async function launcherFixture(delay: number, crashes = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "codemode-ready-"))
  const listener = net.createServer()
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("missing fixture port")
  const port = address.port
  await new Promise<void>((resolve) => listener.close(() => resolve()))
  const pidFile = path.join(directory, "runner.pid")
  const script = path.join(directory, "runner.mjs")
  await writeFile(
    script,
    crashes
      ? "process.exit(1)"
      : `import net from 'node:net'; setTimeout(()=>net.createServer(s=>s.end()).listen(${port},'127.0.0.1'),${delay})`,
  )
  const flock = path.join(directory, "flock")
  // macOS has no flock. This fixture exercises the launched command and local
  // readiness; real lock behavior remains covered by Linux sandbox probes.
  await writeFile(flock, '#!/bin/sh\nshift 4\nexec sh -c "$1"\n')
  await chmod(flock, 0o755)
  const command = CodeModeRunner.startCommand()
    .replaceAll("/opt/opencode-codemode-runner.mjs", script)
    .replaceAll("/tmp/opencode-codemode-runner.pid", pidFile)
    .replaceAll("/tmp/opencode-codemode-runner.log", path.join(directory, "runner.log"))
    .replaceAll("9911", String(port))
    .replaceAll("7500", "400")
  const run = async () => {
    const child = Bun.spawn(["sh", "-c", command], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exitCode, stdout, stderr }
  }
  const listening = async () =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" })
      socket.on("connect", () => {
        socket.destroy()
        resolve(true)
      })
      socket.on("error", () => {
        socket.destroy()
        resolve(false)
      })
    })
  const cleanup = async () => {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""))
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    await rm(directory, { recursive: true, force: true })
  }
  return { run, listening, cleanup, pidFile }
}

it.live("launcher waits for a delayed Runner listener and reuses a warm daemon", () =>
  Effect.promise(async () => {
    const fixture = await launcherFixture(150)
    try {
      expect((await fixture.run()).exitCode).toBe(0)
      expect(await fixture.listening()).toBe(true)
      const pid = await readFile(fixture.pidFile, "utf8")
      expect((await fixture.run()).exitCode).toBe(0)
      expect(await readFile(fixture.pidFile, "utf8")).toBe(pid)
    } finally {
      await fixture.cleanup()
    }
  }),
)

it.live("launcher fails within its readiness budget when the daemon never listens", () =>
  Effect.promise(async () => {
    const fixture = await launcherFixture(60000)
    try {
      const result = await fixture.run()
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain("readiness timed out")
    } finally {
      await fixture.cleanup()
    }
  }),
)

it.live("launcher reports a daemon that exits before listening", () =>
  Effect.promise(async () => {
    const fixture = await launcherFixture(0, true)
    try {
      expect((await fixture.run()).exitCode).not.toBe(0)
      expect(await fixture.listening()).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  }),
)

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
        if (request.headers.get("e2b-traffic-access-token") !== "test-traffic-token") return new Response("forbidden", { status: 403 })
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
        headers: { "e2b-traffic-access-token": "test-traffic-token" },
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

  test("a resolved gateway does not establish readiness of a cold Runner", async () => {
    let ready = false
    let launches = 0
    const server = Bun.serve({
      port: 0,
      fetch(request, current) {
        if (current.upgrade(request, { data: undefined })) return undefined
        return new Response("websocket required", { status: 400 })
      },
      websocket: {
        open(socket) {
          if (!ready) socket.close(1011, "runner target is not listening")
        },
        message(socket, raw) {
          const frame = JSON.parse(String(raw))
          socket.send(
            JSON.stringify({
              type: "execution.result",
              executionID: frame.executionID,
              result: { ok: true, value: 7, toolCalls: [] },
            }),
          )
        },
      },
    })
    try {
      const endpoint = { _tag: "resolved" as const, sandboxId: "sb_cold_runner", endpoint: `127.0.0.1:${server.port}` }
      const provider = {
        run: () =>
          Effect.sync(() => {
            launches++
            return { exitCode: 0, output: "runner-started", timedOut: false }
          }),
        endpoint: () => Effect.succeed(endpoint),
      }
      const returned = await Effect.runPromise(
        CodeModeRunner.start({ provider: provider as never, sessionID: "ses_cold_runner", hostWorkdir: "/workspace" }),
      )
      expect(launches).toBe(1)
      expect(ready).toBe(false)
      const execute = () =>
        CodeModeRunner.execute({
          endpoint: returned.endpoint,
          executionID: "cme_cold_runner",
          code: "return 7",
          web: false,
          tools: [],
          limits: {},
          tool: async () => {
            throw new Error("unexpected tool callback")
          },
        })
      await expect(execute()).rejects.toThrow("connection closed before completion")
      ready = true
      await expect(execute()).resolves.toEqual({ ok: true, value: 7, toolCalls: [] })
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
