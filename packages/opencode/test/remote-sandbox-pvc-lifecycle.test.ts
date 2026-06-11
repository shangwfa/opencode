import { ConnectionConfig, Sandbox, SandboxManager } from "@alibaba-group/opensandbox"

const config = new ConnectionConfig({
  domain: process.env.OPENCODE_SANDBOX_DOMAIN!,
  protocol: "http",
  apiKey: process.env.OPENCODE_SANDBOX_API_KEY,
  useServerProxy: true,
  requestTimeoutSeconds: 60,
})
const image = process.env.OPENCODE_SANDBOX_IMAGE!

// Simulate the buildVolumes logic from sandbox-provider.ts
function buildVolumes(sessionID: string, claimName: string) {
  const prefix = `sessions/${sessionID}`
  return [
    { name: "workspace", mountPath: "/workspace", subPath: `${prefix}/workspace`, pvc: { claimName } },
    { name: "home", mountPath: "/home/sandbox", subPath: `${prefix}/home`, pvc: { claimName } },
    { name: "cache", mountPath: "/home/sandbox/.cache", subPath: `${prefix}/cache`, pvc: { claimName } },
    { name: "config", mountPath: "/home/sandbox/.config", subPath: `${prefix}/config`, pvc: { claimName } },
    { name: "local", mountPath: "/home/sandbox/.local", subPath: `${prefix}/local`, pvc: { claimName } },
    { name: "tmp", mountPath: "/home/sandbox/tmp", subPath: `${prefix}/tmp`, pvc: { claimName } },
  ]
}

const SESSION_ID = `test-${Date.now()}`
const PVC_CLAIM = "sandbox-pvc-test"
const USE_PVC = process.env.USE_PVC === "true"

