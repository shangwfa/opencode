import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const config = new ConnectionConfig({
  domain: process.env.OPENCODE_SANDBOX_DOMAIN!,
  protocol: "http",
  apiKey: process.env.OPENCODE_SANDBOX_API_KEY,
  useServerProxy: true,
  requestTimeoutSeconds: 60,
})
const image = process.env.OPENCODE_SANDBOX_IMAGE!

const CONCURRENCY = 20

type TaskResult = {
  id: number
  sandboxId: string
  fib20: number
  fileRoundTrip: boolean
  commandSession: boolean
  durationMs: number
  error?: string
}

async function runTask(id: number): Promise<TaskResult> {
  const start = Date.now()
  const marker = `task-${id}-${start}`
  try {
    const sb = await Sandbox.create({
      connectionConfig: config,
      image,
      timeoutSeconds: 300,
    })

    // 1. Command: fibonacci via python3
    const r1 = await sb.commands.run(
      `python3 -c "
def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
print(fib(20))
"`
    )
    const fib20 = parseInt(r1.logs.stdout.map((l: any) => l.text).join("").trim())

    // 2. File round-trip: write → read → verify
    await sb.files.writeFiles([{ path: "/workspace/marker.txt", data: marker }])
    const readBack = await sb.files.readFile("/workspace/marker.txt")
    const fileRoundTrip = readBack === marker

    // 3. Command session: create → runInSession multiple commands
    const sessionId = await sb.commands.createSession({ workingDirectory: "/workspace" })
    await sb.commands.runInSession(sessionId, "export MARKER=" + marker)
    const r3 = await sb.commands.runInSession(sessionId, "echo $MARKER")
    const sessionCheck = r3.logs.stdout.map((l: any) => l.text).join("").trim() === marker
    await sb.commands.deleteSession(sessionId)

    await sb.kill()
    await sb.close()

    return {
      id,
      sandboxId: sb.id,
      fib20,
      fileRoundTrip,
      commandSession: sessionCheck,
      durationMs: Date.now() - start,
    }
  } catch (err: any) {
    return {
      id,
      sandboxId: "",
      fib20: 0,
      fileRoundTrip: false,
      commandSession: false,
      durationMs: Date.now() - start,
      error: err?.message ?? String(err),
    }
  }
}

async function main() {
  console.log(`=== Concurrent Sandbox Test (N=${CONCURRENCY}) ===\n`)
  const start = Date.now()

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => runTask(i + 1))
  )

  const totalMs = Date.now() - start
  const ok = results.filter((r) => !r.error)
  const fail = results.filter((r) => r.error)

  console.log("── Results ──────────────────────────────────\n")
  for (const r of results) {
    if (r.error) {
      console.log(`  #${String(r.id).padStart(2)} ✗ ${r.error} (${r.durationMs}ms)`)
    } else {
      const checks = [
        r.fib20 === 6765 ? "fib" : "fib✗",
        r.fileRoundTrip ? "file" : "file✗",
        r.commandSession ? "session" : "session✗",
      ].join(" ")
      console.log(`  #${String(r.id).padStart(2)} ✓ ${checks}  ${r.durationMs}ms  ${r.sandboxId.slice(0, 8)}`)
    }
  }

  console.log("\n── Summary ──────────────────────────────────")
  console.log(`  Total:      ${CONCURRENCY}`)
  console.log(`  Success:    ${ok.length}`)
  console.log(`  Failed:     ${fail.length}`)
  console.log(`  Wall time:  ${totalMs}ms`)
  if (ok.length > 0) {
    const avg = Math.round(ok.reduce((s, r) => s + r.durationMs, 0) / ok.length)
    const max = Math.max(...ok.map((r) => r.durationMs))
    const min = Math.min(...ok.map((r) => r.durationMs))
    console.log(`  Avg/task:   ${avg}ms`)
    console.log(`  Min/task:   ${min}ms`)
    console.log(`  Max/task:   ${max}ms`)
  }

  if (fail.length > 0) {
    console.log("\n  Failures:")
    for (const r of fail) {
      console.log(`    #${r.id}: ${r.error}`)
    }
  }

  process.exit(fail.length > 0 ? 1 : 0)
}

main()
