// 真实 Next.js 依赖/文件修改快照基准。仅操作本脚本创建的沙箱与快照。
// bun docs/test-cases/scripts/nextjs-snapshot-benchmark.mjs
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { execFileSync } from "node:child_process"
import { touchSnapshotMarker, workspaceUnchangedSinceSnapshot } from "../../../packages/core/src/sandbox/snapshot-reuse.ts"

const require = createRequire(new URL("../../../packages/core/package.json", import.meta.url))
const { Effect } = await import(pathToFileURL(require.resolve("effect")).href)
const { Sandbox, SandboxManager, ConnectionConfig } = await import(pathToFileURL(require.resolve("@alibaba-group/opensandbox")).href)
const trials = Number(process.env.TRIALS ?? 2)
if (!Number.isSafeInteger(trials) || trials < 1 || trials > 5) throw new Error("TRIALS 必须为 1..5")
const image = process.env.SANDBOX_IMAGE ?? "opencode-opensandbox:local"
const connectionConfig = new ConnectionConfig({ domain: process.env.SANDBOX_DOMAIN ?? "127.0.0.1:8080", protocol: "http", apiKey: process.env.SANDBOX_API_KEY, useServerProxy: true })
const manager = SandboxManager.create({ connectionConfig })
const rawPath = process.env.RESULT_JSON ?? "/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/nextjs-snapshot-benchmark.json"
const reportPath = process.env.RESULT_MD ?? new URL("../sandbox/store/nextjs-snapshot-performance-2026-10-03.md", import.meta.url).pathname
const results = []
const sandboxes = new Map()
const snapshots = new Map()
const versions = {}
const reportOnly = process.argv.includes("--report-only")
const cacheOnly = process.argv.includes("--cache-only")
let failure = process.env.FAILURE_NOTE ?? null
if (reportOnly || cacheOnly) {
  const saved = JSON.parse(readFileSync(rawPath, "utf8"))
  results.push(...saved.results)
  Object.assign(versions, saved.versions)
  failure ??= saved.failure ?? null
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
const seconds = (ms) => (ms / 1000).toFixed(2)

async function timed(label, action) {
  const start = performance.now()
  console.log(`开始 ${label}`)
  const progress = setInterval(() => console.log(`  ${label} 进行中 ${seconds(performance.now() - start)}s`), 10000)
  try {
    const value = await action()
    const ms = performance.now() - start
    console.log(`完成 ${label}: ${seconds(ms)}s`)
    return { value, ms }
  } finally { clearInterval(progress) }
}

async function command(sb, script, label, timeoutSeconds = 600) {
  return timed(label, async () => {
    const id = await sb.commands.createSession({ workingDirectory: "/workspace" })
    let output = ""
    let completed = false
    const abort = AbortSignal.timeout((timeoutSeconds + 20) * 1000)
    try {
      for await (const event of sb.commands.runInSessionStream(id, script, { workingDirectory: "/workspace", timeoutSeconds }, abort)) {
        if (event.type === "stdout" || event.type === "stderr") {
          output += `${event.text ?? ""}\n`
          if (event.text) console.log(`  ${event.text.slice(0, 350)}`)
        }
        if (event.type === "error") throw new Error(`命令失败: ${event.text ?? JSON.stringify(event)}`)
        if (event.type === "execution_complete") { completed = true; break }
      }
      if (!completed || !output.includes("BENCH_COMMAND_OK")) throw new Error(`命令未成功完成: ${output.slice(-500)}`)
      return output
    } finally { await sb.commands.deleteSession(id).catch(() => {}) }
  })
}

async function create(createOptions, label) {
  const result = await timed(label, () => Sandbox.create({
    ...createOptions, connectionConfig, timeoutSeconds: 3600,
    readyTimeoutSeconds: 300, resource: { cpu: "2", memory: "4Gi" },
    metadata: { managedBy: "opencode-saas", test: "nextjs-snapshot-benchmark" },
  }))
  sandboxes.set(result.value.id, result.value)
  await result.value.commands.run("mkdir -p /workspace")
  return result
}

async function checkpoint(sb, trial, scenario, extra = {}) {
  const row = { trial, scenario, sandboxID: sb.id, ...extra }
  await sb.renew(1800)
  const token = randomUUID()
  const preparation = await timed(`${scenario} / manifest 准备`, async () => {
    try { return { ok: true, ...await Effect.runPromise(touchSnapshotMarker(sb, { token })) } }
    catch (error) { return { ok: false, error: String(error) } }
  })
  row.prepareMs = preparation.ms
  row.prepareOk = preparation.value.ok
  row.workspaceKb = preparation.value.workspaceKb ?? null
  row.prepareError = preparation.value.error ?? null
  if (!row.prepareOk) console.log("注意：生产服务会在此停止；下面单独测平台快照，不视为服务成功。")
  const start = performance.now()
  const requested = await timed(`${scenario} / createSnapshot 请求`, () => manager.createSnapshot(sb.id, { name: `next-bench-${trial}-${scenario}` }))
  row.requestMs = requested.ms
  row.snapshotID = requested.value.id
  snapshots.set(row.snapshotID, sb.id)
  save()
  row.initialState = requested.value.status.state
  let status = requested.value.status
  let lastProgress = performance.now()
  while (status.state !== "Ready") {
    if (status.state === "Failed") throw new Error(`远端快照失败: ${JSON.stringify(status)}`)
    if (performance.now() - start > 900000) throw new Error("快照超过 15 分钟未 Ready")
    await sleep(1000)
    status = (await manager.getSnapshot(row.snapshotID)).status
    if (performance.now() - lastProgress > 10000) {
      console.log(`  ${scenario} / ${status.state} 已等待 ${seconds(performance.now() - start)}s`)
      lastProgress = performance.now()
    }
  }
  row.remoteReadyMs = performance.now() - start
  row.serviceCheckpointMs = row.prepareOk ? row.prepareMs + row.remoteReadyMs : null
  const sizes = await command(sb, "du -sk /workspace /workspace/node_modules /workspace/.pnpm-store 2>/dev/null; find /workspace -type f | wc -l; echo BENCH_COMMAND_OK", `${scenario} / 统计`, 60)
  row.measurements = sizes.value
  try {
    const info = JSON.parse(execFileSync("docker", ["image", "inspect", `opensandbox-snapshots:${row.snapshotID}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))[0]
    row.imageSizeBytes = info.Size
    row.layers = info.RootFS?.Layers?.length
  } catch { row.imageSizeBytes = null }
  if (row.prepareOk) {
    const reuse = await timed(`${scenario} / CLEAN 判定`, () => Effect.runPromise(workspaceUnchangedSinceSnapshot(sb, token)))
    row.reuseMs = reuse.ms
    row.clean = reuse.value
  }
  results.push(row)
  save()
  console.log(`结果 ${scenario}: 准备 ${seconds(row.prepareMs)}s，远端 Ready ${seconds(row.remoteReadyMs)}s，CLEAN ${row.reuseMs == null ? "未测" : `${seconds(row.reuseMs)}s/${row.clean}`}`)
  return row
}

function save() {
  mkdirSync(dirname(rawPath), { recursive: true })
  writeFileSync(rawPath, JSON.stringify({ date: "2026-10-03", image, versions, trials, results, failure, pendingSnapshots: [...snapshots.keys()], pendingSandboxes: [...sandboxes.keys()] }, null, 2))
}

async function cleanup() {
  if (!sandboxes.size && !snapshots.size) return
  console.log("清理仅本轮创建的沙箱及快照")
  for (const [id, sb] of sandboxes) {
    try { await sb.kill(); await sb.close(); sandboxes.delete(id); console.log(`已清理沙箱 ${id}`) }
    catch (error) { console.log(`沙箱清理失败 ${id}: ${String(error)}`) }
  }
  for (const [id, source] of snapshots) {
    try {
      const info = await manager.getSnapshot(id)
      if (info.sandboxId !== source) throw new Error("快照源 ID 不匹配，拒绝删除")
      await manager.deleteSnapshot(id)
      snapshots.delete(id)
      console.log(`已清理快照 ${id}`)
    } catch (error) { console.log(`快照清理失败 ${id}: ${String(error)}`) }
  }
}

const appFiles = {
  "package.json": JSON.stringify({ name: "next-snapshot-benchmark", version: "1.0.0", private: true, scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "16.3.8", react: "19.3.0", "react-dom": "19.3.0" } }, null, 2),
  "app/layout.jsx": "export default function Layout({children}) { return <html><body>{children}</body></html> }\n",
  "app/page.jsx": "export default function Page() { return <main>snapshot benchmark</main> }\n",
  "components/card.jsx": "export function Card({children}) { return <section>{children}</section> }\n",
  ".gitignore": "node_modules/\n.next/\n.pnpm-store/\n",
  ".npmrc": "store-dir=.pnpm-store\nregistry=https://registry.npmjs.org/\n",
}

try {
  for (let trial = cacheOnly ? 2 : 1; !reportOnly && trial <= trials; trial++) {
    // 每轮释放本轮产物；不把两轮数 GB 镜像同时累积到宿主磁盘。
    const disk = execFileSync("df", ["-Pk", process.cwd()], { encoding: "utf8" }).trim().split("\n").at(-1).split(/\s+/)
    const freeKb = Number(disk[3])
    if (!Number.isFinite(freeKb) || freeKb < 10 * 1024 * 1024) throw new Error("可用磁盘不足 10GiB，停止基准以保护环境")
    console.log(`\n===== 第 ${trial}/${trials} 轮 Next.js 实测 =====`)
    const created = await create({ image }, "创建专用沙箱")
    const sb = created.value
    const setup = `node -e ${quote(`const fs=require('fs');for(const [p,text] of Object.entries(${JSON.stringify(appFiles)})){fs.mkdirSync(require('path').dirname(p),{recursive:true});fs.writeFileSync(p,text)}`)}; node -v; npm -v; command -v pnpm; pnpm --version; echo BENCH_COMMAND_OK`
    const environment = await command(sb, setup, "初始化 Next.js 项目及版本确认", 60)
    versions.environment = environment.value
    if (cacheOnly) {
      await command(sb, "pnpm install && pnpm add lucide-react@1.50.0 zod@4.6.5 react-hook-form@7.89.0 @radix-ui/react-dialog@1.1.23 tailwindcss@4.3.3 clsx@2.1.1 tailwind-merge@3.7.0 && echo BENCH_COMMAND_OK", "补测前安装相同依赖")
      const install = await command(sb, "rm -rf /workspace/node_modules; pnpm install --offline --frozen-lockfile && echo BENCH_COMMAND_OK", "补测缓存命中重装")
      await checkpoint(sb, trial, "06_缓存命中重装后", { installMs: install.ms, supplemental: true })
      await command(sb, "rm -rf /workspace/.pnpm-store; echo BENCH_COMMAND_OK", "补测移除下载缓存", 60)
      await checkpoint(sb, trial, "07_不含pnpm_store", { supplemental: true })
      await cleanup()
      break
    }
    const initial = await checkpoint(sb, trial, "01_未安装依赖", { sandboxCreateMs: created.ms })

    const install = await command(sb, "pnpm install && echo BENCH_COMMAND_OK", "安装 Next/React 核心依赖")
    const core = await checkpoint(sb, trial, "02_核心依赖已安装", { installMs: install.ms })

    await command(sb, "printf '\n// benchmark page modification\n' >> app/page.jsx; printf '\n// benchmark card modification\n' >> components/card.jsx; echo BENCH_COMMAND_OK", "修改两份源码", 60)
    await checkpoint(sb, trial, "03_同沙箱仅修改源码")

    const ui = await command(sb, "pnpm add lucide-react@1.50.0 zod@4.6.5 react-hook-form@7.89.0 @radix-ui/react-dialog@1.1.23 tailwindcss@4.3.3 clsx@2.1.1 tailwind-merge@3.7.0 && echo BENCH_COMMAND_OK", "增装常见 UI/表单依赖")
    const expanded = await checkpoint(sb, trial, "04_UI依赖增装后", { installMs: ui.ms })

    const restored = await create({ snapshotId: expanded.snapshotID }, "从含依赖快照恢复新沙箱")
    await command(restored.value, "printf '\n// modification after restore\n' >> app/page.jsx; echo BENCH_COMMAND_OK", "恢复后仅修改源码", 60)
    await checkpoint(restored.value, trial, "05_恢复后仅修改源码", { restoreMs: restored.ms, baseSnapshotID: expanded.snapshotID })

    // 原沙箱的 lockfile/store 保留，仅删本基准的 node_modules，测缓存命中重装。
    const reinstall = await command(sb, "rm -rf /workspace/node_modules; pnpm install --offline --frozen-lockfile && echo BENCH_COMMAND_OK", "保留 pnpm store，离线重装依赖")
    await checkpoint(sb, trial, "06_缓存命中重装后", { installMs: reinstall.ms })

    // 源码及 node_modules 保留，移走 store，隔离缓存对快照的影响。
    // 删除只发生在本脚本专用沙箱中，不操作用户会话。
    await command(sb, "rm -rf /workspace/.pnpm-store; echo BENCH_COMMAND_OK", "移除本基准 pnpm 下载缓存", 60)
    await checkpoint(sb, trial, "07_不含pnpm_store")
    console.log(`第 ${trial} 轮完成；基线 ${initial.snapshotID}，核心依赖快照 ${core.snapshotID}`)
    await cleanup()
    if (sandboxes.size || snapshots.size) throw new Error("本轮清理未完成，不继续下一轮")
  }
} catch (error) {
  failure = String(error)
  console.log(`基准未全部完成：${failure}`)
} finally {
  await cleanup()
  if (!reportOnly) save()
}

const range = (rows, field, unit = "s") => {
  const values = rows.map((row) => row[field]).filter((n) => typeof n === "number" && Number.isFinite(n))
  if (!values.length) return "—"
  const scale = unit === "MiB" ? 1024 * 1024 : 1000
  return `${(Math.min(...values) / scale).toFixed(2)}–${(Math.max(...values) / scale).toFixed(2)}`
}
const cases = [...new Set(results.map((row) => row.scenario))]
const table = cases.map((scenario) => {
  const rows = results.filter((row) => row.scenario === scenario)
  return `| ${scenario} | ${rows.length} | ${range(rows, "installMs")} | ${range(rows, "prepareMs")} | ${range(rows, "remoteReadyMs")} | ${range(rows, "serviceCheckpointMs")} | ${range(rows, "reuseMs")} | ${rows.every((row) => row.clean === true) ? "CLEAN" : "未全部 CLEAN"} |`
})
const report = [
  "# Next.js 沙箱快照耗时实测（2026-10-03）", "",
  `环境：本地 OrbStack/Docker OpenSandbox，镜像 ${image}，沙箱资源 2 CPU / 4Gi；计划 ${trials} 轮串行测试，已完成 ${results.length}/${trials * 7} 个样本，范围为 min–max，不报告 P95。实际 Node 24.19.0、pnpm 10.34.6。`,
  "项目：Next 16.3.8、React/ReactDOM 19.3.0；JS App Router；UI 扩展为 lucide-react、zod、react-hook-form、Radix Dialog、TailwindCSS、clsx、tailwind-merge。pnpm store 显式放在 /workspace/.pnpm-store，不代表部署默认。",
  "",
  "| 场景 | 样本数 | 安装 s | manifest s | 远端到 Ready s | 检查点合计 s | 无变化判定 s | 判定结果 |",
  "|---|---:|---:|---:|---:|---:|---:|---|", ...table, "",
  ...(failure ? [`运行异常记录：${failure}。失败/未 Ready 的情况不进入耗时统计。`, ""] : []),
  "边界：调用真实平台 API，manifest/复用使用当前 core 实现；不含 SaaS HTTP、PG 仲裁、队列等待。Ready 每 1s 观察，生产轮询间隔为 5s。源码修改后仍强制创建快照，以测创建成本；无变化正常应复用而不调用平台。",
  "同沙箱重复创建与从快照恢复后创建分开测量；镜像 Size 为累计逻辑大小，不等于新增存储/传输字节。缓存移除只在本轮专用沙箱执行，不更改生产 prune 策略。",
  ...(results.some((row) => row.supplemental) ? ["缓存命中重装/移除 store 的第二个样本是在恢复环境后重新安装相同依赖补测，不是一次未中断的完整第二轮。"] : []),
  "manifest 准备失败时，生产服务不会创建；本脚本为诊断另外测原始平台调用，合计栏为空，不能视为服务快照成功。", "",
  `原始记录：${rawPath}`, "",
  "## 每轮工作目录统计", "",
  ...results.map((row) => `### ${row.scenario} / 第 ${row.trial} 轮\n\n准备成功：${row.prepareOk}；CLEAN：${row.clean ?? "未测"}；镜像累计大小 MiB：${row.imageSizeBytes == null ? "未知" : (row.imageSizeBytes / 1024 / 1024).toFixed(2)}；层数：${row.layers ?? "未知"}。\n\n${row.measurements.trim().replaceAll("BENCH_COMMAND_OK", "")}\n${row.prepareError ?? ""}\n`),
].join("\n")
mkdirSync(dirname(reportPath), { recursive: true })
writeFileSync(reportPath, report)
writeFileSync(reportPath.replace(/\.md$/, ".json"), JSON.stringify({ date: "2026-10-03", image, versions, trials, results, historicalFailure: failure }, null, 2))
console.log(`报告：${reportPath}\n原始数据：${rawPath}`)
if (failure && !reportOnly) process.exitCode = 1
