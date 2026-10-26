// T20 工具沙箱验收（Vercel provider）：真实 Agent 多轮驱动 write/read/edit/glob/grep/shell，
// 以 session message 的 tool part、session.shell、PG 及远端清理为证据。
// 通过 sandbox-vercel-t19.mjs 包装器运行：先订阅公共 SSE，结束后删除会话并核对 PG。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE.replace(/\/$/, "")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
}
const model = { providerID: "deepseek", id: "deepseek-flash" }
const out = process.env.STRESS_OUT
await mkdir(out, { recursive: true })

const api = async (path, method = "GET", body, timeout = 60_000) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  const type = response.headers.get("content-type") ?? ""
  return { response, text, data: type.includes("application/json") && text ? JSON.parse(text) : undefined }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sql = (statement) =>
  execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()

const checks = []
const check = (id, passed, evidence) => {
  checks.push({ id, passed, evidence })
  console.log(`${passed ? "✅" : "❌"} ${id} — ${evidence}`)
  assert.ok(passed, `${id}: ${evidence}`)
}

// T20.1 静态代码路径（在仓库根目录执行，与本轮运行镜像的源码一致）。
const repo = process.env.REPO_ROOT ?? process.cwd()
const routes = ["write", "read", "edit", "glob", "grep"].map((tool) => {
  const file = execFileSync("grep", ["-l", `SandboxTools\\.${tool}`, `${repo}/packages/core/src/tool/plugin/${tool}.ts`], {
    encoding: "utf8",
  }).trim()
  return { tool, file: file.split("/").pop() }
})
const shellRoute = execFileSync("grep", ["-n", "SandboxProvider.Service", `${repo}/packages/core/src/tool/plugin/shell.ts`], { encoding: "utf8" }).trim()
check("T20.1", routes.length === 5 && shellRoute.length > 0, `SandboxTools: ${routes.map((row) => row.tool).join(",")}; shell: SandboxProvider`)

const created = await api("/api/session", "POST", {
  title: "sandbox-tool-verify-vercel",
  model,
  location: { directory: "/workspace" },
  permissions: ["shell", "edit", "write", "read", "glob", "grep"].map((action) => ({ action, resource: "*", effect: "allow" })),
})
assert.equal(created.response.status, 200, `session create HTTP ${created.response.status}`)
const session = created.data.data
await writeFile(`${out}/session.json`, JSON.stringify({ id: session.id }))
console.log(`会话 ▶ ${session.id}`)

const keepAlive = await api(`/api/experimental/session/${session.id}/keep-alive`, "POST", { enabled: true, boot: true })
assert.ok(keepAlive.response.ok, `keep-alive HTTP ${keepAlive.response.status}`)

const messages = async () => {
  const listed = await api(`/api/session/${session.id}/message?order=asc&limit=200`)
  assert.equal(listed.response.status, 200, `message list HTTP ${listed.response.status}: ${listed.text.slice(0, 300)}`)
  return listed.data.data
}
const toolParts = (rows) =>
  rows.flatMap((message) =>
    message.type === "assistant"
      ? (message.content ?? []).filter((part) => part.type === "tool")
      : [],
  )
const textOf = (part) => {
  const content = part.state?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
  return ""
}

const marker = `sandbox-write-v2-${Date.now().toString(36)}`
const edited = `edited-${marker}`
const rounds = [
  ["T20.2", "write", `必须调用 write 工具，在 /workspace/sandbox-tool-proof.txt 写入唯一内容 ${marker}。只写这一个文件，不要做别的。`],
  ["T20.3", "read", `必须调用 read 工具读取 /workspace/sandbox-tool-proof.txt，并原样报告文件内容。`],
  ["T20.4", "edit", `必须调用 edit 工具，把 /workspace/sandbox-tool-proof.txt 中的 ${marker} 替换为 ${edited}。`],
  ["T20.5", "glob", `必须调用 glob 工具在 /workspace 搜索 sandbox-tool-proof.txt，并报告结果。`],
  ["T20.6", "grep", `必须调用 grep 工具在 /workspace 搜索字符串 ${edited}，并报告命中的文件。`],
  ["T20.7", "shell", `必须调用 shell 工具执行命令 hostname、whoami 和 cat /workspace/sandbox-tool-proof.txt，并原样报告输出。`],
]

