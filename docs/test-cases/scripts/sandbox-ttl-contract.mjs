// OpenSandbox TTL API 契约：命令不自动延期；renew 显式更新 expiresAt。
// 只创建、销毁本用例的沙箱，不清理其他会话或容器。
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
const require = createRequire(new URL("../../../packages/core/package.json", import.meta.url))
const { Sandbox, ConnectionConfig } = await import(pathToFileURL(require.resolve("@alibaba-group/opensandbox")).href)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`)
  if (!ok) throw new Error(label)
}
let sandbox
try {
  console.log("创建 TTL=60s 的专用测试沙箱（平台最小值）")
  sandbox = await Sandbox.create({
    image: process.env.SANDBOX_IMAGE ?? "opencode-opensandbox:local",
    connectionConfig: new ConnectionConfig({
      domain: process.env.SANDBOX_DOMAIN ?? "127.0.0.1:8080",
      protocol: "http", apiKey: process.env.SANDBOX_API_KEY,
      useServerProxy: true,
    }),
    timeoutSeconds: 60,
    metadata: { managedBy: "opencode-saas", test: "ttl-contract" },
  })
  console.log(`测试沙箱 ${sandbox.id}`)
  const before = await sandbox.getInfo()
  check(before.expiresAt instanceof Date, "平台返回绝对 expiresAt")
  await sleep(3000)
  await sandbox.commands.run("echo ttl-contract")
  const after = await sandbox.getInfo()
  check(after.expiresAt?.getTime() === before.expiresAt.getTime(), "执行命令不自动延长 TTL")
  await sandbox.renew(120)
  const renewed = await sandbox.getInfo()
  check(renewed.expiresAt?.getTime() > before.expiresAt.getTime(), "renew 显式延长绝对到期时间")
  while (Date.now() < before.expiresAt.getTime() + 2000) {
    console.log(`等待越过原到期时间，剩余 ${Math.max(0, Math.ceil((before.expiresAt.getTime() - Date.now()) / 1000))}s`)
    await sleep(5000)
  }
  await sandbox.commands.run("echo renewed-alive")
  check(true, "超过原 TTL 后续租沙箱仍可执行命令")
} finally {
  if (sandbox) {
    console.log(`清理本用例沙箱 ${sandbox.id}`)
    await sandbox.kill()
    await sandbox.close()
  }
}
