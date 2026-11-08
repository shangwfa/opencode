// 应急：在指定会话的沙箱中安装 Code Mode Runner。
// 用法：bun install-codemode-runner.mjs <saasBase> <password> <sessionID> <runner.mjs.gz> [chunkSize]
// 适用于 OpenSandbox 镜像尚未内置 /opt/opencode-codemode-runner.mjs 的环境。
//
// 注意：本脚本通过 shell 分块上传，会在会话中留下数十条消息，明显膨胀上下文，
// 仅用于临时验证。长期做法是使用带 Runner 的沙箱镜像，或在控制面直接上传文件
// （见 docs/test-cases/code-mode/code-mode.md）。
import { readFileSync } from "node:fs"

const [base, password, sessionId, source, chunkArg] = process.argv.slice(2)
if (!base || !password || !sessionId || !source) {
  console.error("usage: bun install-codemode-runner.mjs <saasBase> <password> <sessionID> <runner.mjs.gz> [chunkSize]")
  process.exit(1)
}
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const encoded = readFileSync(source).toString("base64")
const size = Number(chunkArg ?? 40_000)
const stamp = `runner-install-${Date.now()}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(command, timeoutMs = 60_000) {
  const unique = `${command} # ${stamp}-${crypto.randomUUID()}`
  const post = await fetch(`${base}/api/session/${sessionId}/shell`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ command: unique }),
  })
  if (!post.ok) throw new Error(`shell ${post.status}`)
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const response = await fetch(`${base}/api/experimental/session/${sessionId}/log?follow=false&after=0`, {
      headers: { authorization: auth },
    })
    const text = await response.text()
    const events = []
    if (text.trim().startsWith("[")) {
      try { events.push(...JSON.parse(text)) } catch {}
    } else {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue
        try { events.push(JSON.parse(line.slice(5).trim())) } catch {}
      }
    }
    const ended = events.find((event) => event.type === "session.shell.ended" && event.data?.shell?.command === unique)
    if (ended) return { exit: ended.data.shell.exit, output: ended.data.output?.output ?? "" }
    await sleep(500)
  }
  throw new Error(`timeout: ${command.slice(0, 60)}`)
}

const prepared = await run("mkdir -p /workspace/.opencode && rm -f /workspace/.opencode/runner.b64")
if (prepared.exit !== 0) throw new Error(`prepare failed: ${prepared.output}`)
for (let offset = 0; offset < encoded.length; offset += size) {
  const chunk = encoded.slice(offset, offset + size)
  const result = await run(`printf '%s' '${chunk}' >> /workspace/.opencode/runner.b64`)
  if (result.exit !== 0) throw new Error(`chunk ${offset} failed: ${result.output}`)
  process.stdout.write(`\r${Math.min(offset + size, encoded.length)}/${encoded.length}`)
}
process.stdout.write("\n")
const install = await run(
  "base64 -d /workspace/.opencode/runner.b64 > /tmp/runner.gz && gzip -dc /tmp/runner.gz > /opt/opencode-codemode-runner.mjs && chmod 0755 /opt/opencode-codemode-runner.mjs && node --check /opt/opencode-codemode-runner.mjs && rm -f /workspace/.opencode/runner.b64",
  120_000,
)
if (install.exit !== 0) throw new Error(`install failed: ${install.output}`)
// 安装后清理旧 daemon，下一次 execute 会用新文件启动。
await run("if [ -s /tmp/opencode-codemode-runner.pid ]; then kill \"$(cat /tmp/opencode-codemode-runner.pid)\" 2>/dev/null || true; fi; rm -f /tmp/opencode-codemode-runner.pid /tmp/opencode-codemode-runner.log")
console.log(`installed /opt/opencode-codemode-runner.mjs in ${sessionId}`)