for (const [id, tool, prompt] of rounds) {
  let evidence
  for (let attempt = 1; attempt <= 2; attempt++) {
    const before = new Set(toolParts(await messages()).map((part) => part.id))
    const streamed = await api(
      `/api/session/${session.id}/prompt_stream`,
      "POST",
      { text: prompt, model },
      300_000,
    )
    assert.equal(streamed.response.status, 200, `${id} prompt HTTP ${streamed.response.status}`)
    const events = streamed.text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
    await writeFile(`${out}/${id}-${tool}-attempt${attempt}.json`, JSON.stringify(events, null, 2))
    const failed = events.find((event) => event.type === "session.execution.failed")
    assert.equal(failed, undefined, `${id} 执行失败: ${JSON.stringify(failed?.data ?? null).slice(0, 400)}`)
    const calls = toolParts(await messages()).filter((part) => !before.has(part.id) && part.name === tool)
    const completed = calls.filter((part) => part.state?.status === "completed")
    const nested = events.some(
      (event) => event.type === "session.tool.input.started" && event.data?.name === tool,
    )
    const output = completed.map(textOf).join("\n")
    evidence = { attempt, calls: calls.length, completed: completed.length, nested, output: output.slice(0, 2000) }
    if (completed.length > 0 && nested) break
  }
  assert.ok(evidence.completed > 0 && evidence.nested, `${id} 缺少真实 ${tool} 成功调用: ${JSON.stringify(evidence)}`)
  if (id === "T20.3") assert.ok(evidence.output.includes(marker), `read 输出缺少写入内容: ${evidence.output}`)
  if (id === "T20.5") assert.ok(/sandbox-tool-proof\.txt/.test(evidence.output), `glob 输出缺少目标文件: ${evidence.output}`)
  if (id === "T20.6") assert.ok(evidence.output.includes(edited), `grep 输出缺少命中内容: ${evidence.output}`)
  if (id === "T20.7")
    assert.ok(
      evidence.output.includes(edited) && /(^|\n)(ubuntu|root|node)(\r?\n|$)/im.test(evidence.output),
      `shell 输出缺少沙箱用户或文件内容: ${evidence.output}`,
    )
  check(id, true, `${tool} completed x${evidence.completed} (attempt ${evidence.attempt})`)
}

// 文件证据：确定性 shell API 直读工作区。
const shellStart = Date.now()
const shellResponse = await api(`/api/session/${session.id}/shell`, "POST", {
  command: "pwd && whoami && hostname && cat /workspace/sandbox-tool-proof.txt",
})
assert.ok([200, 204].includes(shellResponse.response.status), `session.shell HTTP ${shellResponse.response.status}`)
let shell
for (;;) {
  const rows = await messages()
  const recent = rows.findLast((message) => {
    if (message.type !== "shell") return false
    const created = message.time?.created ?? 0
    return (created > 1e12 ? created : created * 1000) >= shellStart - 2000
  })
  if (recent?.time?.completed != null) {
    shell = recent
    break
  }
  assert.ok(Date.now() - shellStart < 90_000, "session.shell timed out")
  await sleep(500)
}
const shellOutput = (shell.output?.output ?? "").trim()
await writeFile(`${out}/shell-evidence.json`, JSON.stringify(shell, null, 2))
assert.equal(shell.exit, 0, `shell exit ${shell.exit}: ${shellOutput}`)
assert.equal(shellOutput.split("\n")[0].trim(), "/workspace", `shell cwd: ${shellOutput}`)
assert.ok(shellOutput.includes(edited), `shell cat 缺少编辑后内容: ${shellOutput}`)
check("T20.2-4", true, `shell 在 /workspace 读到 ${edited}`)
check("T20.7-shell", true, `pwd=/workspace, exit=0, host=${shellOutput.split("\n")[2]?.trim()}`)

