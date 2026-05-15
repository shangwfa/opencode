import { spawn } from "child_process"

const cp = spawn("typescript-language-server", ["--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  cwd: "/tmp/warmup",
})

let buf = ""

function send(msg) {
  const data = JSON.stringify(msg)
  cp.stdin.write(`Content-Length: ${Buffer.byteLength(data)}\r\n\r\n${data}`)
}

function onMessage(msg) {
  if (msg.id === 1) {
    send({ jsonrpc: "2.0", id: 2, method: "initialized", params: {} })
    send({ jsonrpc: "2.0", id: 3, method: "shutdown" })
  } else if (msg.id === 3) {
    send({ jsonrpc: "2.0", method: "exit" })
    setTimeout(() => {
      cp.kill()
      process.exit(0)
    }, 2000)
  }
}

cp.stdout.on("data", (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf("\r\n\r\n")) !== -1) {
    const headerStr = buf.substring(0, idx)
    const m = headerStr.match(/Content-Length: (\d+)/)
    if (!m) break
    const len = parseInt(m[1])
    const start = idx + 4
    if (buf.length < start + len) break
    const body = buf.substring(start, start + len)
    buf = buf.substring(start + len)
    onMessage(JSON.parse(body))
  }
})

cp.stderr.on("data", () => {})
cp.on("exit", () => process.exit(0))

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    rootUri: "file:///tmp/warmup",
    processId: process.pid,
    capabilities: {},
    workspaceFolders: [{ name: "warmup", uri: "file:///tmp/warmup" }],
  },
})

setTimeout(() => {
  cp.kill()
  process.exit(0)
}, 90000)
