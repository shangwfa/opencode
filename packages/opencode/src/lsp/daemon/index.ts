import http from "http"
import path from "path"
import fs from "fs"
import { LspManager } from "./lsp-manager"

const port = Number(process.env.LSP_AGENT_PORT ?? "20877")
const workspace = process.env.LSP_WORKSPACE_ROOT ?? "/workspace"
const manager = new LspManager()

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body)
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  })
  res.end(data)
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`)
  const method = req.method ?? "GET"

  try {
    if (method === "POST" && url.pathname === "/lsp/touch") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'path'" })
        return
      }
      const version = await manager.touchFile(body.path)
      sendJson(res, 200, { version })
      return
    }

    if (method === "POST" && url.pathname === "/lsp/diagnostics") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'path'" })
        return
      }
      const diagnostics = await manager.getDiagnostics(body.path, body.wait !== false)
      sendJson(res, 200, { diagnostics })
      return
    }

    if (method === "POST" && url.pathname === "/lsp/hover") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string" || typeof body.line !== "number" || typeof body.character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      const result = await manager.hover(body.path, body.line, body.character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/definition") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string" || typeof body.line !== "number" || typeof body.character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      const result = await manager.definition(body.path, body.line, body.character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/references") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string" || typeof body.line !== "number" || typeof body.character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      const result = await manager.references(body.path, body.line, body.character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/implementation") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string" || typeof body.line !== "number" || typeof body.character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      const result = await manager.implementation(body.path, body.line, body.character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/prepareCallHierarchy") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string" || typeof body.line !== "number" || typeof body.character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      const result = await manager.prepareCallHierarchy(body.path, body.line, body.character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/incomingCalls") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string" || typeof body.line !== "number" || typeof body.character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      const result = await manager.incomingCalls(body.path, body.line, body.character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/outgoingCalls") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string" || typeof body.line !== "number" || typeof body.character !== "number") {
        sendJson(res, 400, { error: "missing or invalid 'path', 'line', or 'character'" })
        return
      }
      const result = await manager.outgoingCalls(body.path, body.line, body.character)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/documentSymbol") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.path !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'path'" })
        return
      }
      const result = await manager.documentSymbol(body.path)
      sendJson(res, 200, result)
      return
    }

    if (method === "POST" && url.pathname === "/lsp/workspaceSymbol") {
      const body = JSON.parse(await readBody(req))
      if (typeof body.query !== "string") {
        sendJson(res, 400, { error: "missing or invalid 'query'" })
        return
      }
      const result = await manager.workspaceSymbol(body.query)
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