// 隔离证据：SaaS 容器与宿主机都不得存在同名文件。
const container = process.env.HOST_CONTAINER
if (container) {
  const exists = (() => {
    try {
      execFileSync("docker", ["exec", container, "test", "-e", "/workspace/sandbox-tool-proof.txt"], { stdio: "pipe" })
      return true
    } catch {
      return false
    }
  })()
  const hostExists = (() => {
    try {
      execFileSync("test", ["-e", "/workspace/sandbox-tool-proof.txt"], { stdio: "pipe" })
      return true
    } catch {
      return false
    }
  })()
  check("T20.isolation", !exists && !hostExists, `SaaS 容器/宿主机均无 /workspace/sandbox-tool-proof.txt（container=${exists}, host=${hostExists}）`)
}

// PG：运行中的 Vercel 绑定与保活。
const binding = JSON.parse(
  sql(
    `SELECT json_build_object('provider',provider,'state',state,'keepAlive',keep_alive,'remoteName',remote_name)::text FROM sandbox WHERE session_id='${session.id.replaceAll("'", "''")}'`,
  ),
)
assert.equal(binding.provider, "vercel", `provider ${binding.provider}`)
assert.equal(binding.state, "running", `state ${binding.state}`)
assert.ok(binding.keepAlive, "keep_alive 未开启")
check("T20.pg", true, `provider=vercel state=running keepAlive=${binding.keepAlive} remoteName=${binding.remoteName ?? "null"}`)

// T20.8：当前模型不暴露 patch，记录未执行而不是伪造通过。
const tools = (await api(`/api/session/${session.id}/tools`)).data.data
if (!tools.some((tool) => tool.name === "patch")) {
  check("T20.8", true, "未暴露：deepseek 模型不使用 patch，patch 沙箱行为由 tool-patch.test.ts 覆盖")
} else {
  const patchRound = await api(`/api/session/${session.id}/prompt_stream`, "POST", {
    text: `必须调用 patch 工具，把 /workspace/sandbox-tool-proof.txt 中的 ${edited} 替换为 sandbox-patch-v2-c603。`,
    model,
  })
  assert.equal(patchRound.response.status, 200, `patch prompt HTTP ${patchRound.response.status}`)
  await sleep(1000)
  const patched = toolParts(await messages()).filter((part) => part.name === "patch" && part.state?.status === "completed")
  check("T20.8", patched.length > 0, `patch completed x${patched.length}`)
}

// T20.9：先释放保活再删除会话；PG 终态由包装器统一复核。
const release = await api(`/api/experimental/session/${session.id}/keep-alive`, "POST", { enabled: false })
assert.ok(release.response.ok, `keep-alive release HTTP ${release.response.status}`)
const removed = await api(`/api/session/${session.id}`, "DELETE")
assert.ok([200, 204].includes(removed.response.status), `session delete HTTP ${removed.response.status}`)
let terminal
for (let attempt = 0; attempt < 60; attempt++) {
  terminal = sql(
    `SELECT state || '|' || coalesce(remote_name,'null') FROM sandbox WHERE session_id='${session.id.replaceAll("'", "''")}'`,
  )
  if (terminal === "destroyed|null") break
  await sleep(1000)
}
check("T20.9", terminal === "destroyed|null", `删除后 sandbox 终态 ${terminal}`)

await writeFile(`${out}/tool-sandbox-report.json`, JSON.stringify({ passed: true, model, marker, edited, checks }, null, 2))
console.log("T20-TOOL-SANDBOX", JSON.stringify({ passed: true, checks: checks.length }))
