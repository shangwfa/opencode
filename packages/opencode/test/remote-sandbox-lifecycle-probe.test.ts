import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const config = new ConnectionConfig({
  domain: process.env.OPENCODE_SANDBOX_DOMAIN!,
  protocol: "http",
  apiKey: process.env.OPENCODE_SANDBOX_API_KEY,
  useServerProxy: true,
  requestTimeoutSeconds: 60,
})
const image = process.env.OPENCODE_SANDBOX_IMAGE!

async function main() {
  console.log("=== Sandbox Lifecycle API Probe ===\n")

  // 1. Create with manual TTL (no auto-expire)
  console.log("[1] Create with timeoutSeconds=null (manual mode)...")
  let sb: Sandbox | null = null
  try {
    sb = await Sandbox.create({
      connectionConfig: config,
      image,
      timeoutSeconds: null,
    })
    console.log(`  ✓ id=${sb.id}`)
  } catch (e: any) {
    console.log(`  ✗ ${e?.message ?? e}`)
    return
  }

  // 2. getInfo
  console.log("\n[2] getInfo()...")
  try {
    const info = await sb.getInfo()
    console.log(`  state:       ${info.status.state}`)
    console.log(`  createdAt:   ${info.createdAt}`)
    console.log(`  expiresAt:   ${info.expiresAt}`)
    console.log(`  full status: ${JSON.stringify(info.status)}`)
  } catch (e: any) {
    console.log(`  ✗ ${e?.message ?? e}`)
  }

  // 3. renew
  console.log("\n[3] renew(30min)...")
  try {
    const res = await sb.renew(30 * 60)
    console.log(`  ✓ renewed`)
    console.log(`  response: ${JSON.stringify(res)}`)
    const info2 = await sb.getInfo()
    console.log(`  expiresAt after renew: ${info2.expiresAt}`)
  } catch (e: any) {
    console.log(`  ✗ ${e?.message ?? e}`)
  }

  // 4. pause
  console.log("\n[4] pause()...")
  try {
    await sb.pause()
    console.log("  ✓ paused")

    const info3 = await sb.getInfo()
    console.log(`  state after pause: ${info3.status.state}`)
  } catch (e: any) {
    console.log(`  ✗ ${e?.message ?? e}`)

    // Try static resume anyway
    console.log("\n[5] skip resume (pause failed)")
    console.log("\n[6] Testing resume with a fresh sandbox instead...")

    // Create another sandbox, then test resume path
    const sb2 = await Sandbox.create({ connectionConfig: config, image, timeoutSeconds: null })
    console.log(`  Created sandbox2: ${sb2.id}`)
    const info4 = await sb2.getInfo()
    console.log(`  state: ${info4.status.state}`)
    await sb2.kill()
    await sb2.close()
    console.log("  ✓ sandbox2 cleaned up")
    return
  }

  // 5. resume (static method)
  console.log("\n[5] Sandbox.resume()...")
  try {
    const resumed = await Sandbox.resume({
      connectionConfig: config,
      sandboxId: sb.id,
    })
    console.log(`  ✓ resumed, id=${resumed.id}`)

    const info4 = await resumed.getInfo()
    console.log(`  state after resume: ${info4.status.state}`)
    console.log(`  expiresAt after resume: ${info4.expiresAt}`)

    // renew after resume
    await resumed.renew(30 * 60)
    const info5 = await resumed.getInfo()
    console.log(`  expiresAt after renew: ${info5.expiresAt}`)

    sb = resumed
  } catch (e: any) {
    console.log(`  ✗ ${e?.message ?? e}`)
  }

  // 6. cleanup
  console.log("\n[6] Cleanup...")
  try {
    if (sb) {
      await sb.kill()
      await sb.close()
      console.log("  ✓ killed + closed")
    }
  } catch (e: any) {
    console.log(`  ✗ ${e?.message ?? e}`)
  }

  console.log("\n=== Done ===")
}

main().catch((err) => {
  console.error("\n✗ FAILED:", err?.message ?? err)
  process.exit(1)
})