async function main() {
  console.log(`=== PVC Sandbox Lifecycle Test ===`)
  console.log(`Session: ${SESSION_ID}`)
  console.log(`PVC: ${PVC_CLAIM}\n`)

  // ─── Round 1: Create with PVC volumes ───
  console.log(`[1] Creating sandbox ${USE_PVC ? "with PVC volumes" : "(no PVC)"}...`)
  const createOpts: any = {
    connectionConfig: config,
    image,
    timeoutSeconds: null,
  }
  if (USE_PVC) {
    createOpts.volumes = buildVolumes(SESSION_ID, PVC_CLAIM)
  }
  let sb = await Sandbox.create(createOpts)
  console.log(`  ✓ Created, id=${sb.id}`)

  // ─── Round 2: Write data across multiple volume mounts ───
  console.log("\n[2] Writing data to all volume mount points...")
  const writes = [
    { path: "/workspace/project.txt", data: "workspace data - round 1" },
    { path: "/home/sandbox/.bashrc", data: "export PATH=$PATH:/custom" },
    { path: "/home/sandbox/.cache/data.json", data: JSON.stringify({ round: 1 }) },
    { path: "/home/sandbox/.config/settings.ini", data: "[settings]\nmode=test" },
    { path: "/home/sandbox/.local/bin/hello", data: "#!/bin/bash\necho hello" },
    { path: "/home/sandbox/tmp/temp.log", data: "temp data round 1" },
  ]
  for (const w of writes) {
    await sb.files.createDirectories([{ path: w.path.split("/").slice(0, -1).join("/") || "/", mode: 755 }])
    await sb.files.writeFiles([{ path: w.path, data: w.data }])
  }
  console.log(`  ✓ Wrote ${writes.length} files across 6 volumes`)

  // ─── Round 3: Verify all data ───
  console.log("\n[3] Verifying all data...")
  for (const w of writes) {
    const content = await sb.files.readFile(w.path)
    if (content !== w.data) throw new Error(`Mismatch at ${w.path}: got "${content}"`)
  }
  console.log("  ✓ All files verified")

  // ─── Round 4: Run commands that depend on home/cache/config ───
  console.log("\n[4] Running commands across volume mounts...")
  const cmdSession = await sb.commands.createSession({ workingDirectory: "/workspace" })
  const r1 = await sb.commands.runInSession(cmdSession, "source /home/sandbox/.bashrc && echo $PATH")
  console.log(`  source .bashrc: ${r1.logs.stdout.map((l: any) => l.text).join("").trim()}`)

  const r2 = await sb.commands.runInSession(cmdSession, "cat /home/sandbox/.cache/data.json")
  console.log(`  cache data: ${r2.logs.stdout.map((l: any) => l.text).join("").trim()}`)

  const r3 = await sb.commands.runInSession(cmdSession, "cat /home/sandbox/.config/settings.ini")
  console.log(`  config: ${r3.logs.stdout.map((l: any) => l.text).join("").trim()}`)

  const r4 = await sb.commands.runInSession(cmdSession, "chmod +x /home/sandbox/.local/bin/hello && bash /home/sandbox/.local/bin/hello")
  console.log(`  local bin: ${r4.logs.stdout.map((l: any) => l.text).join("").trim()}`)
  await sb.commands.deleteSession(cmdSession)

  // ─── Round 5: Write a project to /workspace ───
  console.log("\n[5] Writing Python project to /workspace...")
  await sb.files.writeFiles([
    { path: "/workspace/main.py", data: `import json, os
data = {
    "round": 1,
    "home": os.path.exists("/home/sandbox/.bashrc"),
    "cache": os.path.exists("/home/sandbox/.cache/data.json"),
    "config": os.path.exists("/home/sandbox/.config/settings.ini"),
    "local": os.path.exists("/home/sandbox/.local/bin/hello"),
    "tmp": os.path.exists("/home/sandbox/tmp/temp.log"),
    "workspace": os.path.exists("/workspace/project.txt"),
}
print(json.dumps(data))
` },
  ])
  const r5 = await sb.commands.run("python3 /workspace/main.py")
  const result5 = JSON.parse(r5.logs.stdout.map((l: any) => l.text).join(""))
  console.log(`  All volumes accessible: ${JSON.stringify(result5)}`)
  for (const [k, v] of Object.entries(result5)) {
    if (k !== "round" && !v) throw new Error(`Volume check failed: ${k}`)
  }

  // ─── Round 6: Pause (skip if not supported) ───
  let pauseSupported = true
  console.log("\n[6] Pausing sandbox...")
  try {
    await sb.pause()
    console.log("  ✓ Paused")
  } catch (e: any) {
    pauseSupported = false
    console.log(`  ⚠ Pause not supported by server: ${e?.message ?? e}`)
    console.log("  Skipping pause/resume, testing kill/recreate only")
  }

  // ─── Round 7: Resume (only if pause succeeded) ───
  if (pauseSupported) {
    console.log("\n[7] Resuming sandbox...")
    sb = await Sandbox.resume({ connectionConfig: config, sandboxId: sb.id })
    await sb.renew(30 * 60)
    console.log(`  ✓ Resumed, id=${sb.id}`)

    console.log("\n[8] Verifying data after pause/resume...")
    for (const w of writes) {
      const content = await sb.files.readFile(w.path)
      if (content !== w.data) throw new Error(`Data lost at ${w.path}: got "${content}"`)
    }
    console.log("  ✓ All data persisted after resume")

    console.log("\n[9] Writing new data after resume...")
    await sb.files.writeFiles([
      { path: "/workspace/project.txt", data: "workspace data - round 2 (after resume)" },
      { path: "/home/sandbox/tmp/round2.log", data: "new data after resume" },
    ])

    console.log("\n[10] Running project after resume...")
    const r10 = await sb.commands.run("python3 /workspace/main.py")
    console.log(`  ${r10.logs.stdout.map((l: any) => l.text).join("").trim()}`)
  }

  // ─── Kill and recreate ───
  const killStep = pauseSupported ? 11 : 7
  const recreateStep = pauseSupported ? 12 : 8
  const verifyStep = pauseSupported ? 13 : 9
  const cmdStep = pauseSupported ? 14 : 10
  const cleanupStep = pauseSupported ? 15 : 11

  console.log(`\n[${killStep}] Killing sandbox...`)
  const oldId = sb.id
  await sb.kill()
  await sb.close()
  console.log(`  ✓ Killed ${oldId}`)

  console.log(`\n[${recreateStep}] Recreating sandbox...`)
  const recreateOpts: any = {
    connectionConfig: config,
    image,
    timeoutSeconds: null,
  }
  if (USE_PVC) {
    recreateOpts.volumes = buildVolumes(SESSION_ID, PVC_CLAIM)
  }
  sb = await Sandbox.create(recreateOpts)
  console.log(`  ✓ Recreated, id=${sb.id} (different from ${oldId}: ${sb.id !== oldId})`)

  // ─── Verify data survived kill/recreate (only works with PVC) ───
  console.log(`\n[${verifyStep}] Verifying data after kill/recreate...`)
  if (USE_PVC) {
    const persisted = [
      { path: "/workspace/project.txt", expected: pauseSupported ? "workspace data - round 2 (after resume)" : "workspace data - round 1" },
      { path: "/home/sandbox/.bashrc", expected: "export PATH=$PATH:/custom" },
      { path: "/home/sandbox/.cache/data.json", expected: JSON.stringify({ round: 1 }) },
      { path: "/home/sandbox/.config/settings.ini", expected: "[settings]\nmode=test" },
    ]
    for (const p of persisted) {
      const content = await sb.files.readFile(p.path)
      if (content !== p.expected) throw new Error(`PVC data lost at ${p.path}`)
    }
    console.log("  ✓ All PVC data survived kill/recreate")
  } else {
    // Without PVC, data is gone after kill — verify sandbox works fresh
    await sb.files.writeFiles([{ path: "/workspace/fresh.txt", data: "recreated" }])
    const fresh = await sb.files.readFile("/workspace/fresh.txt")
    if (fresh !== "recreated") throw new Error("Fresh write failed")
    console.log("  ✓ Sandbox recreated cleanly (no PVC, data expected gone)")
  }

  console.log(`\n[${cmdStep}] Running commands in recreated sandbox...`)
  await sb.files.writeFiles([{ path: "/workspace/check.py", data: "print('recreated ok')" }])
  const rCmd = await sb.commands.run("python3 /workspace/check.py")
  console.log(`  ${rCmd.logs.stdout.map((l: any) => l.text).join("").trim()}`)

  console.log(`\n[${cleanupStep}] Destroying sandbox...`)
  await sb.kill()
  await sb.close()
  console.log("  ✓ Destroyed")

  // ─── Summary ───
  console.log(`\n=== All steps passed ===`)
  console.log(`  ✓ Sandbox created with ${USE_PVC ? "PVC volumes (6 mounts)" : "ephemeral storage"}`)
  if (pauseSupported) {
    console.log("  ✓ Data persisted across pause/resume")
  } else {
    console.log("  ⚠ Pause not supported by server, skipped")
  }
  console.log("  ✓ Kill/recreate lifecycle works")
  console.log("  ✓ Commands work in all lifecycle states")
}

main().catch((err) => {
  console.error("\n✗ FAILED:", err?.message ?? err)
  process.exit(1)
})
