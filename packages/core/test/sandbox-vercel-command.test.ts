import { describe, expect, it } from "bun:test"
import { APIError } from "@vercel/sandbox"
import { resume } from "@opencode/core/sandbox/vercel/client"
import { cancel, observe, start, type CommandRef } from "@opencode/core/sandbox/vercel/command"
import { command, credentials, error, fixture, logs, transport } from "./fixture/vercel"

const task: CommandRef = { sandboxName: "oc-test", generation: "vm-1", commandID: "cmd-1" }

const interrupted = (signal?: AbortSignal | null) => new Promise<Response>((_, reject) => {
  if (signal?.aborted) return reject(signal.reason)
  signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
})

describe("Vercel pinned command operations", () => {
  it("submits once and returns a generation-scoped command identity", async () => {
    const mock = transport((call) => {
      if (call.path.endsWith("/cmd") && call.body.timeout === 0) return error(400, "timeout_must_be_at_least_100")
      return Response.json(call.path.endsWith("/cmd") ? { command: command() } : fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    expect(await start(active, { cmd: "sh", args: ["-c", "exit 7"], timeoutMs: 0 })).toEqual(task)
    expect(mock.calls[1].body).toMatchObject({ command: "sh", args: ["-c", "exit 7"], cwd: "/workspace" })
    expect(mock.calls[1].body.timeout).toBeUndefined()
    expect(mock.calls[1].body.wait).toBeUndefined()
  })

  it("keeps draining logs past the limit and forwards full output to the producer", async () => {
    const data = [{ stream: "stdout" as const, data: "hello " }, { stream: "stderr" as const, data: "world" }]
    let delivered = ""
    const mock = transport((call) => {
      if (call.path.endsWith("/logs")) return logs(data)
      if (call.path.includes("/cmd/")) return Response.json({ command: command(call.query.get("wait") ? 7 : null) })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    const result = await observe(active, task, { maxBytes: 4, onOutput: async (chunk) => { delivered += chunk.data } })
    expect(result).toEqual({ exitCode: 7, output: "hell", truncated: true })
    expect(delivered).toBe("hello world")
    expect(mock.calls.some((call) => call.query.get("wait") === "true")).toBe(true)
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("does not corrupt a multibyte character at the capture boundary", async () => {
    const mock = transport((call) => {
      if (call.path.endsWith("/logs")) return logs([{ stream: "stdout", data: "中文" }])
      if (call.path.includes("/cmd/")) return Response.json({ command: command(0) })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    expect(await observe(active, task, { maxBytes: 4 })).toEqual({ exitCode: 0, output: "中", truncated: true })
  })

  it("a zero capture limit still drains both streams", async () => {
    let chunks = 0
    const mock = transport((call) => {
      if (call.path.endsWith("/logs")) return logs([{ stream: "stdout", data: "a" }, { stream: "stderr", data: "b" }])
      if (call.path.includes("/cmd/")) return Response.json({ command: command(0) })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    expect(await observe(active, task, { maxBytes: 0, onOutput: async () => { chunks++ } })).toEqual({ exitCode: 0, output: "", truncated: true })
    expect(chunks).toBe(2)
  })

  for (const ref of [{ ...task, generation: "vm-old" }, { ...task, sandboxName: "other-workspace" }]) {
    it(`rejects stale command ${ref.sandboxName}/${ref.generation} without a request`, async () => {
      const mock = transport(() => Response.json(fixture()))
      const active = await resume({ ...credentials, fetch: mock.fetch })
      await expect(observe(active, ref, { maxBytes: 32 })).rejects.toThrow("different sandbox generation")
      await expect(cancel(active, ref)).rejects.toThrow("different sandbox generation")
      expect(mock.calls).toHaveLength(1)
    })
  }

  it("cancels only the referenced task and confirms its exit", async () => {
    const mock = transport((call) => {
      if (call.path.includes("/cmd/")) return Response.json({ command: command(call.query.get("wait") ? 143 : null) })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    expect(await cancel(active, task)).toEqual({ exitCode: 143 })
    expect(mock.calls.filter((call) => call.method === "POST").map((call) => call.body.signal)).toEqual([15])
    expect(mock.calls.filter((call) => call.path.includes("/cmd/")).every((call) => call.path.includes("/vm-1/cmd/cmd-1"))).toBe(true)
  })

  it("escalates to SIGKILL only after the graceful wait expires", async () => {
    let killed = false
    const mock = transport(async (call) => {
      if (!call.path.includes("/cmd/")) return Response.json(fixture())
      if (call.path.endsWith("/kill")) {
        if (call.body.signal === 9) killed = true
        return Response.json({ command: command() })
      }
      if (call.query.get("wait") && !killed) {
        return interrupted(call.signal)
      }
      return Response.json({ command: command(killed ? 137 : null) })
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    expect(await cancel(active, task, { graceMs: 5 })).toEqual({ exitCode: 137 })
    expect(mock.calls.filter((call) => call.method === "POST").map((call) => call.body.signal)).toEqual([15, 9])
  })

  it("does not kill an already completed task", async () => {
    const mock = transport((call) => Response.json(call.path.includes("/cmd/") ? { command: command(0) } : fixture()))
    const active = await resume({ ...credentials, fetch: mock.fetch })
    expect(await cancel(active, task)).toEqual({ exitCode: 0 })
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("does not mistake a failed wait for graceful timeout", async () => {
    const mock = transport((call) => {
      if (call.query.get("wait")) return error(403, "forbidden")
      if (call.path.includes("/cmd/")) return Response.json({ command: command() })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    await expect(cancel(active, task)).rejects.toBeInstanceOf(APIError)
    expect(mock.calls.filter((call) => call.method === "POST").map((call) => call.body.signal)).toEqual([15])
  })

  it("does not confirm cancellation when the post-SIGKILL wait fails", async () => {
    let killed = false
    const mock = transport((call) => {
      if (!call.path.includes("/cmd/")) return Response.json(fixture())
      if (call.path.endsWith("/kill")) {
        if (call.body.signal === 9) killed = true
        return Response.json({ command: command() })
      }
      if (call.query.get("wait")) return killed ? error(403, "cannot_confirm_exit") : interrupted(call.signal)
      return Response.json({ command: command() })
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    await expect(cancel(active, task, { graceMs: 5 })).rejects.toBeInstanceOf(APIError)
    expect(mock.calls.filter((call) => call.method === "POST").map((call) => call.body.signal)).toEqual([15, 9])
  })

  it("does not escalate when the caller interrupts the graceful wait", async () => {
    const controller = new AbortController()
    const cause = new Error("caller cancelled")
    const mock = transport((call) => {
      if (call.query.get("wait")) {
        const pending = interrupted(call.signal)
        controller.abort(cause)
        return pending
      }
      if (call.path.includes("/cmd/")) return Response.json({ command: command() })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    await expect(cancel(active, task, { signal: controller.signal })).rejects.toBe(cause)
    expect(mock.calls.filter((call) => call.method === "POST").map((call) => call.body.signal)).toEqual([15])
  })

  it("rejects mismatched command metadata before observing or killing", async () => {
    const mock = transport((call) => Response.json(call.path.includes("/cmd/")
      ? { command: { ...command(), id: "another-command" } }
      : fixture()))
    const active = await resume({ ...credentials, fetch: mock.fetch })
    await expect(cancel(active, task)).rejects.toThrow("identity mismatch")
    await expect(observe(active, task, { maxBytes: 32 })).rejects.toThrow("identity mismatch")
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("propagates producer output failures without resubmitting execution", async () => {
    const cause = new Error("producer could not persist output")
    const mock = transport((call) => {
      if (call.path.endsWith("/logs")) return logs([{ stream: "stdout", data: "output" }])
      if (call.path.includes("/cmd/")) return Response.json({ command: command() })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    await expect(observe(active, task, { maxBytes: 32, onOutput: async () => { throw cause } })).rejects.toBe(cause)
    expect(mock.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("drains a large log stream while retaining only the requested prefix", async () => {
    let sent = 0
    let delivered = 0
    const mock = transport((call) => {
      if (call.path.endsWith("/logs")) return new Response(new ReadableStream({
        pull(controller) {
          if (sent++ === 128) return controller.close()
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ stream: "stdout", data: "x".repeat(1024) }) + "\n"))
        },
      }), { headers: { "content-type": "application/x-ndjson" } })
      if (call.path.includes("/cmd/")) return Response.json({ command: command(0) })
      return Response.json(fixture())
    })
    const active = await resume({ ...credentials, fetch: mock.fetch })
    const result = await observe(active, task, { maxBytes: 64, onOutput: async (chunk) => { delivered += chunk.data.length } })
    expect(result).toEqual({ exitCode: 0, output: "x".repeat(64), truncated: true })
    expect(delivered).toBe(128 * 1024)
  })

  it("rejects invalid limits and pre-cancellation before command requests", async () => {
    const mock = transport(() => Response.json(fixture()))
    const active = await resume({ ...credentials, fetch: mock.fetch })
    await expect(start(active, { cmd: "sh", timeoutMs: -1 })).rejects.toThrow("Invalid Vercel command timeout")
    await expect(observe(active, task, { maxBytes: Infinity })).rejects.toThrow("Invalid Vercel command output limit")
    await expect(cancel(active, task, { graceMs: NaN })).rejects.toThrow("Invalid Vercel command termination grace")
    const controller = new AbortController()
    controller.abort(new Error("cancelled"))
    await expect(cancel(active, task, { signal: controller.signal })).rejects.toThrow("cancelled")
    expect(mock.calls).toHaveLength(1)
  })
})
