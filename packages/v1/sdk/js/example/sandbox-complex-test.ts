/**
 * 复杂 sandbox 测试：让 LLM 在 sandbox 容器中完成一个完整的小项目
 *
 * 任务：创建一个 Python HTTP 服务，实现 CRUD API，运行并验证
 */

import { Server } from "../../../opencode/src/server/server.ts"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

const SERVER_PORT = 14097
const TIMEOUT = 300_000

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
          log("TEXT", text.slice(0, 300))
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

const PERMISSIONS = [
  { permission: "bash", action: "allow", pattern: "*" },
  { permission: "write", action: "allow", pattern: "*" },
  { permission: "read", action: "allow", pattern: "*" },
  { permission: "edit", action: "allow", pattern: "*" },
  { permission: "glob", action: "allow", pattern: "*" },
  { permission: "grep", action: "allow", pattern: "*" },
  { permission: "list", action: "allow", pattern: "*" },
  { permission: "question", action: "deny", pattern: "*" },
]

const COMPLEX_PROMPT = [
  "Complete this multi-step project task. Do each step carefully and report results.",
  "",
  "## Step 1: Environment Check",
  "Use bash to run: uname -a && whoami && cat /etc/os-release | head -5 && which python3 && python3 --version",
  "",
  "## Step 2: Create Project Structure",
  "Use bash to run:",
  "  mkdir -p /tmp/todo-app/{src,tests,data}",
  "",
  "## Step 3: Write the Main Application",
  "Use bash to write a Python file /tmp/todo-app/src/server.py that implements a simple in-memory TODO REST API using only Python standard library (http.server). It should:",
  '  - Listen on port 9999',
  "  - GET /todos - return all todos as JSON",
  "  - POST /todos - create a new todo (body: {\"title\": \"...\", \"done\": false})",
  "  - DELETE /todos/<id> - delete a todo by index",
  "  - Start the server in the background so it keeps running",
  "  - Use bash heredoc (cat <<'EOF' > file) to write the file",
  "",
  "## Step 4: Write Tests",
  "Use bash to write /tmp/todo-app/tests/test.sh that:",
  "  1. Creates 3 todos via curl POST",
  "  2. Lists all todos via curl GET",
  "  3. Deletes todo #2 via curl DELETE",
  "  4. Lists remaining todos to verify deletion",
  "  5. Prints all results clearly",
  "",
  "## Step 5: Start the Server",
  "Use bash to start the server in the background:",
  "  cd /tmp/todo-app/src && python3 server.py &",
  "  sleep 2",
  '  curl -s http://localhost:9999/todos to verify it is running',
  "",
  "## Step 6: Run Tests",
  "Use bash to run: bash /tmp/todo-app/tests/test.sh",
  "",
  "## Step 7: Verify File Structure",
  "Use bash to run: find /tmp/todo-app -type f | sort",
  "",
  "## Step 8: Use glob to find all Python files",
  "Use the glob tool to search for **/*.py in /tmp/todo-app/",
  "",
  "## Step 9: Use grep to find route definitions",
  'Use the grep tool to search for "GET|POST|DELETE" in /tmp/todo-app/',
  "",
  "## Step 10: Use read to inspect the server source",
  "Use the read tool to read /tmp/todo-app/src/server.py",
  "",
  "## Step 11: Clean up",
  "Use bash to kill the background server process and remove /tmp/todo-app",
  "",
  "Report a final summary table of all steps and their results.",
].join("\n")

async function main() {
  const testDir = process.cwd()
  log("INIT", `test directory: ${testDir}`)

  const sandbox = await startSandboxServer()

  try {
    process.env.OPENCODE_SANDBOX_ENABLED = "true"
    log("SERVER", "starting opencode server with sandbox enabled...")
    const listener = await Server.listen({ hostname: "127.0.0.1", port: SERVER_PORT })
    const url = `http://${listener.hostname}:${listener.port}`
    log("SERVER", `listening on ${url}`)

    const client = createOpencodeClient({ baseUrl: url, directory: testDir })

    try {
      const health = await client.global.health()
      log("HEALTH", health.data)

      log("TEST", "=== Complex Sandbox Task: Build & Test a TODO API ===")
      const ses = await client.session.create({
        title: "sandbox-complex-task",
        permission: PERMISSIONS,
      })

      const p = client.session.prompt({
        sessionID: ses.data!.id,
        parts: [{ type: "text", text: COMPLEX_PROMPT }],
      })

      const r = await waitForSessionIdle(client, ses.data!.id, 600_000)
      await p

      log("RESULT", `tools invoked: ${r.toolCalls.join(", ") || "none"}`)
      log("RESULT", `tool call count: ${r.toolCalls.length}`)

      const toolCounts = new Map<string, number>()
      for (const t of r.toolCalls) {
        toolCounts.set(t, (toolCounts.get(t) || 0) + 1)
      }
      log("RESULT", "tool breakdown:")
      for (const [tool, count] of toolCounts) {
        log("RESULT", `  ${tool}: ${count}x`)
      }

      if (r.errors.length > 0) {
        log("RESULT", `${r.errors.length} error(s):`)
        r.errors.forEach((e) => log("ERROR", e))
      }

      const expectedTools = ["bash", "read", "glob", "grep"]
      for (const t of expectedTools) {
        log("ASSERT", toolCounts.has(t) ? `PASS: ${t} used ${toolCounts.get(t)}x` : `FAIL: ${t} NOT used`)
      }

      log("ASSERT", r.toolCalls.length >= 8 ? `PASS: ${r.toolCalls.length} total tool calls (complex task)` : `WARN: only ${r.toolCalls.length} tool calls`)

      const hasSummary = r.texts.some((t) => t.includes("summary") || t.includes("Step"))
      log("ASSERT", hasSummary ? "PASS: final summary reported" : "WARN: no summary found in output")

      log("SUMMARY", r.errors.length === 0 ? "All tests passed!" : `${r.errors.length} error(s) found`)

      const msgs = await client.session.messages({ sessionID: ses.data!.id })
      log("MESSAGES", `${msgs.data?.length ?? 0} messages total`)

      await client.session.delete({ sessionID: ses.data!.id }).catch(() => {})
      log("CLEANUP", "session deleted")
    } finally {
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
