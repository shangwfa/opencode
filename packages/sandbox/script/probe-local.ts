import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
const sb = await Sandbox.create({
  connectionConfig: new ConnectionConfig({ domain: "localhost:8080", protocol: "http", useServerProxy: false }),
  image: "opencode-opensandbox:local",
  timeoutSeconds: 120,
})
console.log("created:", sb.id)
const exec = await sb.commands.run("echo local-sandbox-ok && node --version", {}, {}, AbortSignal.timeout(30000))
console.log("exec:", JSON.stringify({ exit: exec.exitCode, out: exec.logs.stdout.map((l) => l.text).join("") }))
await sb.kill()
console.log("killed")
