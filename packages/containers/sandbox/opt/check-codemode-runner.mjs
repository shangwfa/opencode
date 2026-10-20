import { spawn } from "node:child_process"
import { connect } from "node:net"

const runnerPath = process.env.OPENCODE_CODEMODE_RUNNER_PATH ?? "/opt/opencode-codemode-runner.mjs"
const port = Number(process.env.OPENCODE_CODEMODE_RUNNER_PORT ?? 9911)
const child = spawn(process.execPath, [runnerPath], { stdio: ["ignore", "ignore", "pipe"] })
let stderr = ""
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096) })
try {
  await new Promise((resolve, reject) => {
    let complete = false
    let retry
    const finish = (error) => {
      if (complete) return
      complete = true
      clearTimeout(retry)
      clearTimeout(deadline)
      if (error) reject(error)
      else resolve()
    }
    const deadline = setTimeout(() => finish(new Error(`Runner readiness timed out: ${stderr}`)), 8000)
    child.once("error", finish)
    child.once("exit", (code) => finish(new Error(`Runner exited (${code}): ${stderr}`)))
    const probe = () => {
      const socket = connect({ host: "127.0.0.1", port })
      socket.setTimeout(250)
      socket.once("connect", () => { socket.destroy(); finish() })
      socket.once("error", () => { socket.destroy(); if (!complete) retry = setTimeout(probe, 25) })
      socket.once("timeout", () => { socket.destroy(); if (!complete) retry = setTimeout(probe, 25) })
    }
    probe()
  })
  console.log("Code Mode Runner image smoke check passed")
} finally {
  child.kill("SIGTERM")
}
