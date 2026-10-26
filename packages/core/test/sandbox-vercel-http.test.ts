import { expect, it } from "bun:test"
import { createServer } from "node:http"
import { once } from "node:events"
import { resume } from "@opencode/core/sandbox/vercel/client"
import { start } from "@opencode/core/sandbox/vercel/command"
import type { Transport } from "@opencode/core/sandbox/vercel/transport"
import { credentials, fixture } from "./fixture/vercel"

for (const failure of ["disconnect", "redirect"] as const) {
  it(`real HTTP ${failure} cannot duplicate a Vercel command submission`, async () => {
    let submissions = 0
    let redirected = 0
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost")
      if (request.method === "POST" && url.pathname.endsWith("/cmd")) {
        submissions++
        if (failure === "disconnect") request.socket.destroy()
        else {
          response.writeHead(307, { location: "/redirected" })
          response.end()
        }
        return
      }
      if (url.pathname === "/redirected") {
        redirected++
        response.writeHead(500)
        response.end()
        return
      }
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify(fixture()))
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    try {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Test HTTP server did not bind")
      const local: Transport = Object.assign((input: Parameters<Transport>[0], init?: Parameters<Transport>[1]) => {
        const url = new URL(String(input))
        url.protocol = "http:"
        url.host = `127.0.0.1:${address.port}`
        return fetch(url, init)
      }, { preconnect() {} })
      const signal = AbortSignal.timeout(10_000)
      const active = await resume({ ...credentials, fetch: local, signal })
      await expect(start(active, { cmd: "sh", args: ["-c", "echo write"], signal })).rejects.toThrow()
      expect(submissions).toBe(1)
      expect(redirected).toBe(0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
}
