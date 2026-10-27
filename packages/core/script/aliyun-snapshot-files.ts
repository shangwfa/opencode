import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { Sandbox, SandboxNotFoundError } from "e2b"

if (process.env.OPENCODE_ALIYUN_SPIKE !== "1") throw new Error("Explicit billable-resource opt-in required")
const settings = process.env.OPENCODE_ALIYUN_ENV_FILE ? Object.fromEntries((await readFile(process.env.OPENCODE_ALIYUN_ENV_FILE, "utf8")).trim().split("\n").map((line) => {
  const index = line.indexOf("=")
  return [line.slice(0, index), line.slice(index + 1)]
})) : process.env
const connection = { apiKey: settings.OPENCODE_ALIYUN_API_KEY, apiUrl: settings.OPENCODE_ALIYUN_API_URL,
  domain: settings.OPENCODE_ALIYUN_DOMAIN, requestTimeoutMs: 300000 }
// Snapshot static APIs use this SDK environment setting for their regional endpoint.
process.env.E2B_API_URL = connection.apiUrl
const template = process.env.OPENCODE_ALIYUN_TEMPLATE ?? "code-interpreter-v1"
const name = `oc-files-${randomUUID().replaceAll("-", "")}`
const report: Record<string, unknown> = { template, snapshotName: name, status: "running", stages: [] }
const stages: Array<{ stage: string; ms: number }> = []
report.stages = stages
const ownedSnapshots = new Set<string>()
let source: Sandbox | undefined
let restored: Sandbox | undefined
let snapshotAttempted = false
let sourceDeleted = false
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const stage = async <A>(label: string, run: () => Promise<A>) => {
  console.log(`快照文件测试 ▶ ${label}`)
  const started = Date.now()
  const value = await run()
  stages.push({ stage: label, ms: Date.now() - started })
  console.log(`快照文件测试 ✓ ${label}`)
  return value
}
try {
  source = await stage("创建源沙箱", () => Sandbox.create(template, { ...connection, timeoutMs: 600000,
    secure: true, network: { allowPublicTraffic: false }, lifecycle: { onTimeout: "kill", autoResume: false },
    metadata: { purpose: "opencode-independent-snapshot-files", snapshot_probe: name } }))
  report.sourceID = source.sandboxId
  const workspace = await source.commands.run("mkdir -p /workspace/snapshot-files && chmod 0777 /workspace/snapshot-files", { user: "root" })
  assert.equal(workspace.exitCode, 0)
  const text = "独立快照文件存储验证\n删除原沙箱后仍应恢复。\n"
  const binary = Uint8Array.from([0, 1, 2, 127, 128, 254, 255, 10])
  await source.files.write("/workspace/snapshot-files/中文.txt", text)
  await source.files.write("/workspace/snapshot-files/data.bin", binary.buffer)
  assert.equal(await source.files.read("/workspace/snapshot-files/中文.txt"), text)
  assert.equal(hash(await source.files.read("/workspace/snapshot-files/data.bin", { format: "bytes" })), hash(binary))
  report.sourceFilesVerified = true
  report.binarySHA256 = hash(binary)
  console.log("快照文件测试 ✓ 源沙箱文本、二进制写读校验")
  snapshotAttempted = true
  const captured = source
  const snapshot = await stage("创建独立 Snapshot（不调用 pause）", () => captured.createSnapshot({ name, requestTimeoutMs: 300000 }))
  ownedSnapshots.add(snapshot.snapshotId)
  report.snapshotID = snapshot.snapshotId
  sourceDeleted = await stage("删除源沙箱", () => captured.kill())
  assert.ok(sourceDeleted)
  try { await Sandbox.getInfo(captured.sandboxId, connection); throw new Error("Source still exists") }
  catch (error) { if (!(error instanceof SandboxNotFoundError)) throw error }
  report.sourceDeletedBeforeRestore = true
  restored = await stage("从快照创建不同的新沙箱", () => Sandbox.create(snapshot.snapshotId, { ...connection,
    secure: true, network: { allowPublicTraffic: false }, timeoutMs: 300000 }))
  report.restoredID = restored.sandboxId
  assert.notEqual(restored.sandboxId, captured.sandboxId)
  assert.equal(await restored.files.read("/workspace/snapshot-files/中文.txt"), text)
  assert.equal(hash(await restored.files.read("/workspace/snapshot-files/data.bin", { format: "bytes" })), hash(binary))
  report.restoredFilesVerified = true
  report.status = "passed"
  console.log("快照文件测试 ✓ 原沙箱已删除，新沙箱文件内容与 SHA-256 一致")
} catch (error) {
  report.status = "blocked-or-failed"
  report.error = error instanceof Error ? error.message.replace(/e2b_[a-zA-Z0-9]+/g, "[REDACTED]") : "snapshot test failed"
  process.exitCode = 1
} finally {
  const cleanup: Array<Record<string, unknown>> = []
  for (const sandbox of [restored, sourceDeleted ? undefined : source]) {
    if (!sandbox) continue
    try { cleanup.push({ sandboxID: sandbox.sandboxId, killed: await sandbox.kill() }) }
    catch { cleanup.push({ sandboxID: sandbox.sandboxId, error: "sandbox cleanup failed" }); process.exitCode = 1 }
  }
  // A timed-out snapshot request may still have completed. Reconcile only this
  // probe's unique name, never unrelated snapshots from the account.
  if (snapshotAttempted && !ownedSnapshots.size && source) {
    try {
      const pages = Sandbox.listSnapshots({ ...connection, sandboxId: source.sandboxId })
      while (pages.hasNext) for (const entry of await pages.nextItems()) {
        if (entry.names.some((value) => value.split("/").at(-1)?.split(":")[0] === name)) ownedSnapshots.add(entry.snapshotId)
      }
    } catch { cleanup.push({ snapshotName: name, reconciliation: "unavailable" }) }
  }
  for (const snapshotID of ownedSnapshots) {
    // Instance termination can return before its snapshot reference is released.
    // Only retry this idempotent deletion of our uniquely owned snapshot.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const deleted = await Sandbox.deleteSnapshot(snapshotID, { ...connection, requestTimeoutMs: 15000 })
        cleanup.push({ snapshotID, deleted, attempts: attempt + 1 })
        break
      } catch (error) {
        if (attempt < 4) { await new Promise((resolve) => setTimeout(resolve, 1000)); continue }
        cleanup.push({ snapshotID, error: error instanceof Error ? error.message.replace(/e2b_[a-zA-Z0-9]+/g, "[REDACTED]") : "snapshot cleanup failed" })
        process.exitCode = 1
      }
    }
  }
  report.cleanup = cleanup
  const directory = process.env.OPENCODE_ALIYUN_EVIDENCE ?? "../../artifacts/aliyun-sandbox/independent-snapshot-files"
  await mkdir(directory, { recursive: true })
  await writeFile(`${directory}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
