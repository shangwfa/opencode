import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { McpHttpBridge } from "../src/session/mcp-http-bridge"
import { McpClient } from "../src/mcp/client"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import { ProtocolError } from "@modelcontextprotocol/client"
import { hostEnvironmentLayer } from "./fixture/environment"

test("native bridge correlates duplicate ids, preserves Unicode, and stops the stdio process tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-mcp-"))
  const bridge = join(directory, "bridge.mjs")
  const fixture = join(directory, "fixture.mjs")
  await writeFile(bridge, McpHttpBridge.script)
  await writeFile(
    fixture,
    `
    import { createInterface } from "node:readline";
    const input = createInterface({ input: process.stdin });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      setTimeout(() => {
        const result = { value: message.params?.value, pid: process.pid };
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
      }, message.params?.delay ?? 0);
    });
  `,
  )
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("missing listen address")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const child = spawn("node", [bridge, "--stdio", `node '${fixture}'`, "--port", String(address.port)], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const exited = once(child, "exit")
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bridge readiness timed out")), 5000)
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("mcp-http-bridge:")) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once("error", reject)
    })
    const url = `http://127.0.0.1:${address.port}/mcp`
    const health = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1000) })
    expect(health.status).toBe(200)
    expect(health.headers.get("content-type")).toContain("application/json")
    expect(await health.json()).toEqual({ ready: true })
    const post = (body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      })
    const decode = async (response: Response) => {
      expect(response.status).toBe(200)
      const text = await response.text()
      return JSON.parse(
        text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          ?.slice(5) ?? "null",
      )
    }
    const [first, second] = await Promise.all([
      post({ jsonrpc: "2.0", id: 1, method: "probe", params: { value: "中文甲", delay: 100 } }).then(decode),
      post({ jsonrpc: "2.0", id: 1, method: "probe", params: { value: "中文乙", delay: 10 } }).then(decode),
    ])
    expect(first.id).toBe(1)
    expect(second.id).toBe(1)
    expect(first.result.value).toBe("中文甲")
    expect(second.result.value).toBe("中文乙")
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202)
    expect((await post(null)).status).toBe(400)
    const malformed = await fetch(url, { method: "POST", body: "{" })
    expect(malformed.status).toBe(400)
    process.kill(first.result.pid, "SIGTERM")
    let deadStatus = 200
    for (let attempt = 0; attempt < 50 && deadStatus === 200; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      deadStatus = (await fetch(new URL("/health", url), { signal: AbortSignal.timeout(1000) })).status
    }
    expect(deadStatus).toBe(503)
    child.kill("SIGTERM")
    await exited
    const gone = () => {
      try {
        process.kill(first.result.pid, 0)
        return false
      } catch {
        return true
      }
    }
    expect(gone()).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}, 15_000)

async function withInteractiveBridge(
  run: (post: (message: unknown) => Promise<Response>, url: string) => Promise<void>,
  timeout = 5000,
) {
  const directory = await mkdtemp(join(tmpdir(), "interactive-mcp-"))
  const bridge = join(directory, "bridge.mjs")
  const fixture = join(directory, "fixture.mjs")
  await writeFile(bridge, McpHttpBridge.script)
  await writeFile(
    fixture,
    `
    import { createInterface } from "node:readline";
    let parent;
    let initializations = 0;
    const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
    createInterface({ input: process.stdin }).on("line", line => {
      const m = JSON.parse(line);
      if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "interactive", version: String(++initializations) } } });
      if (m.method === "tools/list") return send({ id: m.id, result: { tools: [] } });
      if (m.method === "probe" || m.method === "tools/call") {
        parent = m;
        const method = m.params?.arguments?.method ?? m.params?.method ?? "sampling/createMessage";
        const params = method === "elicitation/create"
          ? { message: "输入中文", requestedSchema: { type: "object", properties: { name: { type: "string" } } } }
          : { maxTokens: 32, messages: [{ role: "user", content: { type: "text", text: "中文" } }], _meta: { "ai.opencode/sessionID": "forged" } };
        return send({ id: "same-server-id", method, params });
      }
      if (m.id === "same-server-id" && !m.method) {
        return send({ id: parent.id, result: { content: [{ type: "text", text: JSON.stringify(m.error ?? m.result) }] } });
      }
    });
  `,
  )
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("missing listen address")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const child = spawn(
    "node",
    [
      bridge,
      "--stdio",
      `node '${fixture}'`,
      "--port",
      String(address.port),
      "--timeout-ms",
      String(timeout),
      "--heartbeat-ms",
      "20",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )
  const exited = once(child, "exit")
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("bridge readiness timed out")), 5000)
      child.stdout.on("data", () => {
        clearTimeout(timer)
        resolve()
      })
      child.once("error", reject)
    })
    const url = `http://127.0.0.1:${address.port}/mcp`
    await run(
      (message) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(4000),
        }),
      url,
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM")
      await exited
    }
    await rm(directory, { recursive: true, force: true })
  }
}

async function* frames(response: Response) {
  let text = ""
  const decoder = new TextDecoder()
  for await (const chunk of response.body!) {
    text += decoder.decode(chunk, { stream: true })
    let end: number
    while ((end = text.indexOf("\n\n")) >= 0) {
      const frame = text.slice(0, end)
      text = text.slice(end + 2)
      const data = frame.split("\n").find((line) => line.startsWith("data:"))
      if (data) yield JSON.parse(data.slice(5))
    }
  }
}

test("independent clients initialize one shared stdio child only once", () => withInteractiveBridge(async (post) => {
  const message = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "replica", version: "1" } } }
  const first = (await frames(await post(message)).next()).value
  const second = await (await post({ ...message, id: 2 })).json()
  expect(first.result.serverInfo.version).toBe("1")
  expect(second).toMatchObject({ id: 2, result: { serverInfo: { version: "1" } } })
}))

