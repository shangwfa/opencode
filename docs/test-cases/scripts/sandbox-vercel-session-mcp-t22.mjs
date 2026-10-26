// Session MCP (T22.x) acceptance on the Vercel sandbox backend.
// Stages:
//   A: CRUD contract, validation, disabled persistence, PG (T22.1-T22.12, T22.16, T22.30)
//   B: local MCP E2E, env, shell safety, pid lifecycle, multi-port, disabled toggle,
//      codemode:false routing, bridge self-heal (T22.14/17/18/19/26/27/29/31)
//   C: remote MCP E2E and multi-round reuse (T22.13/T22.15)
//   D: container restart sweep and child-session sharing (T22.21/32/25)
// Run through sandbox-vercel-t19.mjs. C expects a streamable-HTTP MCP on
// host.docker.internal:9105. D expects RESTART_CONTAINER.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"

const stage = process.env.MCP_T22_STAGE ?? "A"
const base = process.env.BASE.replace(/\/$/, "")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
}
const model = { providerID: "deepseek", id: "deepseek-flash" }
const out = process.env.STRESS_OUT
await mkdir(out, { recursive: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sql = (statement) =>
  execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()
const api = async (path, method = "GET", body, timeout = 60_000, target = base) => {
  const response = await fetch(`${target}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  const type = response.headers.get("content-type") ?? ""
  return { response, text, data: type.includes("application/json") && text ? JSON.parse(text) : undefined }
}
const checks = []
const check = (id, passed, evidence = "") => {
  checks.push({ id, passed, evidence })
  console.log(`${passed ? "✅" : "❌"} ${id}${evidence ? ` — ${evidence}` : ""}`)
  assert.ok(passed, `${id}: ${evidence}`)
}
const definition = (sessionID, name) =>
  sql(`SELECT config::text FROM session_mcps WHERE session_id='${sessionID.replaceAll("'", "''")}' AND name='${name}'`)
const createSession = async (title) => {
  const created = await api("/api/session", "POST", { title, model, location: { directory: "/workspace" } })
  assert.equal(created.response.status, 200, `session create HTTP ${created.response.status}`)
  return created.data.data.id
}
const boot = async (sessionID) => {
  const result = await api(`/api/experimental/session/${sessionID}/keep-alive`, "POST", { enabled: true, boot: true }, 300_000)
  assert.equal(result.response.status, 200, `keep-alive HTTP ${result.response.status}`)
}
const messages = async (sessionID) => {
  const listed = await api(`/api/session/${sessionID}/message?order=asc&limit=200`)
  assert.equal(listed.response.status, 200, `message list HTTP ${listed.response.status}`)
  return listed.data.data
}
const toolParts = (rows) =>
  rows.flatMap((message) =>
    message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool") : [],
  )
const runShell = async (sessionID, command, timeout = 120_000) => {
  const started = Date.now()
  const sent = await api(`/api/session/${sessionID}/shell`, "POST", { command }, timeout)
  assert.ok([200, 204].includes(sent.response.status), `shell HTTP ${sent.response.status}`)
  for (;;) {
    const rows = await messages(sessionID)
    const recent = rows.findLast((message) => {
      if (message.type !== "shell") return false
      const created = message.time?.created ?? 0
      return (created > 1e12 ? created : created * 1000) >= started - 2000
    })
    if (recent?.time?.completed != null) return { exit: recent.exit, output: recent.output?.output ?? "" }
    assert.ok(Date.now() - started < timeout, `shell timed out: ${command.slice(0, 80)}`)
    await sleep(1000)
  }
}
const runPrompt = async (sessionID, text, target = base) => {
  const before = new Set(toolParts(await messages(sessionID)).map((part) => part.id))
  const streamed = await api(`/api/session/${sessionID}/prompt_stream`, "POST", { text, model }, 300_000, target)
  assert.equal(streamed.response.status, 200, `prompt HTTP ${streamed.response.status}`)
  const events = streamed.text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
  const calls = toolParts(await messages(sessionID)).filter((part) => !before.has(part.id))
  const answer = events.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join("\n")
  return { events, calls, answer, failed: events.find((event) => event.type === "session.execution.failed") }
}
const nestedCalls = (result) => result.calls.flatMap((part) => part.state?.metadata?.toolCalls ?? [])
const assertEcho = (result, server, marker) => {
  assert.equal(result.failed, undefined, `execution failed: ${JSON.stringify(result.failed?.data ?? null).slice(0, 300)}`)
  const calls = nestedCalls(result)
  assert.ok(calls.some((call) => call.tool === `${server}.echo` && call.status === "completed" && call.input?.message === marker),
    `缺少真实 ${server}.echo completed(${marker}): ${JSON.stringify(calls).slice(0, 500)}`)
  assert.ok(!calls.some((call) => call.status === "error"), `本轮包含 MCP 调用错误: ${JSON.stringify(calls).slice(0, 500)}`)
}
const ensurePid = async (sessionID, name) => {
  const pattern = `/tmp/opencode-mcp/${name}-*.pid`
  const result = await runShell(
    sessionID,
    `for i in $(seq 1 60); do f=$(ls ${pattern} 2>/dev/null | head -1); if [ -n "$f" ]; then echo "$f $(cat "$f")"; exit 0; fi; sleep 1; done; echo MISSING`,
  )
  const line = result.output.trim()
  if (line === "MISSING") return { pid: "MISSING", file: "", port: 0 }
  const [file, pid] = line.split(" ")
  return { pid, file, port: Number(file.match(/-(\d+)\.pid$/)?.[1] ?? 0) }
}
const alive = async (sessionID, pid) => {
  const result = await runShell(sessionID, `kill -0 ${pid} 2>/dev/null && echo ALIVE || echo DEAD`)
  return result.output.includes("ALIVE")
}

const sessionID = await createSession(`session-mcp-t22-${stage}`)
await writeFile(`${out}/session-${stage}.json`, JSON.stringify({ id: sessionID, stage }))
console.log(`会话 ▶ ${sessionID} (stage ${stage})`)
let completed = false

try {
  if (stage === "A") {
    const created = await api(`/api/session/${sessionID}/mcps`, "POST", {
      name: "sandbox-shadcn",
      config: { type: "local", command: ["npx", "shadcn@latest", "mcp"], environment: { NODE_ENV: "production" } },
    })
    check("T22.1 local create", created.response.status === 200 && created.data.config.type === "local" && created.data.config.command.length === 3 && Boolean(definition(sessionID, "sandbox-shadcn")), created.response.status)
    const remote = await api(`/api/session/${sessionID}/mcps`, "POST", {
      name: "search-api",
      config: { type: "remote", url: "https://search.example.com/mcp", headers: { Authorization: "Bearer t" }, oauth: false },
    })
    check("T22.2 remote create", remote.response.status === 200 && remote.data.config.oauth === false && JSON.parse(definition(sessionID, "search-api")).url === "https://search.example.com/mcp", remote.response.status)
    // T22.3
    const both = await api(`/api/session/${sessionID}/mcps`, "POST", { name: "mcp-a", config: { type: "local", command: ["echo"] } })
    const listed = await api(`/api/session/${sessionID}/mcps`)
    check("T22.3 list", both.response.status === 200 && listed.data.data.length === 3, `count=${listed.data.data.length}`)
    // T22.4 upsert replaces the config and bumps time_updated
    const before = JSON.parse(sql(`SELECT json_build_object('created',time_created,'updated',time_updated)::text FROM session_mcps WHERE session_id='${sessionID}' AND name='search-api'`))
    await sleep(5)
    const replaced = await api(`/api/session/${sessionID}/mcps`, "POST", { name: "search-api", config: { type: "local", command: ["echo", "v2"] } })
    const after = JSON.parse(sql(`SELECT json_build_object('created',time_created,'updated',time_updated)::text FROM session_mcps WHERE session_id='${sessionID}' AND name='search-api'`))
    check("T22.4 upsert", replaced.response.status === 200 && replaced.data.config.type === "local" && after.created === before.created && after.updated > before.updated, `${before.updated} -> ${after.updated}`)
    // T22.5 delete
    const removed = await api(`/api/session/${sessionID}/mcps/mcp-a`, "DELETE")
    check("T22.5 delete", removed.response.status === 204 && definition(sessionID, "mcp-a") === "", `HTTP ${removed.response.status}`)
    // T22.6 clear
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "m1", config: { type: "local", command: ["echo"] } })
    const cleared = await api(`/api/session/${sessionID}/mcps`, "DELETE")
    check("T22.6 clear", cleared.response.status === 204 && (await api(`/api/session/${sessionID}/mcps`)).data.data.length === 0)
    // T22.7 isolation
    const other = await createSession("session-mcp-t22-A-other")
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "shared", config: { type: "local", command: ["echo", "a"] } })
    await api(`/api/session/${other}/mcps`, "POST", { name: "shared", config: { type: "remote", url: "https://b.example.com/mcp", oauth: false } })
    const aList = (await api(`/api/session/${sessionID}/mcps`)).data.data
    const bList = (await api(`/api/session/${other}/mcps`)).data.data
    check("T22.7 isolation", aList[0].config.type === "local" && bList[0].config.type === "remote" && sql(`SELECT count(*) FROM session_mcps WHERE name='shared' AND session_id IN ('${sessionID}','${other}')`) === "2")
    // T22.10 / T22.16 / T22.18 validation
    const invalid = [
      { config: { type: "local", command: ["echo"] } },
      { name: "no-config" },
      { name: "bad-type", config: { type: "invalid" } },
      { name: "bad;touch /tmp/pwned;#", config: { type: "local", command: ["echo"] } },
      { name: "bad-local-1", config: { type: "local" } },
      { name: "bad-local-2", config: { type: "local", command: [] } },
      { name: "bad-remote-1", config: { type: "remote", oauth: false } },
      { name: "bad-remote-2", config: { type: "remote", url: "https://x.example.com/mcp" } },
    ]
    for (const body of invalid) {
      const result = await api(`/api/session/${sessionID}/mcps`, "POST", body)
      assert.equal(result.response.status, 400, `invalid payload ${JSON.stringify(body).slice(0, 80)} -> ${result.response.status}`)
    }
    check("T22.10/16/18 validation", sql(`SELECT count(*) FROM session_mcps WHERE session_id='${sessionID}' AND name LIKE 'bad%'`) === "0", `${invalid.length} rejected`)
    // T22.11 full remote fields
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "full-mcp", config: { type: "remote", url: "https://full.example.com/mcp", headers: { "x-token": "tok123", "x-extra": "extra456" }, oauth: false } })
    const full = JSON.parse(definition(sessionID, "full-mcp"))
    check("T22.11 remote fields", full.headers["x-token"] === "tok123" && full.headers["x-extra"] === "extra456")
    // T22.12 disabled
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "off-mcp", config: { type: "local", command: ["silent"], disabled: true } })
    check("T22.12 disabled persists", JSON.parse(definition(sessionID, "off-mcp")).disabled === true)
    // T22.30 name boundary
    const name64 = "n".repeat(64)
    const ok64 = await api(`/api/session/${sessionID}/mcps`, "POST", { name: name64, config: { type: "local", command: ["echo"] } })
    const bad65 = await api(`/api/session/${sessionID}/mcps`, "POST", { name: "n".repeat(65), config: { type: "local", command: ["echo"] } })
    check("T22.30 name boundary", ok64.response.status === 200 && bad65.response.status === 400, `${ok64.response.status}/${bad65.response.status}`)
    await api(`/api/session/${sessionID}/mcps/${name64}`, "DELETE")
    const recreated = await api(`/api/session/${sessionID}/mcps`, "POST", { name: name64, config: { type: "local", command: ["echo", "recreated"] } })
    check("T22.30 remove and recreate", recreated.response.status === 200 && JSON.parse(definition(sessionID, name64)).command[1] === "recreated")
    // T22.9 missing session
    for (const [method, path] of [["POST", "/api/session/ses_NOTEXIST/mcps"], ["GET", "/api/session/ses_NOTEXIST/mcps"], ["DELETE", "/api/session/ses_NOTEXIST/mcps"]]) {
      const result = await api(path, method, method === "POST" ? { name: "x", config: { type: "local", command: ["echo"] } } : undefined)
      assert.equal(result.response.status, 404, `${method} ${path} -> ${result.response.status}`)
    }
    check("T22.9 missing session 404", true)
    // Wait for the sandbox to finish creating before delete (409 otherwise), then T22.8 cascade.
    for (let attempt = 0; attempt < 60 && sql(`SELECT count(*) FROM sandbox WHERE session_id='${sessionID}' AND state='creating'`) !== "0"; attempt++) {
      const sandbox = await api(`/api/session/${sessionID}/sandbox`)
      if (sandbox.data?.sandboxId) break
      await sleep(2000)
    }
    const removedOther = await api(`/api/session/${other}`, "DELETE")
    assert.ok([204, 200].includes(removedOther.response.status), `delete other HTTP ${removedOther.response.status}`)
    const removedSession = await api(`/api/session/${sessionID}`, "DELETE")
    assert.ok([204, 200].includes(removedSession.response.status), `delete session HTTP ${removedSession.response.status}`)
    check("T22.8 cascade", sql(`SELECT count(*) FROM session_mcps WHERE session_id IN ('${sessionID}','${other}')`) === "0")
    const afterDelete = await api(`/api/session/${sessionID}/mcps`)
    check("T22.8 list after delete 404", afterDelete.response.status === 404, `HTTP ${afterDelete.response.status}`)
  }

  if (["B", "C", "D", "E", "F"].includes(stage)) await boot(sessionID)
  if (["B", "D", "E"].includes(stage)) {
    const installed = await runShell(sessionID, "sudo npm install -g @modelcontextprotocol/server-everything >/tmp/npm-mcp.log 2>&1; command -v mcp-server-everything || tail -3 /tmp/npm-mcp.log", 300_000)
    check("B.setup server-everything installed", installed.exit === 0 && installed.output.trim().length > 0, installed.output.trim().slice(-120))
  }

  if (stage === "B") {
    const local = (name, extra = {}) => api(`/api/session/${sessionID}/mcps`, "POST", { name, config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"], ...extra } })
    // T22.14 local E2E + reuse
    const defined = await local("sandbox-everything")
    check("T22.14 define local", defined.response.status === 200)
    const first = await runPrompt(sessionID, "请实际调用 sandbox-everything 的 echo 工具，message 为 'hello-sandbox-mcp'，然后把工具返回内容原样回复。")
    assertEcho(first, "sandbox-everything", "hello-sandbox-mcp")
    assert.equal(first.failed, undefined, `execution failed: ${JSON.stringify(first.failed?.data ?? null).slice(0, 300)}`)
    const pid1 = await ensurePid(sessionID, "sandbox-everything")
    check("T22.14 local echo", JSON.stringify(first.calls).includes("hello-sandbox-mcp") && nestedCalls(first).some((call) => /echo/i.test(call.tool ?? "")), `pid=${pid1.pid}`)
    const second = await runPrompt(sessionID, "再次调用 sandbox-everything 的 echo 工具，message 为 'hello-again'，原样回复。")
    assertEcho(second, "sandbox-everything", "hello-again")
    const pid2 = await ensurePid(sessionID, "sandbox-everything")
    check("T22.14 connection reuse", JSON.stringify(second.calls).includes("hello-again") && pid1.pid === pid2.pid && pid1.pid !== "MISSING", `${pid1.pid} -> ${pid2.pid}`)

    // T22.17 environment injection
    await local("env-everything", {
      command: ["sh", "-lc", 'printf "$MCP_ENV_TEST" >/tmp/mcp-env-test && npx -y @modelcontextprotocol/server-everything'],
      environment: { MCP_ENV_TEST: "hello-env-value" },
    })
    const envRun = await runPrompt(sessionID, "请实际调用 env-everything 的 echo 工具，message 为 'env-marker'，原样回复。")
    assertEcho(envRun, "env-everything", "env-marker")
    const envRead = await runShell(sessionID, "cat /tmp/mcp-env-test 2>/dev/null || echo MISSING")
    check("T22.17 environment injection", envRead.output.includes("hello-env-value") && JSON.stringify(envRun.calls).includes("env-marker"), envRead.output.trim())

    // T22.18 malicious env key is quoted; malicious name already rejected in A
    await local("safe_name", {
      command: ["sh", "-lc", "printf safe >/tmp/mcp-safe-marker && npx -y @modelcontextprotocol/server-everything"],
      environment: { SAFE_VALUE: "a b c ' quote", "BAD-ENV;touch /tmp/mcp-env-pwned": "x" },
    })
    const safeRun = await runPrompt(sessionID, "请实际调用 safe_name 的 echo 工具，message 为 'safe-marker'，原样回复。")
    assertEcho(safeRun, "safe_name", "safe-marker")
    const safe = await runShell(sessionID, "test -f /tmp/mcp-safe-marker && echo SAFE_MARKER; test -f /tmp/mcp-env-pwned && echo ENV_PWNED; test -f /tmp/mcp-name-pwned && echo NAME_PWNED")
    check("T22.18 shell safety", safe.output.includes("SAFE_MARKER") && !safe.output.includes("ENV_PWNED") && !safe.output.includes("NAME_PWNED") && JSON.stringify(safeRun.calls).includes("safe-marker"), safe.output.trim())

    // T22.26 two local MCPs on consecutive ports
    await local("mcp-a")
    await local("mcp-b")
    const both = await runPrompt(sessionID, "请实际分别调用 mcp-a 和 mcp-b 的 echo 工具，message 分别为 'a-one' 和 'b-one'，然后原样回复两个结果。")
    assertEcho(both, "mcp-a", "a-one")
    assertEcho(both, "mcp-b", "b-one")
    const pidA = await ensurePid(sessionID, "mcp-a")
    const pidB = await ensurePid(sessionID, "mcp-b")
    check(
      "T22.26 two ports",
      pidA.pid !== "MISSING" && pidB.pid !== "MISSING" && pidA.pid !== pidB.pid && pidB.port === pidA.port + 1
        && JSON.stringify(both.calls).includes("a-one") && JSON.stringify(both.calls).includes("b-one"),
      `${pidA.port}/${pidB.port}`,
    )
    const removedA = await api(`/api/session/${sessionID}/mcps/mcp-a`, "DELETE")
    const bAfterA = await runPrompt(sessionID, "请实际调用 mcp-b 的 echo 工具，message 为 'b-after-a'，原样回复。")
    assertEcho(bAfterA, "mcp-b", "b-after-a")
    const aFiles = await runShell(sessionID, "ls /tmp/opencode-mcp/mcp-a-*.pid /tmp/opencode-mcp/mcp-a-*.log 2>/dev/null || echo FILES_GONE")
    check("T22.26 remove keeps sibling", removedA.response.status === 204 && aFiles.output.includes("FILES_GONE") && JSON.stringify(bAfterA.calls).includes("b-after-a"), aFiles.output.trim())
    await local("mcp-c")
    const cRun = await runPrompt(sessionID, "请实际调用 mcp-c 的 echo 工具，message 为 'c-one'，原样回复。")
    assertEcho(cRun, "mcp-c", "c-one")
    const pidC = await ensurePid(sessionID, "mcp-c")
    check("T22.26 port reuse", pidC.pid !== "MISSING" && pidC.port === pidA.port && JSON.stringify(cRun.calls).includes("c-one"), `${pidA.port} -> ${pidC.port}`)

    // T22.27 disabled toggle
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "off-mcp", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"], disabled: true } })
    await runPrompt(sessionID, "只回复 ok")
    const offPid = await runShell(sessionID, "ls /tmp/opencode-mcp/off-mcp-*.pid 2>/dev/null || echo NO_FILE")
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "off-mcp", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"], disabled: false } })
    const onRun = await runPrompt(sessionID, "请实际调用 off-mcp 的 echo 工具，message 为 'on-marker'，原样回复。")
    assertEcho(onRun, "off-mcp", "on-marker")
    check("T22.27 disabled toggle", offPid.output.includes("NO_FILE") && JSON.stringify(onRun.calls).includes("on-marker"), offPid.output.trim())
    const enabledPid = await ensurePid(sessionID, "off-mcp")
    await local("off-mcp", { disabled: true })
    await runPrompt(sessionID, "只回复 ok")
    const disabledAgain = await runShell(sessionID, `test ! -e ${enabledPid.file} && echo NO_FILE; kill -0 ${enabledPid.pid} 2>/dev/null && echo ALIVE || echo DEAD`)
    check("T22.27 enabled to disabled stops bridge", disabledAgain.output.includes("NO_FILE") && disabledAgain.output.includes("DEAD"), disabledAgain.output.trim())

    // T22.29 codemode:false exposes a direct tool (no execute wrapper)
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "cm-off", config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"], codemode: false } })
    const direct = await runPrompt(sessionID, "请实际调用 cm-off 的 echo 工具，message 为 'path-verify'，原样回复。")
    const directPart = direct.calls.find((part) => /cm-off.*echo|cm_off.*echo/i.test(part.name ?? ""))
    check("T22.29 codemode:false direct", Boolean(directPart) && directPart.state?.status === "completed" && !direct.calls.some((part) => part.name === "execute"), directPart?.name ?? "missing")

    // T22.19 pid/log lifecycle
    const beforeDelete = await ensurePid(sessionID, "cm-off")
    const removed = await api(`/api/session/${sessionID}/mcps/cm-off`, "DELETE")
    const gone = await runShell(sessionID, `ls /tmp/opencode-mcp/cm-off-*.pid /tmp/opencode-mcp/cm-off-*.log 2>/dev/null || echo FILES_GONE; kill -0 ${beforeDelete.pid} 2>/dev/null && echo PROC_ALIVE || echo PROC_GONE`)
    check("T22.19 pid/log cleanup", removed.response.status === 204 && gone.output.includes("FILES_GONE") && gone.output.includes("PROC_GONE"), gone.output.trim())

    // T22.31 bridge self-heal: kill the bridge, the next call must reconnect once
    const healPid = await ensurePid(sessionID, "sandbox-everything")
    const killed = await runShell(sessionID, `kill -9 ${healPid.pid} 2>/dev/null; echo killed`)
    const healed = await runPrompt(sessionID, "请实际调用 sandbox-everything 的 echo 工具，message 为 'after-kill'，原样回复。")
    assertEcho(healed, "sandbox-everything", "after-kill")
    const newPid = await ensurePid(sessionID, "sandbox-everything")
    check("T22.31 bridge self-heal", killed.output.includes("killed") && JSON.stringify(healed.calls).includes("after-kill") && newPid.pid !== healPid.pid && newPid.pid !== "MISSING", `${healPid.pid} -> ${newPid.pid}`)
  }

  if (stage === "C") {
    const remote = await api(`/api/session/${sessionID}/mcps`, "POST", {
      name: "persist-tools",
      config: { type: "remote", url: process.env.MCP_REMOTE_URL ?? "http://host.docker.internal:9105/mcp", oauth: false,
        ...(process.env.MCP_REMOTE_MARKER ? { headers: { "x-mcp-test": process.env.MCP_REMOTE_MARKER } } : {}) },
    })
    check("T22.13 define remote", remote.response.status === 200, remote.response.status)
    const first = await runPrompt(sessionID, "请实际调用 persist-tools 的 echo 工具，message 为 'round-1'，原样回复。")
    assertEcho(first, "persist-tools", "round-1")
    const middle = await runPrompt(sessionID, "请实际调用 persist-tools 的 echo 工具，message 为 'round-2'，原样回复。")
    assertEcho(middle, "persist-tools", "round-2")
    const second = await runPrompt(sessionID, "请再次使用刚才那个 persist-tools 的 echo 工具，message 为 'round-3'，原样回复。")
    assertEcho(second, "persist-tools", "round-3")
    const nested = nestedCalls(first).concat(nestedCalls(second))
    check("T22.13 remote echo", JSON.stringify(first.calls).includes("round-1"), JSON.stringify(nested).slice(0, 200))
    check("T22.15 multi-round reuse", JSON.stringify(second.calls).includes("round-3") && nested.filter((call) => /echo/i.test(call.tool ?? "")).length >= 2, `${nested.length} nested calls`)
  }

  if (stage === "D") {
    const local = (name) => api(`/api/session/${sessionID}/mcps`, "POST", { name, config: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] } })
    await local("sweep-a")
    await local("sweep-b")
    const before = await runPrompt(sessionID, "请实际分别调用 sweep-a 和 sweep-b 的 echo 工具，message 分别为 'a-1' 和 'b-1'，原样回复。")
    assertEcho(before, "sweep-a", "a-1")
    assertEcho(before, "sweep-b", "b-1")
    const pidA = await ensurePid(sessionID, "sweep-a")
    const pidB = await ensurePid(sessionID, "sweep-b")
    check("T22.32 pre-restart", JSON.stringify(before.calls).includes("a-1") && JSON.stringify(before.calls).includes("b-1"), `${pidA.pid}/${pidB.pid}`)
    execFileSync("docker", ["restart", process.env.RESTART_CONTAINER], { stdio: "ignore" })
    for (let attempt = 0; attempt < 90; attempt++) {
      const ready = await fetch(`${base}/api/info`, { headers, signal: AbortSignal.timeout(3000) }).catch(() => undefined)
      if (ready?.ok) break
      await sleep(1000)
    }
    const after = await runPrompt(sessionID, "请实际分别调用 sweep-a 和 sweep-b 的 echo 工具，message 分别为 'a-2' 和 'b-2'，原样回复。")
    assertEcho(after, "sweep-a", "a-2")
    assertEcho(after, "sweep-b", "b-2")
    const newA = await ensurePid(sessionID, "sweep-a")
    const newB = await ensurePid(sessionID, "sweep-b")
    const aliveCount = await runShell(sessionID, "for f in /tmp/opencode-mcp/*.pid; do [ -f \"$f\" ] && { p=$(cat \"$f\"); kill -0 \"$p\" 2>/dev/null && echo \"$p ALIVE\" || echo \"$p DEAD\"; }; done")
    const afterNested = nestedCalls(after).filter((call) => /sweep-[ab]\.echo/.test(call.tool ?? "") && call.status === "completed")
    check("T22.32 restart recovery", afterNested.length >= 2 && JSON.stringify(afterNested).includes("a-2") && JSON.stringify(afterNested).includes("b-2"), `${pidA.pid}/${pidB.pid} -> ${newA.pid}/${newB.pid} (${afterNested.length} real echoes)`)
    check("T22.21 no dead bridge", !aliveCount.output.includes("DEAD") && newA.pid !== "MISSING" && newB.pid !== "MISSING", aliveCount.output.trim().slice(0, 200))
    const obsolete = await runShell(sessionID, `for p in ${pidA.pid} ${pidB.pid}; do case "$p" in ${newA.pid}|${newB.pid}) echo REUSED;; *) kill -0 "$p" 2>/dev/null && echo OLD_ALIVE || echo OLD_DEAD;; esac; done; find /tmp/opencode-mcp -name '*.pid' | wc -l`)
    check("T22.21/32 no obsolete bridge and exactly two pidfiles", !obsolete.output.includes("OLD_ALIVE") && obsolete.output.trim().endsWith("2"), obsolete.output.trim())

    // T22.25 child session shares the owner runtime. Note: fork sessions do NOT
    // share MCP definitions (forkSessionID breaks the owner chain) — the child
    // must be created with parentID.
    const child = await api("/api/session", "POST", { title: "session-mcp-t22-D-child", model, parentID: sessionID })
    assert.equal(child.response.status, 200, `child create HTTP ${child.response.status}`)
    const childID = child.data.data.id
    await writeFile(`${out}/child-${stage}.json`, JSON.stringify({ id: childID }))
    const childRun = await runPrompt(childID, "请实际调用 sweep-a 的 echo 工具，message 为 'round-child'，原样回复。")
    const parentRun = await runPrompt(sessionID, "请实际调用 sweep-a 的 echo 工具，message 为 'round-parent'，原样回复。")
    const sharedPid = await ensurePid(sessionID, "sweep-a")
    const childEcho = nestedCalls(childRun).find((call) => /sweep-a\.echo/.test(call.tool ?? "") && call.status === "completed")
    const parentEcho = nestedCalls(parentRun).find((call) => /sweep-a\.echo/.test(call.tool ?? "") && call.status === "completed")
    check("T22.25 child shares definition", Boolean(childEcho) && JSON.stringify(childEcho?.input ?? {}).includes("round-child"), JSON.stringify(childEcho ?? childRun.answer.slice(0, 150)))
    check("T22.25 parent unaffected", Boolean(parentEcho) && JSON.stringify(parentEcho?.input ?? {}).includes("round-parent") && sharedPid.pid === newA.pid, `${newA.pid} -> ${sharedPid.pid}`)
    const removeChild = await api(`/api/session/${childID}`, "DELETE")
    const afterChild = await runPrompt(sessionID, "请实际调用 sweep-a 的 echo 工具，message 为 'round-after-child'，原样回复。")
    assertEcho(afterChild, "sweep-a", "round-after-child")
    check("T22.25 after child delete", [200, 204].includes(removeChild.response.status) && JSON.stringify(afterChild.calls).includes("round-after-child"), `HTTP ${removeChild.response.status}`)
  }
  if (stage === "F") {
    const second = process.env.BASE_SECONDARY
    assert.ok(second, "F requires BASE_SECONDARY")
    const fixture = await readFile(new URL("./session-mcp-shared-fixture.mjs", import.meta.url), "utf8")
    await runShell(sessionID, `printf %s '${Buffer.from(fixture).toString("base64")}' | base64 -d > /workspace/shared-mcp.mjs`)
    await api(`/api/session/${sessionID}/mcps`, "POST", { name: "shared", config: { type: "local", command: ["node", "/workspace/shared-mcp.mjs"] } })
    assertEcho(await runPrompt(sessionID, "实际调用 shared.echo，message='pod-a'，仅报告真实结果"), "shared", "pod-a")
    const firstPid = await ensurePid(sessionID, "shared")
    const child = (await api("/api/session", "POST", { title: "mcp-multipod-child", model, parentID: sessionID })).data.data.id
    const pending = runPrompt(sessionID, "仅通过 execute 调用一次 shared.slowEcho，message='in-flight'，delayMs=30000。不要使用 shell。", base)
    // The fixture records each call before it starts sleeping, so a record here
    // proves slowEcho is in flight (message metadata does not persist "running").
    const until = Date.now() + 120000
    const inFlight = async () => Number((await runShell(sessionID, "grep -c '\"message\":\"in-flight\"' /workspace/shared-mcp-calls.jsonl 2>/dev/null || echo 0")).output.trim()) > 0
    while (!(await inFlight())) {
      assert.ok(Date.now() < until, "slowEcho did not start")
      await sleep(1500)
    }
    assertEcho(await runPrompt(child, "实际调用 shared.echo，message='pod-b'，仅报告真实结果", second), "shared", "pod-b")
    const slow = await pending
    const call = nestedCalls(slow).find((call) => call.tool === "shared.slowEcho" && call.status === "completed" && call.input?.message === "in-flight")
    check("F cross-Pod discovery does not kill an in-flight tool", Boolean(call) && !nestedCalls(slow).some((call) => call.status === "error"))
    const secondPid = await ensurePid(sessionID, "shared")
    check("F replicas share one healthy bridge", firstPid.pid === secondPid.pid, `${firstPid.pid} -> ${secondPid.pid}`)
    const uncertain = await runPrompt(child, "通过 execute 只调用一次 shared.ambiguous，message='side-effect-once'。它会写入后断开；发生错误后必须直接报告错误，不得再次调用或尝试修复。", second)
    const failedCalls = nestedCalls(uncertain).filter((call) => call.tool === "shared.ambiguous")
    const counts = await runShell(sessionID, "cat /workspace/shared-mcp-calls.jsonl")
    const effects = counts.output.split("\n").filter(Boolean).map((line) => JSON.parse(line))
    check("F ambiguous tool failure is never automatically replayed", failedCalls.length === 1 && failedCalls[0].status === "error" && effects.filter((call) => call.message === "side-effect-once").length === 1)
    assertEcho(await runPrompt(sessionID, "实际调用 shared.echo，message='recovered-once'，只调用一次", base), "shared", "recovered-once")
    check("F dead stdio is recovered before the next dispatch", (await ensurePid(sessionID, "shared")).pid !== firstPid.pid)
    await api(`/api/session/${child}`, "DELETE")
  }
  if (stage === "E") {
    const local = (name, extra = {}) => api(`/api/session/${sessionID}/mcps`, "POST", {
      name, config: { type: "local", command: ["mcp-server-everything"], ...extra },
    })
    await local("drift", { environment: { MCP_REV: "v1" }, command: ["sh", "-c", 'printf %s "$MCP_REV" >/tmp/mcp-rev; exec mcp-server-everything'] })
    assertEcho(await runPrompt(sessionID, "实际调用 drift.echo，message='drift-before'"), "drift", "drift-before")
    const original = await ensurePid(sessionID, "drift")
    const stamp = JSON.parse(sql(`SELECT json_build_object('created',time_created,'updated',time_updated)::text FROM session_mcps WHERE session_id='${sessionID}' AND name='drift'`))
    await local("drift", { environment: { MCP_REV: "v2-drift" }, command: ["sh", "-c", 'printf %s "$MCP_REV" >/tmp/mcp-rev; exec mcp-server-everything'] })
    assertEcho(await runPrompt(sessionID, "实际调用 drift.echo，message='drift-after'"), "drift", "drift-after")
    const changed = await ensurePid(sessionID, "drift")
    const revision = await runShell(sessionID, "cat /tmp/mcp-rev")
    const latest = JSON.parse(sql(`SELECT json_build_object('created',time_created,'updated',time_updated)::text FROM session_mcps WHERE session_id='${sessionID}' AND name='drift'`))
    check("T22.24 config drift replaces process and preserves creation time", original.pid !== changed.pid && !(await alive(sessionID, original.pid)) && revision.output.trim() === "v2-drift" && stamp.created === latest.created && latest.updated > stamp.updated, `${original.pid} -> ${changed.pid}`)
    await api(`/api/session/${sessionID}/mcps`, "DELETE")
    await local("aaa-broken", { command: ["/definitely-no-such-t22-command"] })
    await local("mcp-good")
    const started = Date.now()
    const warmup = await runPrompt(sessionID, "只回复 ok，不执行任何工具")
    check("T22.28 broken server degrades without hanging", !warmup.failed && Date.now() - started < 120000, `首轮 ${Date.now() - started}ms`)
    const good = await runPrompt(sessionID, "请实际调用 mcp-good.echo，message='good-after-broken'，仅报告工具结果")
    assertEcho(good, "mcp-good", "good-after-broken")
    check("T22.28 good server not starved", true)
    await local("aaa-broken")
    assertEcho(await runPrompt(sessionID, "实际调用 aaa-broken.echo，message='fixed-now'"), "aaa-broken", "fixed-now")
    check("T22.28 corrected config invalidates failure backoff", true)
  }
  completed = true
} finally {
  await writeFile(`${out}/t22-${stage}-report.json`, JSON.stringify({ stage, passed: completed, checks }, null, 2))
  await api(`/api/session/${sessionID}`, "DELETE").catch(() => undefined)
}

console.log(`T22-${stage}`, JSON.stringify({ passed: true, checks: checks.length }))
