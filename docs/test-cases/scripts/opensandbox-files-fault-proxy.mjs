import http from "node:http"

const upstream = new URL(process.env.OPENSANDBOX_UPSTREAM ?? "http://127.0.0.1:8080")
const host = process.env.FAULT_PROXY_HOST ?? "127.0.0.1"
const port = Number(process.env.FAULT_PROXY_PORT ?? 8081)
// Address the SaaS container uses to reach this proxy. OpenSandbox returns
// 127.0.0.1:8080 in endpoint responses; rewriting to this value keeps both the
// control-plane and the per-sandbox proxy reachable from inside the container.
const advertised = process.env.FAULT_PROXY_ADVERTISE ?? `${host}:${port}`
let targetPath = null
let hits = 0
let aborted = 0

const proxy = http.createServer(async (request, response) => {
  const incoming = new URL(request.url ?? "/", `http://${host}:${port}`)
  if (incoming.pathname === "/__fault/status") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ targetPath, hits, aborted }))
    return
  }
  if (incoming.pathname === "/__fault/enable" && request.method === "POST") {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    targetPath = body.path
    hits = 0
    aborted = 0
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ enabled: true, targetPath }))
    return
  }
  if (incoming.pathname === "/__fault/disable" && request.method === "POST") {
    targetPath = null
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ enabled: false, hits, aborted }))
    return
  }

  const sandboxFileRequest =
    request.method === "GET" &&
    /\/sandboxes\/[^/]+\/(?:proxy|port)\/44772\/files\/(?:info|download)$/.test(incoming.pathname) &&
    incoming.searchParams.getAll("path").includes(targetPath) &&
    targetPath !== null
  if (sandboxFileRequest) {
    hits++
    let closed = false
    response.once("close", () => {
      if (closed) return
      closed = true
      aborted++
    })
    // Intentionally leave the response open. The SaaS AbortSignal should close it.
    return
  }

  const upstreamUrl = new URL(`${upstream.origin}${incoming.pathname}${incoming.search}`)
  const headers = { ...request.headers, host: upstream.host }
  const upstreamRequest = http.request(
    upstreamUrl,
    { method: request.method, headers },
    (upstreamResponse) => {
      const endpointLookup =
        request.method === "GET" && /\/v1\/sandboxes\/[^/]+\/endpoints\/44772$/.test(incoming.pathname)
      if (!endpointLookup) {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
        return
      }
      const chunks = []
      upstreamResponse.on("data", (chunk) => chunks.push(chunk))
      upstreamResponse.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          if (typeof body.endpoint === "string") {
            const routeIndex = body.endpoint.indexOf("/sandboxes/")
            const route = routeIndex < 0 ? "" : body.endpoint.slice(routeIndex)
            body.endpoint = `${advertised}${route}`
          }
          const encoded = Buffer.from(JSON.stringify(body))
          const responseHeaders = { ...upstreamResponse.headers, "content-length": String(encoded.length) }
          delete responseHeaders["content-encoding"]
          delete responseHeaders["transfer-encoding"]
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
          response.end(encoded)
        } catch (error) {
          response.writeHead(502, { "content-type": "text/plain" })
          response.end(`Could not rewrite Sandbox endpoint response: ${String(error)}`)
        }
      })
    },
  )
  upstreamRequest.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" })
    response.end(`OpenSandbox proxy error: ${error.message}`)
  })
  request.pipe(upstreamRequest)
})

proxy.listen(port, host, () => console.log(`OpenSandbox timeout fault proxy listening on ${host}:${port}`))