for (const method of ["sampling/createMessage", "elicitation/create"]) {
  test(`routes ${method} only to its POST and accepts result/error responses once`, () =>
    withInteractiveBridge(async (post, url) => {
      const controller = new AbortController()
      const notifications = await fetch(url, { signal: controller.signal })
      const reader = notifications.body!.getReader()
      const greeting = await reader.read()
      expect(new TextDecoder().decode(greeting.value)).toContain(": connected")
      const notification = reader.read().then(
        (value) => new TextDecoder().decode(value.value),
        () => "",
      )
      const first = frames(await post({ jsonrpc: "2.0", id: 1, method: "probe", params: { method } }))
      const request = (await first.next()).value
      expect(request.method).toBe(method)
      expect(request.id).not.toBe("same-server-id")
      // A second caller reuses the same JSON-RPC ID; it must wait, not steal the request.
      const second = frames(await post({ jsonrpc: "2.0", id: 1, method: "probe", params: { method } }))
      expect((await post({ jsonrpc: "2.0", id: "guessed", result: {} })).status).toBe(404)
      const answer = { jsonrpc: "2.0", id: request.id, result: { action: "accept", content: { name: "中文甲" } } }
      expect((await post(answer)).status).toBe(202)
      expect((await post(answer)).status).toBe(404)
      const result = (await first.next()).value
      expect(result.id).toBe(1)
      expect(result.result.content[0].text).toContain("中文甲")
      const other = (await second.next()).value
      expect(other.id).not.toBe(request.id)
      expect((await post({ jsonrpc: "2.0", id: other.id, error: { code: -1, message: "用户拒绝" } })).status).toBe(202)
      expect((await second.next()).value.result.content[0].text).toContain("用户拒绝")
      await first.next()
      await second.next()
      controller.abort()
      expect(await notification).not.toContain(method)
      await reader.cancel().catch(() => {})
    }))
}

test("cancellation remaps the parent ID, invalidates pending reverse replies and never reuses a running child", () =>
  withInteractiveBridge(async (post) => {
    const stream = frames(await post({ jsonrpc: "2.0", id: 91, method: "probe" }))
    const request = (await stream.next()).value
    expect((await post({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 91 } })).status).toBe(
      202,
    )
    expect((await stream.next()).value.error.code).toBe(-32000)
    expect((await post({ jsonrpc: "2.0", id: request.id, result: {} })).status).toBe(404)
    const next = frames(await post({ jsonrpc: "2.0", id: 92, method: "probe" }))
    expect((await next.next()).value.error.code).toBe(-32000)
  }))

test("request timeout settles the stream and rejects late reverse replies", () =>
  withInteractiveBridge(async (post) => {
    const stream = frames(await post({ jsonrpc: "2.0", id: 1, method: "probe" }))
    const request = (await stream.next()).value
    expect((await stream.next()).value.error.code).toBe(-32000)
    expect((await post({ jsonrpc: "2.0", id: request.id, result: {} })).status).toBe(404)
  }, 150))

test("SDK sampling handler uses the actual serialized caller, not server-supplied metadata", () =>
  withInteractiveBridge(async (_post, url) => {
    const seen: string[] = []
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* McpClient.connect(
            "interactive",
            { type: "remote", url, oauth: false },
            "/workspace",
            undefined,
            undefined,
            undefined,
            {
              create: (input) =>
                Effect.sync(() => {
                  seen.push(input.sessionID!)
                  return { role: "assistant", model: "test", content: { type: "text", text: input.sessionID! } }
                }),
            },
          )

          return yield* Effect.all(
            ["ses_parent", "ses_child"].map((id) => client.callTool({ name: "probe", sessionID: Session.ID.make(id) })),
            { concurrency: "unbounded" },
          )
        }),
      ).pipe(Effect.provide(hostEnvironmentLayer)),
    )
    expect(seen).toEqual(["ses_parent", "ses_child"])
    expect(result[0]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ses_parent") })
    expect(result[1]?.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("ses_child") })
  }))

test("SDK preserves standard JSON-RPC rejection codes instead of wrapping them in FiberFailure", () =>
  withInteractiveBridge(async (_post, url) => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* McpClient.connect(
            "interactive",
            { type: "remote", url, oauth: false },
            "/workspace",
            undefined,
            undefined,
            undefined,
            {
              create: () => Effect.fail(new ProtocolError(-32602, "Unsupported sampling context")),
            },
          )
          return yield* client.callTool({ name: "probe", sessionID: Session.ID.make("ses_parent") })
        }),
      ).pipe(Effect.provide(hostEnvironmentLayer)),
    )
    const content = result.content[0]
    if (content?.type !== "text") throw new Error("missing MCP result text")
    expect(JSON.parse(content.text)).toMatchObject({ code: -32602, message: "Unsupported sampling context" })
  }))

test("POST SSE stays active with comment heartbeats during a pending reverse request", () =>
  withInteractiveBridge(async (post) => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "probe" })
    const reader = response.body!.getReader()
    let text = ""
    try {
      while (true) {
        const request = text.indexOf("sampling/createMessage")
        if (request >= 0 && text.indexOf(": ping\n\n", request) >= 0) break
        const chunk = await reader.read()
        if (chunk.done) throw new Error("SSE ended before heartbeat")
        text += new TextDecoder().decode(chunk.value)
      }
      expect(text).toContain("sampling/createMessage")
      expect(text).not.toContain('"result"')
    } finally {
      await reader.cancel()
    }
  }))
