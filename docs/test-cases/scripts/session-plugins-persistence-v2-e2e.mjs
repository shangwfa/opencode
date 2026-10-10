import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14118").replace(/\/$/, "")
const PASSWORD = process.env.OPENCODE_PASSWORD
const PG_URL = process.env.PG_URL
const IMAGE = process.env.SANDBOX_IMAGE ?? "opencode-opensandbox-session-plugin-verify:local"
const MODEL = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-GLM","modelID":"glm-5.3"}')
const persistModes = (process.env.PERSIST_MODES ?? "pvc,snapshot").split(",").filter(Boolean)
const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
const headers = { "content-type": "application/json", authorization: auth }
assert(PASSWORD && PG_URL, "OPENCODE_PASSWORD and PG_URL are required")

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { response, text, data }
}

function pg(sql) {
  return execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-c", sql], { encoding: "utf8" }).trim()
}

function watch(sessionID, onEvent) {
  const controller = new AbortController()
  let seen = 0
  const task = (async () => {
    const response = await fetch(`${BASE}/api/session/${sessionID}/event`, {
      headers: { authorization: auth, accept: "text/event-stream" }, signal: controller.signal,
    })
    assert.equal(response.status, 200, `Session SSE HTTP ${response.status}`)
    console.log(`[SSE] ${sessionID} connected`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const line = block.split(/\r?\n/).find((value) => value.startsWith("data:"))
        if (!line) continue
        try {
          const event = JSON.parse(line.slice(5).trim())
          seen++
          onEvent(event)
          if (event.type.startsWith("session.execution.")) console.log(`[SSE] ${event.type}`)
          if (event.type === "session.text.delta") process.stdout.write(event.data?.delta ?? "")
          if (event.type === "session.shell.ended") console.log(`[SSE] shell ended: ${event.data?.output?.output ?? ""}`)
        } catch {}
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) throw error })
  return { task, stop: async () => { controller.abort(); await task; return seen } }
}

async function prompt(sessionID, text) {
  const events = []
  const stream = watch(sessionID, (event) => events.push(event))
  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
      method: "POST", headers, body: JSON.stringify({ text }), signal: AbortSignal.timeout(180_000),
    })
    const body = await response.text()
    assert.equal(response.status, 200, body.slice(0, 400))
    const result = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).flatMap((line) => {
      try { return [JSON.parse(line.slice(5).trim())] } catch { return [] }
    })
    assert(result.some((event) => event.type === "session.execution.succeeded"), "prompt did not succeed")
    assert(!result.some((event) => event.type === "session.execution.failed"), "prompt execution failed")
    return result.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join("\n")
  } finally {
    const count = await stream.stop()
    assert(count > 0, "GET Session SSE received no events")
  }
}

async function shell(sessionID, command) {
  let resolveOutput
  let rejectOutput
  const output = new Promise((resolve, reject) => { resolveOutput = resolve; rejectOutput = reject })
  const stream = watch(sessionID, (event) => {
    if (event.type === "session.shell.ended") resolveOutput(event.data?.output?.output ?? "")
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  try {
    const response = await api(`/api/session/${sessionID}/shell`, "POST", { command })
    assert.equal(response.response.status, 204, response.text)
    return await Promise.race([
      output,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`shell timed out: ${command}`)), 90_000)),
    ])
  } catch (error) {
    rejectOutput(error)
    throw error
  } finally {
    const count = await stream.stop()
    assert(count > 0, "GET Session SSE received no shell event")
  }
}

