// Port gate script contract: token prefix required, stripped before forwarding,
// upstream never sees the token; WebSocket upgrades pipe through; HTTP verbatim.
import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { writeFile, mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  GATE_OFFSET,
  INITIAL_GATE_PORTS,
  MAX_PORTS,
  script,
  startCommand,
  TOKEN_PREFIX,
  withGatePort,
} from "../src/sandbox/vercel/port-gate"

const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port))
  })

test("gate requires the token, strips it, and forwards HTTP and WebSocket verbatim", async () => {
  const seen: { url: string | undefined; host: string | undefined; body: string }[] = []
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    seen.push({ url: request.url, host: request.headers.host, body: Buffer.concat(chunks).toString("utf8") })
    response.writeHead(201, { "x-upstream": "yes" })
    response.end(`ok:${request.url}`)
  })
  const upgraded = new Promise<string>((resolve) => {
    upstream.on("upgrade", (request, socket) => {
      resolve(request.url ?? "")
      socket.destroy()
    })
  })
  const target = await listen(upstream)
  const directory = await mkdtemp(path.join(os.tmpdir(), "port-gate-"))
  const file = path.join(directory, "port-gate.mjs")
  await writeFile(file, script)
  const token = "test-token-abc"
  const probe = createServer()
  const gatePort = await listen(probe)
  probe.close()
  // The gate runs under node inside Vercel images; bun's node:http lacks the
  // 'upgrade' event the WebSocket proxy needs, so spawn node for fidelity.
  const child = spawn("node", [file, "--port", String(gatePort), "--target", String(target), "--token", token], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("gate did not start")), 5000)
      child.stdout.on("data", (chunk) => {
        if (String(chunk).includes("port-gate:")) {
          clearTimeout(timer)
          resolve(undefined)
        }
      })
      child.stderr.on("data", (chunk) => reject(new Error(String(chunk))))
    })
    const rejected = await fetch(`http://127.0.0.1:${gatePort}/mcp`, { method: "POST", body: "nope" })
    expect(rejected.status).toBe(404)
    expect(seen).toHaveLength(0)

    const forwarded = await fetch(`http://127.0.0.1:${gatePort}${TOKEN_PREFIX}${token}/mcp?q=1`, {
      method: "POST",
      headers: { "x-test": "1" },
      body: "hello",
    })
    expect(forwarded.status).toBe(201)
    expect(forwarded.headers.get("x-upstream")).toBe("yes")
    expect(await forwarded.text()).toBe("ok:/mcp?q=1")
    expect(seen).toEqual([{ url: "/mcp?q=1", host: `127.0.0.1:${target}`, body: "hello" }])

    const socket = new WebSocket(`ws://127.0.0.1:${gatePort}${TOKEN_PREFIX}${token}/ws-path`)
    socket.addEventListener("error", () => {})
    expect(await upgraded).toBe("/ws-path")
  } finally {
    child.kill()
    upstream.close()
  }
})

test("gate start command pins token, ports, and readiness probing", () => {
  const command = startCommand({ listen: 19911, target: 9911, token: "tok'quote" })
  expect(command).toContain("--port 19911 --target 9911")
  expect(command).toContain("--token 'tok'\\''quote'")
  expect(command).toContain("port-gate.mjs")
  expect(command).toContain("node -e")
  expect(GATE_OFFSET).toBe(10_000)
})

test("lazily registered gate ports merge, stay idempotent, and respect the Vercel cap", () => {
  expect(INITIAL_GATE_PORTS).toEqual([19911, 19912])
  expect(withGatePort(INITIAL_GATE_PORTS, 18_080)).toEqual([18_080, 19_911, 19_912])
  expect(withGatePort([18_080, 19_911], 19_911)).toEqual([18_080, 19_911])
  const full = Array.from({ length: MAX_PORTS }, (_, index) => 20_000 + index)
  expect(() => withGatePort(full, 21_000)).toThrow(`at most ${MAX_PORTS} ports`)
})
