import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { Sandbox } from "e2b"

// Explicit opt-in only: creates billable resources, always kills the test VM.
if (process.env.OPENCODE_ALIYUN_SPIKE !== "1") throw new Error("Set OPENCODE_ALIYUN_SPIKE=1 to allow billable sandbox creation")
const settings = Object.fromEntries((await readFile(process.env.OPENCODE_ALIYUN_ENV_FILE ?? "", "utf8")).trim().split("\n").map((line) => {
  const index = line.indexOf("=")
  return [line.slice(0, index), line.slice(index + 1)]
}))
const connection = { apiKey: settings.OPENCODE_ALIYUN_API_KEY, apiUrl: settings.OPENCODE_ALIYUN_API_URL,
  domain: settings.OPENCODE_ALIYUN_DOMAIN, requestTimeoutMs: 120_000 }
const evidence: Record<string, unknown> = { region: "cn-hangzhou" }
let sandbox: Sandbox | undefined
try {
  sandbox = await Sandbox.create("code-interpreter-v1", { ...connection, secure: true,
    network: { allowPublicTraffic: false }, timeoutMs: 300_000, metadata: { purpose: "opencode-aliyun-spike" } })
  evidence.sandboxID = sandbox.sandboxId
  const info = await sandbox.getInfo()
  evidence.resources = { cpu: info.cpuCount, memoryMB: info.memoryMB }
  evidence.trafficTokenReturned = !!sandbox.trafficAccessToken
  assert.ok(sandbox.trafficAccessToken)
  const command = await sandbox.commands.run("printf aliyun-spike-ok; command -v node; command -v rg; command -v flock", { timeoutMs: 10_000 })
  evidence.commandOutput = command.stdout
  await sandbox.files.write("/tmp/opencode-spike.txt", "aliyun-file-ok")
  assert.equal(await sandbox.files.read("/tmp/opencode-spike.txt"), "aliyun-file-ok")
  evidence.files = true
  const service = await sandbox.commands.run("python3 -m http.server 18080 --directory /tmp", { background: true, timeoutMs: 0 })
  const url = `https://${sandbox.getHost(18080)}/opencode-spike.txt`
  for (let index = 0; index < 20; index++) {
    const response = await fetch(url, { headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken }, signal: AbortSignal.timeout(5000) })
    if (response.ok) { assert.equal(await response.text(), "aliyun-file-ok"); evidence.authenticatedPort = response.status; break }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  evidence.anonymousPort = (await fetch(url, { signal: AbortSignal.timeout(5000) })).status
  assert.equal(evidence.authenticatedPort, 200)
  assert.ok(evidence.anonymousPort !== 200)
  const reconnected = await Sandbox.connect(sandbox.sandboxId, connection)
  evidence.trafficTokenChangedOnConnect = reconnected.trafficAccessToken !== sandbox.trafficAccessToken
  evidence.originalTokenAfterConnect = (await fetch(url, { headers: { "e2b-traffic-access-token": sandbox.trafficAccessToken }, signal: AbortSignal.timeout(5000) })).status
  await service.kill()
  try {
    evidence.pause = await sandbox.pause()
    const resumed = await Sandbox.connect(sandbox.sandboxId, connection)
    assert.equal(await resumed.files.read("/tmp/opencode-spike.txt"), "aliyun-file-ok")
    evidence.resume = true
    sandbox = resumed
  } catch (error) {
    evidence.pauseError = error instanceof Error ? error.message.replace(/e2b_[a-zA-Z0-9]+/g, "[REDACTED]") : "pause failed"
  }
} catch (error) {
  evidence.error = error instanceof Error ? error.message.replace(/e2b_[a-zA-Z0-9]+/g, "[REDACTED]") : "probe failed"
  process.exitCode = 1
} finally {
  if (sandbox) {
    evidence.killed = await Sandbox.kill(sandbox.sandboxId, connection)
    try { await Sandbox.getInfo(sandbox.sandboxId, connection); evidence.remaining = true } catch { evidence.remaining = false }
  }
  const directory = process.env.OPENCODE_ALIYUN_EVIDENCE ?? "../../artifacts/aliyun-sandbox"
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/spike.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
}
