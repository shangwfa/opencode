import { expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { once } from "node:events"
import { Effect } from "effect"
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { SandboxFilesTimeoutError, sandboxFilesRequest, withSandboxFilesTimeout } from "@opencode/core/sandbox/provider"

test("files timeout aborts the actual Sandbox files HTTP request and returns a typed timeout", async () => {
  let requestAborted!: () => void
  const aborted = new Promise<void>((resolve) => (requestAborted = resolve))
  let fileRequestSeen!: () => void
  const fileRequest = new Promise<void>((resolve) => (fileRequestSeen = resolve))
  let server!: Server
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    if (url.pathname.endsWith("/endpoints/44772") || url.pathname.endsWith("/endpoints/18080")) {
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("mock server has no TCP address")
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({ endpoint: `127.0.0.1:${address.port}` }))
      return
    }
    if (url.pathname === "/files/download") {
      expect(url.searchParams.get("path")).toBe("/workspace/hung.txt")
      fileRequestSeen()
      request.once("aborted", requestAborted)
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("timeout test server failed to bind")

  let sandbox: Sandbox | undefined
  try {
    const connected = await Sandbox.connect({
      connectionConfig: new ConnectionConfig({
        domain: `http://127.0.0.1:${address.port}`,
        requestTimeoutSeconds: 30,
        disableMetrics: true,
      }),
      sandboxId: "sandbox-files-timeout-test",
      skipHealthCheck: true,
    })
    sandbox = connected
    const startedAt = Date.now()
    const error = await Effect.runPromise(
      withSandboxFilesTimeout({
        operation: "readFile",
        path: "/workspace/hung.txt",
        timeoutSeconds: 0.025,
        retries: 0,
        run: (signal) =>
          sandboxFilesRequest(connected, "/files/download", "/workspace/hung.txt", signal).then((response) =>
            response.text(),
          ),
      }).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(SandboxFilesTimeoutError)
    if (error instanceof SandboxFilesTimeoutError) expect(error.operation).toBe("readFile")
    expect(Date.now() - startedAt).toBeLessThan(1000)
    await fileRequest
    await aborted
  } finally {
    await sandbox?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
