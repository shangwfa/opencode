import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const config = new ConnectionConfig({
  domain: process.env.OPENCODE_SANDBOX_DOMAIN!,
  protocol: "http",
  apiKey: process.env.OPENCODE_SANDBOX_API_KEY,
})

const sb = await Sandbox.create({
  connectionConfig: config,
  image: process.env.OPENCODE_SANDBOX_IMAGE!,
  timeoutSeconds: 300,
})

console.log("=== Environment Probe ===\n")

const checks = [
  "cat /etc/os-release | head -5",
  "which python python3 node bun npm npx 2>/dev/null; echo '---'",
  "python3 --version 2>/dev/null || python --version 2>/dev/null || echo 'no python'",
  "node --version 2>/dev/null || echo 'no node'",
  "which bash sh git curl wget gcc make 2>/dev/null; echo '---'",
  "ls /workspace/",
  "echo HOME=$HOME USER=$(whoami) PWD=$(pwd)",
  "df -h /workspace 2>/dev/null",
  "ls /usr/bin/ | head -30",
]

for (const cmd of checks) {
  console.log(`> ${cmd}`)
  const r = await sb.commands.run(cmd)
  console.log(r.logs.stdout.map((l: any) => l.text).join(""))
  if (r.logs.stderr.length) console.log("  stderr:", r.logs.stderr.map((l: any) => l.text).join(""))
}

await sb.kill()
await sb.close()
console.log("Done")
