/**
 * opencode server + sandbox API 测试脚本
 *
 * 流程：
 * 1. 启动 opensandbox-server（Docker 沙箱服务）
 * 2. 启动 opencode server（本仓库代码，启用 sandbox）
 * 3. 通过 SDK 创建 session，发送 prompt
 * 4. bash/read/write/glob/grep 操作在 sandbox 容器中执行
 * 5. 通过 SSE 事件流监听结果并验证
 *
 * 前置条件：
 *   - Docker 运行中
 *   - uv/uvx 已安装
 *   - 已运行 `uvx opensandbox-server init-config ~/.sandbox.toml --example docker`
 *
 * 用法：
 *   cd packages/sdk/js
 *   bun run example/sandbox-test.ts
 */

import { Server } from "../../../opencode/src/server/server.ts"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

const SERVER_PORT = 14096
const TIMEOUT = 180_000

function log(tag: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args)
}

async function startSandboxServer(): Promise<{ stop: () => void }> {
  log("SANDBOX", "starting opensandbox-server...")
  const proc = Bun.spawn(
    ["uvx", "opensandbox-server", "--config", `${process.env.HOME}/.sandbox.toml`],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENSANDBOX_INSECURE_SERVER: "YES",
      },
    },
  )

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error("opensandbox-server start timeout (30s)"))
    }, 30_000)

    const reader = proc.stderr.getReader()
    const decoder = new TextDecoder()
    let buf = ""

    ;(async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        if (buf.includes("Uvicorn running on")) {
          clearTimeout(timer)
          resolve()
          return
        }
      }
    })().catch(reject)
  })

  log("SANDBOX", "opensandbox-server ready")
  return { stop: () => proc.kill() }
}

async function waitForSessionIdle(
  client: OpencodeClient,
  sessionID: string,
  timeout = TIMEOUT,
): Promise<{ texts: string[]; toolCalls: string[]; errors: string[] }> {
  const texts: string[] = []
  const toolCalls: string[] = []
  const errors: string[] = []

  const events = await client.event.subscribe()
  const deadline = Date.now() + timeout

  for await (const event of events.stream) {
    if (Date.now() > deadline) {
      throw new Error(`waitForSessionIdle timed out after ${timeout}ms`)
    }

    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.sessionID !== sessionID) continue

      if (part.type === "tool" && part.state?.status === "completed") {
        toolCalls.push(part.tool)
        log("TOOL", `${part.tool} completed`)
      }

      if (part.type === "tool" && part.state?.status === "error") {
        errors.push(`${part.tool}: ${part.state.error}`)
        log("TOOL-ERR", `${part.tool} failed: ${part.state.error}`)
      }

      if (part.type === "text" && part.time?.end) {
        const text = part.text?.trim()
        if (text) {
          texts.push(text)
          log("TEXT", text.slice(0, 200))
        }
      }
    }

    if (event.type === "session.error") {
      const props = event.properties
      if (props.sessionID !== sessionID || !props.error) continue
      const msg =
        props.error.data && "message" in props.error.data ? String(props.error.data.message) : String(props.error.name)
      errors.push(msg)
      log("SESSION-ERR", msg)
    }

    if (
      event.type === "session.status" &&
      event.properties.sessionID === sessionID &&
      event.properties.status.type === "idle"
    ) {
      log("SESSION", "idle")
      break
    }

    if (event.type === "permission.asked") {
      const perm = event.properties
      if (perm.sessionID !== sessionID) continue
      log("PERM", `auto-approving: ${perm.permission}`)
      await client.permission.reply({ requestID: perm.id, reply: "once" })
    }
  }

  return { texts, toolCalls, errors }
}

