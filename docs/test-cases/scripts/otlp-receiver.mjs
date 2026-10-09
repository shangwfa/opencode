#!/usr/bin/env bun
// Minimal OTLP/HTTP receiver for T62 e2e verification.
//
// OTLP over HTTP defaults to protobuf encoding, but metric names, attribute
// keys/values, and trace ids are length-prefixed UTF-8 inside the payload, so
// substring probing is reliable without a protobuf decoder. Each request body
// is kept in memory and exposed over GET /__seen for assertions.
//
// Usage: bun otlp-receiver.mjs [port]
//   POST /v1/metrics|/v1/traces|/v1/logs  — OTLP ingestion
//   GET /__seen — JSON: { metrics: {count, bytes}, traces: {...}, logs: {...}, bodies: [...] }
//   GET /__probe?needle=... — was this string seen in any received body?

import { createServer } from "node:http"

const port = Number(process.argv[2] ?? 4318)
const bodies = []
const signals = { metrics: 0, traces: 0, logs: 0 }

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__seen") {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ signals, requests: bodies.length, bytes: bodies.reduce((a, b) => a + b.byteLength, 0) }))
    return
  }
  if (req.method === "GET" && req.url?.startsWith("/__probe")) {
    const needle = decodeURIComponent(new URL(req.url, "http://x").searchParams.get("needle") ?? "")
    const hits = bodies.filter((b) => b.includes(needle)).length
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ needle, hits }))
    return
  }
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    const signal = req.url?.includes("metrics") ? "metrics" : req.url?.includes("traces") ? "traces" : "logs"
    signals[signal] = (signals[signal] ?? 0) + 1
    bodies.push(body)
    if (bodies.length > 500) bodies.shift()
    res.writeHead(200)
    res.end()
  })
})

server.listen(port, "0.0.0.0", () => {
  console.log(`otlp receiver ready on :${port} (signals=${Object.keys(signals).join(",")})`)
})
