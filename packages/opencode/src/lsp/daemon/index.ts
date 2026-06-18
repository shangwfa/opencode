import http from "http"
import path from "path"
import fs from "fs"
import { LspManager } from "./lsp-manager"

const port = Number(process.env.LSP_AGENT_PORT ?? "20877")
const workspace = process.env.LSP_WORKSPACE_ROOT ?? "/workspace"
const manager = new LspManager()

// Upper bound on a single request body. LSP payloads are tiny (file path +
// position), so 1 MiB is generous and stops a malicious/buggy caller from
// exhausting container memory via unbounded chunk accumulation.
const MAX_BODY_BYTES = 1024 * 1024

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  })
  res.end(data)
}

class BodyTooLargeError extends Error {}
class InvalidJsonError extends Error {}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    let rejected = false
    req.on("data", (chunk: Buffer) => {
      if (rejected) return
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        // Stop accumulating and reject, but do NOT call req.destroy():
        // destroying the socket also tears down the response stream, so the
        // 413 we send from the outer catch would never reach the client
        // (curl sees only the auto-sent 100-continue + a reset). Letting the
        // request drain lets res send the error cleanly.
        rejected = true
        reject(new BodyTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"))
    })
    req.on("error", reject)
  })
}

// Parse JSON body; throws InvalidJsonError on malformed JSON so the outer
// catch can answer 400 with a precise message instead of a generic 500.
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readBody(req)
  try {
    return JSON.parse(raw)
  } catch {
    throw new InvalidJsonError()
  }
}

// Reject paths that escape the workspace root. normalize() collapses `..`
// segments, then we require the result to be the workspace itself or live
// under it. This is the last line of defense: even if a caller passes an
// absolute host path, the daemon must not touch files outside /workspace.
function assertWorkspacePath(p: string) {
  const normalized = path.normalize(p).replace(/\\/g, "/")
  if (normalized !== workspace && !normalized.startsWith(workspace + "/")) {
    throw new Error("path outside workspace")
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`)
  const method = req.method ?? "GET"

  try {
    if (method === "POST" && url.pathname === "/lsp/touch") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'path'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const version = await manager.touchFile((body as any).path)
      sendJson(res, 200, { version })
      return
    }

    if (method === "POST" && url.pathname === "/lsp/diagnostics") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'path'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const diagnostics = await manager.getDiagnostics((body as any).path, (body as any).wait !== false)
      sendJson(res, 200, { diagnostics })
      return
    }

    if (method === "POST" && url.pathname === "/lsp/hover") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string" || typeof (body as any).line !== "number" || typeof (body as any).character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.hover((body as any).path, (body as any).line, (body as any).character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/definition") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string" || typeof (body as any).line !== "number" || typeof (body as any).character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.definition((body as any).path, (body as any).line, (body as any).character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/references") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string" || typeof (body as any).line !== "number" || typeof (body as any).character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.references((body as any).path, (body as any).line, (body as any).character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/implementation") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string" || typeof (body as any).line !== "number" || typeof (body as any).character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.implementation((body as any).path, (body as any).line, (body as any).character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/prepareCallHierarchy") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string" || typeof (body as any).line !== "number" || typeof (body as any).character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.prepareCallHierarchy((body as any).path, (body as any).line, (body as any).character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/incomingCalls") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string" || typeof (body as any).line !== "number" || typeof (body as any).character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.incomingCalls((body as any).path, (body as any).line, (body as any).character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/outgoingCalls") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string" || typeof (body as any).line !== "number" || typeof (body as any).character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.outgoingCalls((body as any).path, (body as any).line, (body as any).character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/documentSymbol") {
      const body = await readJsonBody(req)
      if (typeof (body as any).path !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'path'" })
        return
      }
      assertWorkspacePath((body as any).path)
      const result = await manager.documentSymbol((body as any).path)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/workspaceSymbol") {
      const body = await readJsonBody(req)
      if (typeof (body as any).query !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'query'" })
        return
      }
      const result = await manager.workspaceSymbol((body as any).query)
      sendJson(res, 200, result)
      return
    }

    if (method === "GET" && url.pathname === "/lsp/status") {
      sendJson(res, 200, { servers: manager.getStatus() })
      return
    }

    if (method === "POST" && url.pathname === "/lsp/shutdown") {
      sendJson(res, 200, { ok: true })
      res.on("finish", () => {
        manager.shutdown().finally(() => process.exit(0))
      })
      return
    }

    sendJson(res, 404, { error: "not found" })
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "request body too large" })
      return
    }
    if (err instanceof InvalidJsonError) {
      sendJson(res, 400, { error: "invalid JSON" })
      return
    }
    if (err instanceof Error && err.message === "path outside workspace") {
      sendJson(res, 400, { error: "path outside workspace" })
      return
    }
    process.stderr.write(`[daemon] unhandled error: ${String(err)}\n`)
    sendJson(res, 500, { error: "internal error" })
  }
})

server.listen(port, "0.0.0.0", () => {
  process.stderr.write(`[daemon] listening on 0.0.0.0:${port}\n`)
  warmup()
})

function warmup() {
  try {
    if (!fs.existsSync(path.join(workspace, "tsconfig.json"))) {
      process.stderr.write("[daemon] warmup: no tsconfig.json found, skipping\n")
      return
    }
    process.stderr.write("[daemon] warmup: tsconfig.json found, pre-starting TS server\n")
    manager
      .ensureServer(path.join(workspace, "__warmup__.ts"))
      .then((id) => {
        if (id) process.stderr.write("[daemon] warmup: TS server pre-started\n")
        else process.stderr.write("[daemon] warmup: skipped (not a TS file)\n")
      })
      .catch((err) => {
        process.stderr.write(`[daemon] warmup failed: ${String(err)}\n`)
      })
  } catch (err) {
    process.stderr.write(`[daemon] warmup error: ${String(err)}\n`)
  }
}

function gracefulShutdown() {
  process.stderr.write("[daemon] shutting down\n")
  server.close()
  manager.shutdown().finally(() => process.exit(0))
}

process.on("SIGTERM", gracefulShutdown)
process.on("SIGINT", gracefulShutdown)