const sessions = []
try {
  for (const persistMode of persistModes) {
    const created = await api("/api/session", "POST", {
      title: `session-plugin-${persistMode}-${Date.now()}`,
      model: { providerID: MODEL.providerID, id: MODEL.id ?? MODEL.modelID },
      location: { directory: "/workspace" },
      sandbox: { cpu: "1", memory: "2Gi", image: IMAGE, persistMode },
    })
    assert.equal(created.response.status, 200, created.text)
    const sessionID = created.data.data.id
    sessions.push(sessionID)
    const hookMarker = `PERSIST_${persistMode.toUpperCase()}_${Date.now()}`
    const pluginCode = `export default async () => ({ "session.prompt": (event) => { event.prompt.text = "Reply exactly ${hookMarker}." } })`
    const plugin = await api(`/api/session/${sessionID}/plugins`, "POST", {
      name: "persist-probe", description: `Plugin survives ${persistMode} sandbox recycle`,
      source: { type: "code", code: pluginCode },
    })
    assert.equal(plugin.response.status, 200, plugin.text)
    const initial = await prompt(sessionID, `Initial ${persistMode} session probe.`)
    assert(initial.includes(hookMarker), `initial hook did not run before recycle: ${initial}`)
    const messagesAfterInitial = await api(`/api/session/${sessionID}/message?order=asc&limit=100`)
    assert.equal(messagesAfterInitial.data.data.findLast((message) => message.type === "user")?.text, `Reply exactly ${hookMarker}.`)
    const fileMarker = `WORKSPACE_${persistMode}_${Date.now()}`
    assert((await shell(sessionID, `printf ${fileMarker} > /workspace/persist-marker.txt && cat /workspace/persist-marker.txt`)).includes(fileMarker))

    let snapshotID
    if (persistMode === "snapshot") {
      const snapshot = await api(`/api/session/${sessionID}/snapshot`, "POST", {})
      assert.equal(snapshot.response.status, 200, snapshot.text)
      snapshotID = snapshot.data.data.snapshotID
      let state = ""
      for (let attempt = 0; attempt < 90; attempt++) {
        const latest = await api(`/api/session/${sessionID}/snapshot`)
        state = latest.data?.data?.state ?? ""
        if (state === "ready" || state === "failed") break
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      assert.equal(state, "ready", `snapshot did not become ready: ${pg(`SELECT state || '|' || coalesce(reason,'') FROM session_snapshot WHERE id='${snapshotID}'`)}`)
      console.log(`PASS ${persistMode} snapshot ready; snapshot=${snapshotID}`)
    }

    const killed = await api(`/api/session/${sessionID}/kill-sandbox`, "POST", {})
    console.log(`${persistMode} kill-sandbox response: ${killed.text}`)
    assert([200, 202].includes(killed.response.status), `kill sandbox HTTP ${killed.response.status}: ${killed.text}`)
    const restored = await shell(sessionID, "cat /workspace/persist-marker.txt")
    assert(restored.includes(fileMarker), `${persistMode} did not preserve workspace across sandbox recycle: ${restored}`)
    console.log(`PASS ${persistMode} workspace survives sandbox recycle`)

    const restoredPlugin = await prompt(sessionID, "PLUGIN_RESTORE_CHECK")
    const messagesAfterRestore = await api(`/api/session/${sessionID}/message?order=asc&limit=100`)
    const latestUserText = messagesAfterRestore.data.data.findLast((message) => message.type === "user")?.text
    console.log(`${persistMode} latest persisted prompt: ${latestUserText}`)
    assert(restoredPlugin.includes(hookMarker), `${persistMode} plugin was not loaded after sandbox recycle: ${restoredPlugin}`)
    assert.equal(latestUserText, `Reply exactly ${hookMarker}.`, `${persistMode} hook did not rewrite the prompt after recycle`)
    assert.equal(pg(`SELECT count(*) FROM session_plugins WHERE session_id='${sessionID}' AND name='persist-probe'`), "1")
    if (snapshotID) {
      const snapshotStates = pg(`SELECT state || '|' || restored_count || '|' || coalesce(reason,'') FROM session_snapshot WHERE session_id='${sessionID}'`)
      assert(snapshotStates.split(/\r?\n/).some((state) => state === "stale|1|restored"),
        `no snapshot was marked consumed/restored (manual request ${snapshotID}): ${snapshotStates}`)
    }
    console.log(`PASS ${persistMode} plugin rehydrated from PG after sandbox recycle; session=${sessionID}`)
  }
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.stack : error}`)
  process.exitCode = 1
} finally {
  for (const sessionID of sessions) {
    let deleted
    for (let attempt = 0; attempt < 5; attempt++) {
      deleted = await api(`/api/session/${sessionID}`, "DELETE").catch(() => undefined)
      if (!deleted || deleted.response.status !== 409) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (deleted && ![200, 204, 404].includes(deleted.response.status))
      console.error(`cleanup warning for ${sessionID}: HTTP ${deleted.response.status}`)
  }
}