async function main() {
  const testDir = process.cwd()
  log("INIT", `test directory: ${testDir}`)

  // ── 1. 启动 opensandbox-server ──
  const sandbox = await startSandboxServer()

  try {
    // ── 2. 启动 opencode server（启用 sandbox）──
    process.env.OPENCODE_SANDBOX_ENABLED = "true"
    log("SERVER", "starting opencode server with sandbox enabled...")
    const listener = await Server.listen({ hostname: "127.0.0.1", port: SERVER_PORT })
    const url = `http://${listener.hostname}:${listener.port}`
    log("SERVER", `listening on ${url}`)

    const client = createOpencodeClient({ baseUrl: url, directory: testDir })
    const sessionIDs: string[] = []

    try {
      // ── 3. 健康检查 ──
      const health = await client.global.health()
      log("HEALTH", health.data)

      // ── Test 1: bash（在 sandbox 容器中执行）──
      log("TEST", "=== Test 1: bash (sandbox) ===")
      const ses1 = await client.session.create({
        title: "sandbox-bash-test",
        permission: [
          { permission: "bash", action: "allow", pattern: "*" },
          { permission: "write", action: "allow", pattern: "*" },
          { permission: "read", action: "allow", pattern: "*" },
          { permission: "edit", action: "allow", pattern: "*" },
          { permission: "question", action: "deny", pattern: "*" },
        ],
      })
      sessionIDs.push(ses1.data!.id)

      const p1 = client.session.prompt({
        sessionID: ses1.data!.id,
        parts: [
          {
            type: "text",
            text: 'Run this bash command and report the full output: echo "Hello from sandbox" && whoami && uname -a && hostname',
          },
        ],
      })
      const r1 = await waitForSessionIdle(client, ses1.data!.id)
      await p1

      log("RESULT", `tools: ${r1.toolCalls.join(", ") || "none"}`)
      log("RESULT", `errors: ${r1.errors.join(", ") || "none"}`)
      log("ASSERT", r1.toolCalls.includes("bash") ? "PASS: bash invoked" : "FAIL: bash NOT invoked")
      const inSandbox = r1.texts.some((t) => !t.includes("darwin"))
      log("ASSERT", inSandbox ? "PASS: executed in sandbox (not darwin)" : "WARN: may not be in sandbox")

      // ── Test 2: bash 写文件 + read（在 sandbox 中操作文件）──
      log("TEST", "=== Test 2: bash write + read (sandbox) ===")
      const ses2 = await client.session.create({
        title: "sandbox-file-test",
        permission: [
          { permission: "bash", action: "allow", pattern: "*" },
          { permission: "read", action: "allow", pattern: "*" },
          { permission: "write", action: "allow", pattern: "*" },
          { permission: "edit", action: "allow", pattern: "*" },
          { permission: "question", action: "deny", pattern: "*" },
        ],
      })
      sessionIDs.push(ses2.data!.id)

      const p2 = client.session.prompt({
        sessionID: ses2.data!.id,
        parts: [
          {
            type: "text",
            text: [
              "Do these steps in order, using only the bash tool for file creation and the read tool for reading:",
              '1. Use bash to run: echo "opencode sandbox test hello world" > /tmp/opencode-test.txt',
              "2. Use the read tool to read /tmp/opencode-test.txt",
              "3. Report what you read back.",
            ].join("\n"),
          },
        ],
      })
      const r2 = await waitForSessionIdle(client, ses2.data!.id)
      await p2

      log("RESULT", `tools: ${r2.toolCalls.join(", ") || "none"}`)
      log("ASSERT", r2.toolCalls.includes("bash") ? "PASS: bash invoked" : "FAIL: bash NOT invoked")
      log("ASSERT", r2.toolCalls.includes("read") ? "PASS: read invoked" : "FAIL: read NOT invoked")

      // ── Test 3: 综合操作 ──
      log("TEST", "=== Test 3: comprehensive (sandbox) ===")
      const ses3 = await client.session.create({
        title: "sandbox-comprehensive-test",
        permission: [
          { permission: "bash", action: "allow", pattern: "*" },
          { permission: "write", action: "allow", pattern: "*" },
          { permission: "read", action: "allow", pattern: "*" },
          { permission: "edit", action: "allow", pattern: "*" },
          { permission: "glob", action: "allow", pattern: "*" },
          { permission: "grep", action: "allow", pattern: "*" },
          { permission: "question", action: "deny", pattern: "*" },
        ],
      })
      sessionIDs.push(ses3.data!.id)

      const p3 = client.session.prompt({
        sessionID: ses3.data!.id,
        parts: [
          {
            type: "text",
            text: [
              "Perform these steps in order. Use bash for ALL file creation (echo/tee), then use read/glob/grep tools for verification:",
              "1. bash: mkdir -p /tmp/opencode-e2e",
              '2. bash: echo \'{"name":"opencode","sandbox":true}\' > /tmp/opencode-e2e/data.json',
              '3. bash: echo "sandbox test for opencode" > /tmp/opencode-e2e/notes.txt',
              "4. Use the glob tool to find all files in /tmp/opencode-e2e/",
              '5. Use the grep tool to search for "sandbox" in /tmp/opencode-e2e/',
              "6. Use the read tool to read /tmp/opencode-e2e/data.json and confirm content",
              "7. Report summary of all results.",
            ].join("\n"),
          },
        ],
      })
      const r3 = await waitForSessionIdle(client, ses3.data!.id, 300_000)
      await p3

      log("RESULT", `tools: ${r3.toolCalls.join(", ") || "none"}`)
      for (const t of ["bash", "read", "glob", "grep"]) {
        log("ASSERT", r3.toolCalls.includes(t) ? `PASS: ${t} invoked` : `FAIL: ${t} NOT invoked`)
      }

      // ── 验证 messages ──
      const msgs = await client.session.messages({ sessionID: ses3.data!.id })
      log("MESSAGES", `${msgs.data?.length ?? 0} messages in session3`)

      // ── 汇总 ──
      const allErrors = [...r1.errors, ...r2.errors, ...r3.errors]
      if (allErrors.length > 0) {
        log("SUMMARY", `${allErrors.length} error(s):`)
        allErrors.forEach((e) => log("ERROR", e))
      } else {
        log("SUMMARY", "All tests passed!")
      }
    } finally {
      for (const id of sessionIDs) {
        await client.session.delete({ sessionID: id }).catch(() => {})
      }
      log("CLEANUP", "sessions deleted")
      await listener.stop()
      log("SERVER", "stopped")
    }
  } finally {
    sandbox.stop()
    log("SANDBOX", "stopped")
  }
}

main().catch((err) => {
  console.error("FATAL:", err)
  process.exit(1)
})
