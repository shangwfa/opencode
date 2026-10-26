/**
 * Vercel routes expose sandbox ports on public HTTPS URLs. The public URL is
 * transport, never authentication (design decision), so every exposed port is
 * fronted by this in-sandbox gate: it requires the per-sandbox token as a path
 * prefix and forwards to the real local service. Consumers receive the token
 * inside the endpoint string (`https://host/t/<token>`), so no call site
 * learns a new secret channel.
 */
export const TOKEN_PREFIX = "/t/"

/** Gate listens on `port + GATE_OFFSET`; the real service keeps its own port. */
export const GATE_OFFSET = 10_000
/** Vercel caps a sandbox at 15 exposed ports: 13 MCP bridges + runner + Tool Host. */
export const MCP_PORTS = Array.from({ length: 13 }, (_, index) => 9100 + index)
/** Ports every sandbox needs before any consumer asks: Code Mode runner and Session Tool Host. */
export const INITIAL_GATE_PORTS = [9911 + GATE_OFFSET, 9912 + GATE_OFFSET]
/**
 * Historical fixed set. Ports are now registered on demand (see `withGatePort`)
 * so preview ports can share the 15-port budget with MCP bridges.
 */
export const EXPOSED_GATE_PORTS = [...MCP_PORTS.map((port) => port + GATE_OFFSET), ...INITIAL_GATE_PORTS]
/** Vercel's per-sandbox exposed-port ceiling. */
export const MAX_PORTS = 15

/**
 * Adds one gate port to the sandbox's current route list. `Sandbox.update`
 * treats `ports` as the complete desired set and Vercel caps that set at 15,
 * so callers must merge instead of replacing and must fail loudly at the cap.
 */
export function withGatePort(ports: ReadonlyArray<number>, gatePort: number): Array<number> {
  const next = Array.from(new Set([...ports, gatePort])).sort((a, b) => a - b)
  if (next.length > MAX_PORTS)
    throw new Error(`Vercel exposes at most ${MAX_PORTS} ports; cannot add ${gatePort}`)
  return next
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * Self-contained Node script (stdlib only). `--token` is compared against the
 * `/t/<token>/` prefix, which is stripped before forwarding so the upstream
 * service never sees the token. Proxies HTTP verbatim and pipes WebSocket
 * upgrades raw; anything without a matching prefix gets 404 and no upstream hit.
 */
export const script = String.raw`#!/usr/bin/env node
import http from "node:http"
import net from "node:net"
const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1])
const listen = Number(args.get("port"))
const target = Number(args.get("target"))
const token = args.get("token")
if (!Number.isInteger(listen) || !Number.isInteger(target) || !token) {
  process.stderr.write("usage: port-gate --port <listen> --target <target> --token <token>\n")
  process.exit(1)
}
const prefix = "/t/" + token
const server = http.createServer()
const strip = (url) => (url === prefix ? "/" : url.slice(prefix.length))
server.on("request", (req, res) => {
  const url = req.url || "/"
  if (!url.startsWith(prefix + "/") && url !== prefix) {
    res.writeHead(404).end("not found")
    return
  }
  const upstream = http.request({
    host: "127.0.0.1",
    port: target,
    method: req.method,
    path: strip(url),
    headers: { ...req.headers, host: "127.0.0.1:" + target },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502)
    res.end("gate upstream error")
  })
  req.pipe(upstream)
})
server.on("upgrade", (req, socket, head) => {
  const url = req.url || "/"
  if (!url.startsWith(prefix + "/") && url !== prefix) {
    socket.destroy()
    return
  }
  const upstream = net.connect(target, "127.0.0.1", () => {
    const lines = [req.method + " " + strip(url) + " HTTP/" + req.httpVersion]
    for (const [name, value] of Object.entries(req.headers)) {
      if (name === "host") lines.push("host: 127.0.0.1:" + target)
      else if (Array.isArray(value)) for (const item of value) lines.push(name + ": " + item)
      else lines.push(name + ": " + value)
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n")
    if (head && head.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
})
server.listen(listen, "0.0.0.0", () => process.stdout.write("port-gate:" + listen + "\n"))
`

export const path = "/workspace/.opencode/.port-gate/port-gate.mjs"

/** Idempotent launcher; mirrors the Code Mode Runner's pid-file + readiness pattern. */
export const startCommand = (input: { listen: number; target: number; token: string }): string => {
  const pid = `/tmp/opencode-port-gate-${input.listen}.pid`
  const log = `/tmp/opencode-port-gate-${input.listen}.log`
  const ready = quote(
    `const n=require("node:net");let i=0;(function t(){const s=n.connect(${input.listen},"127.0.0.1",()=>{s.end();process.exit(0)});s.on("error",()=>{s.destroy();if(++i>50)process.exit(1);setTimeout(t,200)})})()`,
  )
  return `if [ -s ${quote(pid)} ] && kill -0 "$(cat ${quote(pid)})" 2>/dev/null; then echo gate-already-running; else rm -f ${quote(pid)}; nohup node ${quote(path)} --port ${input.listen} --target ${input.target} --token ${quote(input.token)} > ${quote(log)} 2>&1 </dev/null & echo "$!" > ${quote(pid)}; echo "gate-started:$!"; fi; node -e ${ready}`
}
