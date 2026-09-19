import { expect, test } from "bun:test"
import { createHmac } from "node:crypto"

const script = new URL("../../docker/opt/opencode-pty-agent.ts", import.meta.url).pathname

test("PTY agent authenticates requests and isolates sessions", async () => {
  const port = 41_000 + Math.floor(Math.random() * 1_000)
  const token = crypto.randomUUID()
  const process = Bun.spawn([Bun.which("bun") ?? "bun", script], {
    env: { ...Bun.env, OPENCODE_PTY_AGENT_PORT: String(port), OPENCODE_PTY_AGENT_TOKEN: token },
    stdout: "ignore",
    stderr: "pipe",
  })
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: `Bearer ${token}` }

  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const ready = await fetch(`${base}/health`, { headers }).then((response) => response.ok).catch(() => false)
      if (ready) break
      await Bun.sleep(50)
    }

    expect((await fetch(`${base}/health`)).status).toBe(401)
    expect(await fetch(`${base}/health`, { headers }).then((response) => response.json())).toMatchObject({
      status: "ready",
      protocolVersion: 1,
      instanceID: expect.any(String),
    })
    const created = await fetch(`${base}/pty?sessionID=ses_a`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ command: "/bin/cat", title: "isolated" }),
    })
    expect(created.status).toBe(201)
    const info = (await created.json()) as { id: string }

    expect((await fetch(`${base}/pty/${info.id}?sessionID=ses_b`, { headers })).status).toBe(404)
    expect((await fetch(`${base}/pty/${info.id}?sessionID=ses_a`, { headers })).status).toBe(200)
    const expires = Date.now() + 30_000
    const websocketToken = createHmac("sha256", token).update(`ses_a:${info.id}:${expires}`).digest("hex")
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        `${base.replace("http", "ws")}/pty/${info.id}/connect?sessionID=ses_a&expires=${expires}&token=${websocketToken}`,
      )
      const timeout = setTimeout(() => reject(new Error("PTY websocket timed out")), 5_000)
      let output = ""
      socket.onopen = () => {
        socket.send(new Uint8Array([0xff]))
        socket.send("PTY_INVALID_UTF8_OK\n")
      }
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return
        output += event.data
        if (!output.includes("PTY_INVALID_UTF8_OK")) return
        clearTimeout(timeout)
        socket.close()
        resolve()
      }
      socket.onerror = () => reject(new Error("PTY websocket failed"))
    })
    const createdEvents = await fetch(`${base}/pty/events`, { headers })
    const createdReader = createdEvents.body!.getReader()
    const createdFrame = new TextDecoder().decode((await createdReader.read()).value)
    await createdReader.cancel()
    expect(createdFrame).toContain("pty.created")
    const cursor = createdFrame.match(/id: (\d+)/)?.[1]
    expect(cursor).toBeDefined()

    expect((await fetch(`${base}/pty/${info.id}?sessionID=ses_a`, { method: "DELETE", headers })).status).toBe(204)
    const deletedEvents = await fetch(`${base}/pty/events`, { headers: { ...headers, "last-event-id": cursor! } })
    const deletedReader = deletedEvents.body!.getReader()
    const deletedFrame = new TextDecoder().decode((await deletedReader.read()).value)
    await deletedReader.cancel()
    expect(deletedFrame).toContain("pty.deleted")
  } finally {
    process.kill("SIGTERM")
    await process.exited
  }
})
