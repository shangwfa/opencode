import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { parseArgs } from "node:util"
import { APIError, Sandbox } from "@vercel/sandbox"
import { inspect, resume } from "../src/sandbox/vercel/client.js"
import { cancel, observe, start } from "../src/sandbox/vercel/command.js"
import { singleSubmissionFetch } from "../src/sandbox/vercel/transport.js"

type Result = {
  scope: "sdk-smoke-only"
  status: "blocked" | "running" | "passed" | "failed"
  sdk: "3.8.0"
  sandbox?: string
  reason?: string
  steps: { name: string; passed: boolean; elapsedMs: number }[]
  cleanup: "not-created" | "pending" | "requested" | "failed"
}

// This script never drives a SaaS Session; its result is not an API/SSE/PG E2E acceptance.
export async function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const { values } = parseArgs({
    args,
    options: { live: { type: "boolean" }, project: { type: "string" }, output: { type: "string" } },
    strict: true,
  })
  const result: Result = {
    scope: "sdk-smoke-only", status: "blocked", sdk: "3.8.0", steps: [], cleanup: "not-created",
  }
  const finish = async () => {
    if (values.output) {
      const output = resolve(values.output)
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
    }
    console.log(JSON.stringify(result))
    return result
  }
  if (!values.live) {
    result.reason = "Live requests require --live (creates billable resources), --project and --output"
    return finish()
  }
  if (!values.output || !values.project || values.project !== env.VERCEL_PROJECT_ID) {
    result.reason = "Provide --output and a --project matching VERCEL_PROJECT_ID"
    return finish()
  }
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = env
  if (!token?.trim() || !teamId?.trim() || !projectId?.trim()) {
    result.reason = "Missing VERCEL_TOKEN, VERCEL_TEAM_ID or VERCEL_PROJECT_ID"
    return finish()
  }
  const marker = randomUUID()
  const name = `oc-p0-${marker.replaceAll("-", "").slice(0, 16)}`
  const connection = { token, teamId, projectId, name, fetch: singleSubmissionFetch() }
  let sandbox: Sandbox | undefined
  let attempted = false
  result.sandbox = name
  result.status = "running"
  const step = async <T>(name: string, operation: () => Promise<T>) => {
    const started = Date.now()
    try {
      const value = await operation()
      result.steps.push({ name, passed: true, elapsedMs: Date.now() - started })
      console.log(JSON.stringify({ step: name, passed: true, elapsedMs: Date.now() - started }))
      return value
    } catch (error) {
      result.steps.push({ name, passed: false, elapsedMs: Date.now() - started })
      throw error
    }
  }
  try {
    attempted = true
    result.cleanup = "pending"
    sandbox = await step("create", () => Sandbox.create({
      ...connection,
      image: "vercel/sandbox/node:24",
      resources: { vcpus: 2 },
      ports: [],
      timeout: 120_000,
      persistent: true,
      snapshotExpiration: 86_400_000,
      keepLastSnapshots: { count: 1, deleteEvicted: true },
      networkPolicy: "deny-all",
      tags: { "opencode-p0": marker },
      signal: AbortSignal.timeout(90_000),
    }))
    const session = sandbox.currentSession()
    const generation = session.sessionId
    const active = { sandbox, session, generation }
    await step("workspace", async () => {
      const cmd = await session.runCommand({
        cmd: "mkdir", args: ["-p", "-m", "0777", "/workspace"], sudo: true, timeoutMs: 10_000,
        signal: AbortSignal.timeout(15_000),
      })
      if (cmd.exitCode !== 0) throw new Error("workspace_creation_failed")
      await session.writeFiles([{ path: "/workspace/p0-marker.txt", content: Buffer.from(marker) }], {
        signal: AbortSignal.timeout(15_000),
      })
    })
    await step("foreground_exit", async () => {
      const cmd = await session.runCommand({ cmd: "sh", args: ["-c", "exit 7"], timeoutMs: 10_000 })
      if (cmd.exitCode !== 7) throw new Error("foreground_exit_mismatch")
    })
    await step("command_kill", async () => {
      const task = await start(active, {
        cmd: "node", args: ["-e", "setTimeout(()=>{},30000)"], timeoutMs: 10_000,
        signal: AbortSignal.timeout(15_000),
      })
      const result = await cancel(active, task)
      if (result.exitCode === 0) throw new Error("kill_not_observed")
    })
    await step("bounded_logs", async () => {
      const signal = AbortSignal.timeout(15_000)
      const task = await start(active, {
        cmd: "node", args: ["-e", "process.stdout.write('x'.repeat(65536));process.stderr.write('done')"],
        timeoutMs: 10_000, signal,
      })
      let bytes = 0
      const result = await observe(active, task, {
        maxBytes: 64, signal,
        onOutput: async (chunk) => { bytes += Buffer.byteLength(chunk.data) },
      })
      if (result.exitCode !== 0 || !result.truncated || Buffer.byteLength(result.output) > 64 || bytes !== 65540) {
        throw new Error("bounded_logs_mismatch")
      }
    })
    const box = sandbox
    await step("stop_preserves_workspace", async () => {
      const stopped = await box.stop({ signal: AbortSignal.timeout(90_000) })
      if (stopped.snapshot?.status !== "created") throw new Error("snapshot_not_created")
      const state = await inspect({ ...connection, signal: AbortSignal.timeout(15_000) })
      if (state.status !== "stopped") throw new Error("inspect_resumed_workspace")
    })
    const restored = await step("strict_resume", () => resume({ ...connection, signal: AbortSignal.timeout(90_000) }))
    sandbox = restored.sandbox
    await step("restore_files_and_generation", async () => {
      if (restored.generation === generation) throw new Error("generation_did_not_change")
      const data = await restored.session.readFileToBuffer({ path: "/workspace/p0-marker.txt" }, {
        signal: AbortSignal.timeout(15_000),
      })
      if (data?.toString("utf8") !== marker) throw new Error("workspace_data_lost")
    })
    result.status = "passed"
  } catch (error) {
    result.status = "failed"
    // Do not print SDK messages, request URLs, credentials or arbitrary response bodies.
    result.reason = error instanceof APIError ? `Vercel API HTTP ${error.response.status}` : "SDK smoke step failed"
  } finally {
    if (attempted) {
      try {
        // A timed-out create may have succeeded remotely; retrieve the unique name, never create it again.
        sandbox ??= await Sandbox.get({ ...connection, resume: false, signal: AbortSignal.timeout(15_000) })
        if (sandbox.tags?.["opencode-p0"] !== marker) throw new Error("Cleanup ownership mismatch")
        await sandbox.delete({ deleteOrphanSnapshots: true, signal: AbortSignal.timeout(30_000) })
        // Orphan snapshot cleanup is asynchronous: this is a request, not proof of completed storage GC.
        result.cleanup = "requested"
      } catch (error) {
        if (error instanceof APIError && error.response.status === 404) result.cleanup = "not-created"
        else {
          result.cleanup = "failed"
          result.status = "failed"
        }
      }
    }
  }
  return finish()
}

if (import.meta.main) {
  try {
    const result = await run(process.argv.slice(2))
    process.exitCode = result.status === "passed" ? 0 : result.status === "blocked" ? 2 : 1
  } catch {
    console.error("P0 probe failed before result could be saved; verify CLI arguments and output permissions")
    process.exitCode = 1
  }
}
