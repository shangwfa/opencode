import assert from "node:assert/strict"

/** Diagnostic: does the scan recover after a stubbed `find` is removed following a timeout? */

const BASE = (process.env.BASE ?? "http://localhost:14097").replace(/\/$/, "")
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  try {
    return { status: response.status, data: text ? JSON.parse(text) : undefined }
  } catch {
    return { status: response.status, data: text }
  }
}
async function runShell(sessionID, command) {
  const run = await api(`/api/session/${sessionID}/shell`, "POST", { command })
  assert.equal(run.status, 204, `shell POST ${run.status}`)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const messages = await api(`/api/session/${sessionID}/message?order=asc`)
    const items = messages.data?.data ?? messages.data ?? []
    const shell = items.filter((m) => m.type === "shell" && m.command === command).at(-1)
    if (shell && shell.status !== "running") return shell.output?.output ?? shell.output ?? ""
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error("shell timeout")
}
const b64 = (value) => Buffer.from(value, "utf8").toString("base64")

const created = await api("/api/session", "POST", { title: "sandbox-probe", location: { directory: "/workspace" } })
assert.equal(created.status, 200, JSON.stringify(created.data))
const sid = created.data?.data?.id ?? created.data?.id
const definitions = (payload) => payload.data?.data ?? payload.data ?? []
try {
  await runShell(sid, `mkdir -p /workspace/.opencode/agents/probe && printf '---\\nmode: subagent\\n---\\nPROBE\\n' > /workspace/.opencode/agents/probe/plain.md`)
  console.log("baseline discovered:", definitions((await api(`/api/session/${sid}/agents/refresh`, "POST")).data).filter((i) => i.source === "sandbox").map((i) => i.agent.id).join(","))

  const stub = "#!/bin/sh\ncase \"$*\" in\n  *\".opencode/agent\"*) sleep 60 ;;\nesac\nexec /usr/bin/find \"$@\"\n"
  await runShell(sid, `printf '%s' '${b64(stub)}' | base64 -d > /usr/local/bin/find && chmod +x /usr/local/bin/find && command -v find`)
  const hanging = await api(`/api/session/${sid}/agents/refresh`, "POST")
  console.log("hanging refresh:", hanging.status, String(hanging.data?.message ?? "").slice(0, 120))

  // The first non-safe command repairs the stale context but is deliberately
  // not replayed. Execute this idempotent cleanup once more in the new context.
  await runShell(sid, "rm -f /usr/local/bin/find")
  await runShell(sid, "rm -f /usr/local/bin/find && command -v find")
  for (const attempt of [1, 2, 3]) {
    const after = await api(`/api/session/${sid}/agents/refresh`, "POST")
    const ids = after.status === 200 ? definitions(after.data).filter((i) => i.source === "sandbox").map((i) => i.agent.id) : []
    console.log(`recovery attempt ${attempt}: status=${after.status} sandbox=${ids.join(",") || "(none)"} msg=${String(after.data?.message ?? "").slice(0, 100)}`)
    if (ids.some((id) => id.includes("probe/plain"))) break
    await new Promise((r) => setTimeout(r, 3000))
  }
} finally {
  await runShell(sid, "rm -f /usr/local/bin/find").catch(() => {})
  await api(`/api/session/${sid}`, "DELETE")
}
