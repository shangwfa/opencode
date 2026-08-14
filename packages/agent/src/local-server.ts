import { createServer } from "node:http"
import type { PathMapper } from "./path"

const LOCAL_PORT = 17790

export function startLocalServer(mapper: PathMapper, agentVersion: string) {
  let agentID: string | null = null

  const server = createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*")
    res.setHeader("Access-Control-Allow-Headers", "Content-Type")
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS")

    if (req.method === "OPTIONS") {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? "/", "http://localhost")

    if (url.pathname === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ ok: true, agentID, workdir: mapper.dir, agentVersion }))
      return
    }

    res.writeHead(404)
    res.end("Not Found")
  })

  server.listen(LOCAL_PORT, "127.0.0.1", () => {
    console.log(`[agent] local health server on http://localhost:${LOCAL_PORT}`)
  })

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[agent] port ${LOCAL_PORT} already in use, skipping local health server`)
    } else {
      console.error("[agent] local server error:", err.message)
    }
  })

  return {
    setAgentID(id: string) {
      agentID = id
    },
    close() {
      server.close()
    },
  }
}
