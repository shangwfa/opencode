// 平台定位：真实 Next.js 依赖 + Docker 事件；不修改平台/依赖包。
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { execFileSync, spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
const require = createRequire(new URL("../../../packages/core/package.json", import.meta.url))
const { Sandbox, SandboxManager, ConnectionConfig } = await import(pathToFileURL(require.resolve("@alibaba-group/opensandbox")).href)
const config = new ConnectionConfig({ domain: "127.0.0.1:8080", protocol: "http", useServerProxy: true, apiKey: process.env.SANDBOX_API_KEY })
const manager = SandboxManager.create({ connectionConfig: config })
const output = new URL("../sandbox/store/snapshot-platform-timing-2026-10-03.json", import.meta.url)
const data = { startedAt: new Date().toISOString(), rows: [], events: [], snapshots: [], cleanup: [] }
const sleep = ms => new Promise(r => setTimeout(r, ms))
let sb, monitor
function save() { writeFileSync(output, JSON.stringify(data, null, 2)) }
async function command(script) {
  const result = await sb.commands.run(`set -e; ${script}; echo PLATFORM_COMMAND_OK`, { timeoutSeconds: 600 })
  const text = JSON.stringify(result)
  if (!text.includes("PLATFORM_COMMAND_OK") || result.error) throw new Error(text.slice(-1000))
  console.log(text.slice(-600))
}
async function sample(scenario, direct = false) {
  await sb.renew(1800)
  const row = { scenario, direct, startedAt: Date.now() }
  const progress = setInterval(() => console.log(`${scenario} 等待 ${(Date.now() - row.startedAt) / 1000}s`), 10000)
  console.log(`开始 ${scenario}`)
  try {
    if (direct) {
      row.tag = `opensandbox-snapshots:platform-diagnostic-${sb.id}`
      await new Promise((resolve, reject) => {
        const child = spawn("docker", ["commit", data.containerID, row.tag])
        let error = ""
        child.stderr.on("data", chunk => error += chunk)
        child.on("error", reject)
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(error)))
      })
      row.dockerCliFinishedAt = Date.now()
      data.directImage = row.tag
    } else {
      const snapshot = await manager.createSnapshot(sb.id, { name: `platform-timing-${scenario}` })
      row.acceptedAt = Date.now()
      row.snapshotID = snapshot.id
      data.snapshots.push(snapshot.id)
      save()
      let status = snapshot.status
      while (status.state !== "Ready") {
        if (status.state === "Failed") throw new Error(JSON.stringify(status))
        if (Date.now() - row.startedAt > 180000) throw new Error("超过 180s，停止诊断")
        await sleep(250)
        status = (await manager.getSnapshot(snapshot.id)).status
      }
      row.readyTransitionAt = Date.parse(status.lastTransitionAt)
      row.readyObservedAt = Date.now()
    }
    await sleep(500)
    row.events = data.events.filter(e => e.wallMs >= row.startedAt - 100 && e.wallMs <= Date.now())
    const pause = row.events.find(e => e.action === "pause")
    const unpause = row.events.find(e => e.action === "unpause")
    const commit = row.events.find(e => e.action === "commit")
    row.elapsedMs = (row.readyObservedAt ?? row.dockerCliFinishedAt) - row.startedAt
    row.beforePauseMs = pause ? pause.wallMs - row.startedAt : null
    row.pausedMs = pause && unpause ? unpause.wallMs - pause.wallMs : null
    row.pauseToCommitMs = pause && commit ? commit.wallMs - pause.wallMs : null
    row.commitToReadyMs = commit && row.readyTransitionAt ? row.readyTransitionAt - commit.wallMs : null
    // 平台状态时间与 Docker 事件时间出现负差，不用它拆分亚秒级阶段。
    row.commitReceivedToReadyObservedMs = commit && row.readyObservedAt ? row.readyObservedAt - commit.receivedAt : null
    row.diff = JSON.parse(execFileSync("docker", ["container", "inspect", "--size", data.containerID], { encoding: "utf8" }))[0].SizeRw
    const tag = row.tag ?? `opensandbox-snapshots:${row.snapshotID}`
    const image = JSON.parse(execFileSync("docker", ["image", "inspect", tag], { encoding: "utf8" }))[0]
    row.imageSize = image.Size
    row.layerCount = image.RootFS.Layers.length
    console.log(JSON.stringify({ scenario, elapsedMs: row.elapsedMs, beforePauseMs: row.beforePauseMs, pausedMs: row.pausedMs, pauseToCommitMs: row.pauseToCommitMs, commitToReadyMs: row.commitToReadyMs, sizeRw: row.diff }))
    data.rows.push(row)
    save()
  } finally { clearInterval(progress) }
}
try {
  const disk = execFileSync("df", ["-Pk", process.cwd()], { encoding: "utf8" }).trim().split("\n").at(-1).split(/\s+/)
  data.freeKb = Number(disk[3])
  if (data.freeKb < 15 * 1024 * 1024) throw new Error("可用磁盘不足 15GiB，拒绝开始")
  sb = await Sandbox.create({ image: "opencode-opensandbox:local", connectionConfig: config, timeoutSeconds: 1800, resource: { cpu: "2", memory: "4Gi" }, metadata: { test: "snapshot-platform-timing" } })
  data.sandboxID = sb.id
  data.containerID = execFileSync("docker", ["inspect", "--format", "{{.Id}}", `sandbox-${sb.id}`], { encoding: "utf8" }).trim()
  let buffer = ""
  monitor = spawn("docker", ["events", "--filter", `container=${data.containerID}`, "--format", "{{json .}}"])
  monitor.stdout.on("data", chunk => {
    buffer += chunk
    const lines = buffer.split("\n"); buffer = lines.pop()
    for (const line of lines) {
      try { const e = JSON.parse(line); if (["pause", "unpause", "commit"].includes(e.Action)) data.events.push({ action: e.Action, wallMs: e.timeNano / 1e6, receivedAt: Date.now() }) }
      catch (error) { data.eventError = String(error) }
    }
  })
  await sleep(500)
  await command('mkdir -p /workspace/app; cd /workspace; printf \'{"private":true,"dependencies":{"next":"16.3.8","react":"19.3.0","react-dom":"19.3.0"}}\' > package.json; printf "export default function Page(){return <main>test</main>}\\n" > app/page.jsx; printf "store-dir=.pnpm-store\\n" > .npmrc')
  await sample("01_empty")
  console.log("安装固定版本 Next/React，最多等待 600s")
  const progress = setInterval(() => console.log("依赖安装进行中"), 10000)
  try { await command("cd /workspace; pnpm install") } finally { clearInterval(progress) }
  await sample("02_installed")
  await command('printf "\\n// modified\\n" >> /workspace/app/page.jsx')
  await sample("03_source_change")
  await command('printf "\\n// direct commit comparison\\n" >> /workspace/app/page.jsx')
  await sample("04_direct_docker_commit", true)
} catch (error) { data.error = String(error); console.error(data.error); process.exitCode = 1 }
finally {
  monitor?.kill()
  if (sb) {
    try { await sb.kill(); await sb.close(); data.cleanup.push({ sandboxID: sb.id, ok: true }) }
    catch (error) { data.cleanup.push({ sandboxID: sb.id, error: String(error) }) }
  }
  for (const id of data.snapshots) {
    try {
      const info = await manager.getSnapshot(id)
      if (info.sandboxId !== data.sandboxID) throw new Error("归属不符，拒绝删除")
      await manager.deleteSnapshot(id); data.cleanup.push({ snapshotID: id, ok: true })
    } catch (error) { data.cleanup.push({ snapshotID: id, error: String(error) }) }
  }
  if (data.directImage) {
    try { execFileSync("docker", ["image", "rm", data.directImage], { stdio: "ignore" }); data.cleanup.push({ image: data.directImage, ok: true }) }
    catch (error) { data.cleanup.push({ image: data.directImage, error: String(error) }) }
  }
  save(); console.log(`诊断记录：${output.pathname}`)
}
