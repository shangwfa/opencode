import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://localhost:14116").replace(/\/$/, "")
const BASE_SECOND = (process.env.BASE_SECOND ?? "").replace(/\/$/, "")
const PASSWORD = process.env.OPENCODE_PASSWORD
const PG_URL = process.env.PG_URL
assert(PASSWORD, "OPENCODE_PASSWORD is required")
assert(PG_URL, "PG_URL is required for the PG assertions")
const MODEL = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}')
const model = { providerID: MODEL.providerID, id: MODEL.id ?? MODEL.modelID }
const auth = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`
const headers = { "content-type": "application/json", authorization: auth }
const timeout = Number(process.env.TIMEOUT_MS ?? 180_000)

async function api(path, method = "GET", body, base = BASE) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { response, text, data }
}

function pg(sql) {
  return execFileSync("psql", [PG_URL, "-X", "-A", "-t", "-c", sql], { encoding: "utf8" }).trim()
}

function startGetSse(sessionID, base = BASE) {
  const controller = new AbortController()
  let seen = 0
  const task = (async () => {
    const response = await fetch(`${base}/api/session/${sessionID}/event`, {
      headers: { authorization: auth, accept: "text/event-stream" },
      signal: controller.signal,
    })
    assert.equal(response.status, 200, `GET session event SSE returned ${response.status}`)
    console.log(`[SSE] GET /api/session/${sessionID}/event 已连接`)
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
        const line = block.split(/\r?\n/).find((item) => item.startsWith("data:"))
        if (!line) continue
        try {
          const event = JSON.parse(line.slice(5).trim())
          seen++
          const data = event.data ?? {}
          if (event.type === "session.text.delta") process.stdout.write(data.delta ?? "")
          else if (event.type.startsWith("session.tool.")) console.log(`\n[SSE] ${event.type}`)
          else if (event.type.startsWith("session.execution.")) console.log(`\n[SSE] ${event.type}`)
          else if (event.type === "session.step.failed") console.log(`\n[SSE] step failed: ${data.error?.message ?? "unknown"}`)
        } catch {}
      }
    }
  })().catch((error) => {
    if (!controller.signal.aborted) throw error
  })
  return {
    task,
    stop: async () => {
      controller.abort()
      await task
      return seen
    },
  }
}

async function runPrompt(sessionID, text, marker, base = BASE) {
  const sse = startGetSse(sessionID, base)
  await new Promise((resolve) => setTimeout(resolve, 250))
  let getSseEvents = 0
  try {
    const response = await fetch(`${base}/api/session/${sessionID}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeout),
    })
    if (response.status !== 200)
      throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
    const body = await response.text()
    const events = body.split(/\r?\n/).filter((line) => line.startsWith("data:")).flatMap((line) => {
      try { return [JSON.parse(line.slice(5).trim())] } catch { return [] }
    })
    const types = events.map((event) => event.type)
    const outputText = events.filter((event) => event.type === "session.text.ended").map((event) => event.data?.text ?? "").join("\n")
    assert(types.includes("session.execution.succeeded"), `prompt_stream did not succeed: ${types.join(",")}`)
    assert(!types.includes("session.execution.failed"), "prompt execution failed")
    return { types, marker, text: outputText }
  } finally {
    getSseEvents = await sse.stop()
    assert(getSseEvents > 0, "GET session event SSE received no events")
    console.log(`[SSE] GET stream observed ${getSseEvents} events`)
  }
}

let sessionID
let toolSessionID
let controlSessionID
let noTitleSessionID
try {
  const created = await api("/api/session", "POST", {
    title: `session-plugin-v2-e2e-${Date.now()}`,
    location: { directory: "/workspace" },
    model,
    sandbox: {
      cpu: "1",
      memory: "2Gi",
      image: process.env.SANDBOX_IMAGE ?? "opencode-opensandbox-session-plugin-verify:local",
    },
  })
  assert.equal(created.response.status, 200, created.text)
  sessionID = created.data.data.id
  console.log(`Session: ${sessionID}`)
  console.log(`Session sandbox config: ${JSON.stringify(created.data.data.sandbox ?? null)}`)
  assert.equal(
    created.data.data.sandbox?.image,
    process.env.SANDBOX_IMAGE ?? "opencode-opensandbox-session-plugin-verify:local",
    "Session API did not persist the requested sandbox image",
  )

  const empty = await api(`/api/session/${sessionID}/plugins`)
  assert.equal(empty.response.status, 200, empty.text)
  assert.deepEqual(empty.data.data, [])

  const hookMarker = `SESSION_PLUGIN_HOOK_${Date.now()}`
  const source = {
    type: "code",
    code: `export default async () => ({ "session.prompt": (event) => { event.prompt.text = "Reply with exactly ${hookMarker} and nothing else." } })`,
  }
  const createdPlugin = await api(`/api/session/${sessionID}/plugins`, "POST", {
    name: "e2e-hook", description: "Live V2 session hook E2E", source,
  })
  assert.equal(createdPlugin.response.status, 200, createdPlugin.text)
  assert.deepEqual(createdPlugin.data.data.source, { type: "code" }, "create response must redact plugin source")
  assert(!createdPlugin.text.includes("export default"), "create response leaked source")

  const list = await api(`/api/session/${sessionID}/plugins`)
  assert.equal(list.response.status, 200, list.text)
  assert.equal(list.data.data.length, 1)
  assert.deepEqual(list.data.data[0].source, { type: "code" }, "list response must redact plugin source")
  assert(!list.text.includes("export default"), "list response leaked source")

  for (const [name, source] of [
    ["npm-valid", { type: "npm", spec: "debug@4.4.1" }],
    ["npm-scoped", { type: "npm", spec: "@npmcli/fs" }],
    ["npm-invalid", { type: "npm", spec: "../invalid-session-plugin" }],
    ["syntax-invalid", { type: "code", code: "export default {{{" }],
    ["factory-throws", { type: "code", code: 'export default async () => { throw new Error("FACTORY_THROW_PROBE") }' }],
    ["no-export", { type: "code", code: "export const notAPlugin = 1" }],
    ["unknown-hook", { type: "code", code: 'export default async () => ({ "unsupported.event": () => {} })' }],
  ]) {
    const response = await api(`/api/session/${sessionID}/plugins`, "POST", {
      name, description: "intentional isolated load failure", source,
    })
    assert.equal(response.response.status, 200, response.text)
  }

  const stored = pg(`SELECT count(*) || '|' || max(source::jsonb->>'type') FROM session_plugins WHERE session_id='${sessionID}' AND name='e2e-hook'`)
  assert.equal(stored, "1|code", `PG source row mismatch: ${stored}`)
  console.log("PASS CRUD/PG/source-redaction")

  // Subscribe to GET event SSE before each prompt; this is separate from prompt_stream.
  const firstTurn = await runPrompt(sessionID, "Follow the installed session plugin hook.", hookMarker, BASE)
  assert(firstTurn.text.includes(hookMarker), `assistant response did not consume hook marker: ${firstTurn.text}`)
  const persistedFirstPrompt = await api(`/api/session/${sessionID}/message?order=asc&limit=100`)
  assert.equal(persistedFirstPrompt.data.data.findLast((message) => message.type === "user")?.text,
    `Reply with exactly ${hookMarker} and nothing else.`, "persisted user prompt did not contain the hook mutation")
  const sandboxContainer = execFileSync("docker", ["ps", "-aq", "--filter", `label=session=${sessionID}`], { encoding: "utf8" }).trim()
  assert(sandboxContainer, `No local Docker sandbox found for session ${sessionID}`)
  const sandboxImage = execFileSync("docker", ["inspect", "--format", "{{.Config.Image}}", sandboxContainer], { encoding: "utf8" }).trim()
  console.log(`Sandbox container: ${sandboxContainer} image=${sandboxImage}`)
  assert.equal(sandboxImage, process.env.SANDBOX_IMAGE ?? "opencode-opensandbox-session-plugin-verify:local")
  const health = () => JSON.parse(execFileSync("docker", [
    "exec", sandboxContainer, "bun", "-e",
    'fetch("http://127.0.0.1:9200/health").then((r) => r.text()).then(console.log)',
  ], { encoding: "utf8" }).trim())
  const agentHealth = health()
  assert(agentHealth.errors.some((item) => item.name === "npm-invalid"), "npm installation failure was not isolated/reported")
  assert(agentHealth.errors.some((item) => item.name === "syntax-invalid"), "syntax error was not isolated/reported")
  assert(agentHealth.errors.some((item) => item.name === "factory-throws"), "factory exception was not isolated/reported")
  assert(agentHealth.errors.some((item) => item.name === "no-export"), "missing plugin export was not isolated/reported")
  assert(!agentHealth.errors.some((item) => item.name === "npm-valid"), "valid npm package failed to install/load in sandbox")
  const scoped = agentHealth.errors.find((item) => item.name === "npm-scoped")
  assert(scoped && !scoped.error.includes("Unsupported npm plugin spec") && !scoped.error.includes("Failed to install") && !scoped.error.includes("Cannot find module"),
    `scoped npm spec was rejected or failed to install: ${scoped?.error}`)
  // @npmcli/fs installs and loads; its default export is fs.cp, so calling it as a hook
  // factory throws inside the sandbox and is isolated like any non-plugin module.
  assert(agentHealth.hooks.includes("session.prompt"), "valid hook was lost when neighboring plugins failed")
  assert(!agentHealth.hooks.includes("unsupported.event"), "unknown hook should not be registered")
  console.log(`PASS npm-failure/syntax-error-isolation; agent health=${JSON.stringify(agentHealth)}`)

  const context = await api(`/api/session/${sessionID}/context`)
  assert.equal(context.response.status, 200, context.text)
  const serializedContext = JSON.stringify(context.data.data)
  assert(serializedContext.includes(hookMarker), `hook output marker absent from Session context: ${hookMarker}`)
  console.log(`PASS sandbox-hook/downstream-consumption; GET SSE observed; prompt events=${firstTurn.types.length}`)

  const throwingHook = await api(`/api/session/${sessionID}/plugins`, "POST", {
    name: "ordinary-hook-throws",
    description: "intentional fail-open hook",
    source: { type: "code", code: 'export default async () => ({ "session.prompt": () => { throw new Error("ORDINARY_HOOK_THROW_PROBE") } })' },
  })
  assert.equal(throwingHook.response.status, 200, throwingHook.text)
  const failOpenTurn = await runPrompt(sessionID, "The plugin hook will fail. Continue normally and reply exactly FAIL_OPEN_CONTINUES.", "FAIL_OPEN_CONTINUES")
  assert(failOpenTurn.text.includes("FAIL_OPEN_CONTINUES"), `ordinary hook error did not fail open: ${failOpenTurn.text}`)
  console.log("PASS ordinary-hook-error-fail-open")
  assert.equal((await api(`/api/session/${sessionID}/plugins/ordinary-hook-throws`, "DELETE", undefined, BASE_SECOND || BASE)).response.status, 204)

  const timeoutHook = await api(`/api/session/${sessionID}/plugins`, "POST", {
    name: "timeout-hook",
    description: "intentional timeout fail-open hook",
    source: { type: "code", code: 'export default async () => ({ "session.prompt": async () => new Promise(() => {}) })' },
  })
  assert.equal(timeoutHook.response.status, 200, timeoutHook.text)
  const timeoutTurn = await runPrompt(sessionID, "The plugin hook will time out. Continue normally and reply exactly TIMEOUT_FAIL_OPEN.", "TIMEOUT_FAIL_OPEN")
  assert(timeoutTurn.text.includes("TIMEOUT_FAIL_OPEN"), `timed out hook did not fail open: ${timeoutTurn.text}`)
  console.log("PASS hook-timeout-fail-open")
  assert.equal((await api(`/api/session/${sessionID}/plugins/timeout-hook`, "DELETE", undefined, BASE_SECOND || BASE)).response.status, 204)

  // Image-mode runs restart the SaaS container; source-service runs (SKIP_SAAS_RESTART=1)
  // still verify the Agent-kill recovery below because the source process is not a container.
  if (!process.env.SKIP_SAAS_RESTART) {
    execFileSync("docker", ["restart", process.env.SAAS_RESTART_CONTAINER ?? "opencode-saas-session-plugin-a"], { stdio: "inherit" })
    const restartDeadline = Date.now() + 60_000
    while (Date.now() < restartDeadline) {
      const check = await fetch(`${BASE}/api/session/${sessionID}`, { headers }).catch(() => undefined)
      if (check?.status === 200) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const restartedSession = await api(`/api/session/${sessionID}`)
    assert.equal(restartedSession.response.status, 200, "SaaS did not recover session after container restart")
  }
  const agentPID = execFileSync("docker", ["exec", sandboxContainer, "cat", "/tmp/plugin-agent.pid"], { encoding: "utf8" }).trim()
  execFileSync("docker", ["exec", sandboxContainer, "kill", agentPID])
  const afterAgentRestart = await runPrompt(sessionID, "The agent was restarted; follow the persisted plugin.", hookMarker)
  assert(afterAgentRestart.text.includes(hookMarker), "plugin was not restored after Agent/SaaS restart")
  console.log(`PASS SaaS-restart/agent-restart-recovery${process.env.SKIP_SAAS_RESTART ? " (source-service mode: agent-restart only)" : ""}`)

  const updated = await api(`/api/session/${sessionID}/plugins`, "POST", {
    name: "e2e-hook", description: "Updated", source: { ...source, code: source.code.replace(hookMarker, `${hookMarker}_V2`) },
  }, BASE_SECOND || BASE)
  assert.equal(updated.response.status, 200, updated.text)
  const secondMarker = `${hookMarker}_V2`
  const secondTurn = await runPrompt(sessionID, "Use the updated session plugin version.", secondMarker, BASE)
  const updatedContext = await api(`/api/session/${sessionID}/context`)
  assert.equal(updatedContext.response.status, 200, updatedContext.text)
  assert(JSON.stringify(updatedContext.data.data).includes(secondMarker), "updated hook generation was not consumed")
  console.log(`PASS runtime-hot-update; prompt events=${secondTurn.types.length}`)

  const concurrentUpdates = await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const marker = `CONCURRENT_VERSION_${index}_${Date.now()}`
    const updatedSource = {
      type: "code",
      code: `export default async () => ({ "session.prompt": (event) => { event.prompt.text = "Reply with exactly ${marker}." } })`,
    }
    return api(`/api/session/${sessionID}/plugins`, "POST", {
      name: "e2e-hook", description: `concurrent update ${index}`, source: updatedSource,
    }, index % 2 === 0 ? BASE : (BASE_SECOND || BASE))
  }))
  assert(concurrentUpdates.every((result) => result.response.status === 200), "one or more concurrent Pod upserts failed")
  const persistedCode = pg(`SELECT source::jsonb->>'code' FROM session_plugins WHERE session_id='${sessionID}' AND name='e2e-hook'`)
  const finalMarker = persistedCode.match(/CONCURRENT_VERSION_[A-Z0-9_]+/)?.[0]
  assert(finalMarker, `could not read concurrent winner from PG: ${persistedCode}`)
  const concurrentTurn = await runPrompt(sessionID, "Follow the latest concurrently stored plugin.", finalMarker)
  assert(concurrentTurn.text.includes(finalMarker), `runtime did not consume PG winner ${finalMarker}: ${concurrentTurn.text}`)
  console.log(`PASS multi-pod-concurrent-upsert/eventual-latest-version; winner=${finalMarker}`)
  for (const name of ["e2e-hook", "npm-valid", "npm-scoped", "npm-invalid", "syntax-invalid", "factory-throws", "no-export", "unknown-hook"]) {
    const deleted = await api(`/api/session/${sessionID}/plugins/${name}`, "DELETE", undefined, BASE_SECOND || BASE)
    assert.equal(deleted.response.status, 204, deleted.text)
  }
  assert.equal(pg(`SELECT count(*) FROM session_plugins WHERE session_id='${sessionID}'`), "0")
  const afterDelete = await runPrompt(sessionID, "With no session plugin installed, reply exactly CLEAN_SESSION_PLUGIN_OK.", "CLEAN_SESSION_PLUGIN_OK")
  assert(afterDelete.text.includes("CLEAN_SESSION_PLUGIN_OK"), `prompt did not work after plugin delete: ${afterDelete.text}`)
  const emptyHealth = health()
  assert.equal(emptyHealth.plugins, 0, "deleted plugins remain loaded in sandbox Agent")
  assert.deepEqual(emptyHealth.hooks, [], "deleted plugin hooks remain registered in sandbox Agent")
  console.log("PASS delete/next-hook-clears-agent/PG-cleanup")

  const control = await api("/api/session", "POST", {
    title: `session-plugin-control-${Date.now()}`,
    location: { directory: "/workspace" }, model,
    sandbox: { cpu: "1", memory: "2Gi", image: process.env.SANDBOX_IMAGE ?? "opencode-opensandbox-session-plugin-verify:local" },
  })
  assert.equal(control.response.status, 200, control.text)
  controlSessionID = control.data.data.id
  assert.deepEqual((await api(`/api/session/${controlSessionID}/plugins`)).data.data, [])
  const controlTurn = await runPrompt(controlSessionID, "No plugin is installed. Reply exactly SESSION_PLUGIN_CONTROL_OK.", "SESSION_PLUGIN_CONTROL_OK")
  assert(controlTurn.text.includes("SESSION_PLUGIN_CONTROL_OK"), `unregistered control session failed: ${controlTurn.text}`)
  console.log("PASS unregistered-session-control")

  const markerA = `SESSION_ISOLATION_A_${Date.now()}`
  const markerB = `SESSION_ISOLATION_B_${Date.now()}`
  for (const [id, marker] of [[sessionID, markerA], [controlSessionID, markerB]]) {
    const isolated = await api(`/api/session/${id}/plugins`, "POST", {
      name: "isolation-probe", description: "per-session sandbox plugin isolation",
      source: { type: "code", code: `export default async () => ({ "session.prompt": (event) => { event.prompt.text = "Reply exactly ${marker}." } })` },
    })
    assert.equal(isolated.response.status, 200, isolated.text)
  }
  const isolatedA = await runPrompt(sessionID, "Isolation check A.", markerA)
  const isolatedB = await runPrompt(controlSessionID, "Isolation check B.", markerB)
  assert(isolatedA.text.includes(markerA) && !isolatedA.text.includes(markerB), `Session A plugin leaked or failed: ${isolatedA.text}`)
  assert(isolatedB.text.includes(markerB) && !isolatedB.text.includes(markerA), `Session B plugin leaked or failed: ${isolatedB.text}`)
  console.log("PASS runtime-plugin-session-isolation")

  const toolSession = await api("/api/session", "POST", {
    title: `session-plugin-tool-e2e-${Date.now()}`,
    location: { directory: "/workspace" },
    model,
    sandbox: {
      cpu: "1",
      memory: "2Gi",
      image: process.env.SANDBOX_IMAGE ?? "opencode-opensandbox-session-plugin-verify:local",
    },
  })
  assert.equal(toolSession.response.status, 200, toolSession.text)
  toolSessionID = toolSession.data.data.id
  const toolCode = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Echo the provided value for Session Plugin hook testing",
  args: { value: tool.schema.string().describe("value to echo") },
  async execute(args) {
    if (args.value === "FAIL_ME") throw new Error("ORIGINAL_FAIL")
    return { title: "Plugin Hook Probe", output: args.value }
  },
})`
  assert.equal((await api(`/api/session/${toolSessionID}/tools`, "POST", {
    name: "plugin_probe", description: "Deterministic hook fixture", code: toolCode,
  })).response.status, 200)
  assert.equal((await api(`/api/session/${toolSessionID}/tools`, "POST", {
    name: "failing_probe", description: "Deterministic failure fixture",
    code: `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Always fails for Session Plugin error-path testing",
  args: { value: tool.schema.string().describe("value") },
  async execute() { throw new Error("ORIGINAL_FAIL") },
})`,
  })).response.status, 200)
  const toolHookSource = `export default async () => ({
    "tool.execute.before": (event) => { if (event.tool === "plugin_probe") event.input.value = "PLUGIN_BEFORE_MUTATION" },
    "tool.execute.after": (event) => { if (event.tool === "plugin_probe") event.result.content = String(event.result.output) + "|PLUGIN_AFTER_MUTATION" },
  })`
  assert.equal((await api(`/api/session/${toolSessionID}/plugins`, "POST", {
    name: "tool-hooks", description: "before/after fixture", source: { type: "code", code: toolHookSource },
  })).response.status, 200)
  const toolTurn = await runPrompt(toolSessionID,
    "Call the plugin_probe tool exactly once with value ORIGINAL_VALUE. Do not call other tools. Then report its result.",
    "PLUGIN_AFTER_MUTATION")
  const readCalls = async () => {
    const messages = await api(`/api/session/${toolSessionID}/message?order=asc&limit=100`)
    return messages.data.data.flatMap((message) => message.type === "assistant"
      ? (message.content ?? []).filter((part) => part.type === "tool" && part.name === "plugin_probe")
      : [])
  }
  let calls = await readCalls()
  let successfulCall = calls.findLast((call) => call.state.status === "completed")
  assert(successfulCall, `model did not complete plugin_probe; SSE types=${toolTurn.types.join(",")}`)
  const resultContent = JSON.stringify(successfulCall.state.content)
  assert(resultContent.includes("PLUGIN_BEFORE_MUTATION"), `tool.execute.before mutation did not reach execution result: ${resultContent}`)
  assert(resultContent.includes("PLUGIN_AFTER_MUTATION"), `tool.execute.after mutation did not reach result: ${resultContent}`)
  console.log("PASS tool-before-input/tool-after-result")

  const vetoReason = `PLUGIN_VETO_${Date.now()}`
  assert.equal((await api(`/api/session/${toolSessionID}/plugins`, "POST", {
    name: "tool-hooks", description: "tool veto fixture",
    source: { type: "code", code: `export default async () => ({ "tool.execute.before": () => { throw new Error(${JSON.stringify(vetoReason)}) } })` },
  })).response.status, 200)
  const vetoTurn = await runPrompt(toolSessionID,
    "Call plugin_probe exactly once with value MUST_NOT_EXECUTE. Do not retry. Report the tool error.",
    vetoReason)
  calls = await readCalls()
  const vetoCall = calls.findLast((call) => call.state.status === "error")
  assert(vetoCall, `tool before veto produced no failed tool call; SSE=${vetoTurn.types.join(",")}`)
  assert(String(vetoCall.state.error?.message ?? "").includes(vetoReason), `veto reason missing: ${JSON.stringify(vetoCall.state.error)}`)
  assert.equal(vetoCall.state.input.value, "MUST_NOT_EXECUTE")
  console.log("PASS tool-before-veto")

  // ---- Hook 桥全量路由与回传：9 个类型化 hook 域逐一验证（补 context/compaction/generate/title/model.request/permission）----
  assert.equal((await api(`/api/session/${toolSessionID}/plugins/tool-hooks`, "DELETE")).response.status, 204)
  const bridgeMarker = `HOOK_BRIDGE_${Date.now()}`
  const bridgeCode = `export default async () => ({
    "session.prompt": (e) => { e.prompt.text += " ${bridgeMarker}_PROMPT" },
    "session.context": (e) => { e.bridgeContext = "${bridgeMarker}_CONTEXT" },
    "session.compaction": (e) => { e.bridgeCompaction = "${bridgeMarker}_COMPACTION" },
    "session.generate": (e) => { e.bridgeGenerate = "${bridgeMarker}_GENERATE" },
    "session.title": (e) => { e.bridgeTitle = "${bridgeMarker}_TITLE" },
    "session.model.request": (e) => { e.headers = { ...(e.headers ?? {}), "x-bridge-marker": "${bridgeMarker}_MODEL" } },
    "tool.execute.before": (e) => { if (e.tool === "plugin_probe") e.input.value = "${bridgeMarker}_TOOL_BEFORE" },
    "tool.execute.after": (e) => {
      if (e.tool === "plugin_probe" && e.result) e.result.content = "${bridgeMarker}_TOOL_AFTER"
      if (e.status === "error" && e.error) e.error = { ...e.error, message: String(e.error.message) + "|ERROR_REWRITTEN" }
    },
    "permission.evaluate": (e) => { if (String(e.action ?? "").includes("plugin_probe") || String(e.action ?? "").includes("glob")) { e.effect = "deny"; e.message = "${bridgeMarker}_PERM_DENY" } },
  })`
  assert.equal((await api(`/api/session/${toolSessionID}/plugins`, "POST", {
    name: "hook-bridge", description: "all nine typed hook domains", source: { type: "code", code: bridgeCode },
  })).response.status, 200)
  const bridgeContainer = execFileSync("docker", ["ps", "-aq", "--filter", `label=session=${toolSessionID}`], { encoding: "utf8" }).trim()
  assert(bridgeContainer, "no sandbox container for hook bridge probe")
  const agentHealthOf = (container) => JSON.parse(execFileSync("docker", [
    "exec", container, "bun", "-e",
    'fetch("http://127.0.0.1:9200/health").then((r) => r.text()).then(console.log)',
  ], { encoding: "utf8" }).trim())
  const expectedBridgeHooks = ["session.prompt", "session.context", "session.compaction", "session.generate", "session.title",
    "session.model.request", "tool.execute.before", "tool.execute.after", "permission.evaluate"]
  let bridgeReady = agentHealthOf(bridgeContainer)
  for (let attempt = 0; attempt < 60; attempt++) {
    bridgeReady = agentHealthOf(bridgeContainer)
    if (!bridgeReady.errors?.some((item) => item.name === "hook-bridge") && expectedBridgeHooks.every((h) => bridgeReady.hooks?.includes(h))) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert(!bridgeReady.errors?.some((item) => item.name === "hook-bridge"),
    `hook-bridge failed to load in the sandbox agent: ${JSON.stringify(bridgeReady.errors?.find((item) => item.name === "hook-bridge"))}`)
  for (const hook of expectedBridgeHooks) {
    assert(bridgeReady.hooks?.includes(hook), `hook ${hook} missing from agent registration: ${JSON.stringify(bridgeReady.hooks)}`)
  }
  const agentProbe = (path, event) => JSON.parse(execFileSync("docker", [
    "exec", "-e", `PROBE=${JSON.stringify(event)}`, "-e", `PROBE_PATH=${path}`, bridgeContainer,
    "bun", "-e",
    'fetch("http://127.0.0.1:9200" + process.env.PROBE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: JSON.parse(process.env.PROBE) }) }).then((r) => r.text()).then(console.log)',
  ], { encoding: "utf8" }).trim())
  const directChecks = [
    ["session.prompt", "/hook/session/prompt", { sessionID: toolSessionID, prompt: { text: "x" }, metadata: {}, delivery: "steer" },
      (e) => e.prompt?.text?.includes(`${bridgeMarker}_PROMPT`)],
    ["session.context", "/hook/session/context", { sessionID: toolSessionID, agent: "primary", messages: [], tools: [] },
      (e) => e.bridgeContext === `${bridgeMarker}_CONTEXT`],
    ["session.compaction", "/hook/session/compaction", { sessionID: toolSessionID },
      (e) => e.bridgeCompaction === `${bridgeMarker}_COMPACTION`],
    ["session.generate", "/hook/session/generate", { sessionID: toolSessionID },
      (e) => e.bridgeGenerate === `${bridgeMarker}_GENERATE`],
    ["session.title", "/hook/session/title", { sessionID: toolSessionID },
      (e) => e.bridgeTitle === `${bridgeMarker}_TITLE`],
    ["session.model.request", "/hook/session/model.request", { sessionID: toolSessionID, headers: {} },
      (e) => e.headers?.["x-bridge-marker"] === `${bridgeMarker}_MODEL`],
    ["tool.execute.before", "/hook/tool/execute.before", { sessionID: toolSessionID, tool: "plugin_probe", input: { value: "X" } },
      (e) => e.input?.value === `${bridgeMarker}_TOOL_BEFORE`],
    ["tool.execute.after", "/hook/tool/execute.after", { sessionID: toolSessionID, tool: "plugin_probe", input: {}, result: { output: "Y", content: [] } },
      (e) => e.result?.content === `${bridgeMarker}_TOOL_AFTER`],
    ["permission.evaluate", "/hook/permission/evaluate", { sessionID: toolSessionID, action: "plugin_probe", resources: [], effect: "allow" },
      (e) => e.effect === "deny" && e.message === `${bridgeMarker}_PERM_DENY`],
  ]
  for (const [hook, path, event, check] of directChecks) {
    const result = await agentProbe(path, event)
    assert(check(result.event), `${hook} bridge mutation was not returned: ${JSON.stringify(result.event)}`)
  }
  console.log("PASS hook-bridge-all-nine-domains-roundtrip")

  // ---- 真实触发接线：core 触发点 -> Agent 的实际派发 ----
  const waitForHook = async (container, hook, baseline = 0, timeoutMs = 90_000) => {
    const deadline = Date.now() + timeoutMs
    let health = agentHealthOf(container)
    while (Date.now() < deadline && (health.hookRequests?.[hook] ?? 0) <= baseline) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      health = agentHealthOf(container)
    }
    return health
  }
  const countsBefore = agentHealthOf(bridgeContainer).hookRequests ?? {}
  const generated = await api(`/api/session/${toolSessionID}/generate`, "POST", { prompt: "Reply with the single word OK." })
  assert.equal(generated.response.status, 200, generated.text)
  let hookHealth = await waitForHook(bridgeContainer, "session.generate", countsBefore["session.generate"] ?? 0)
  assert((hookHealth.hookRequests?.["session.generate"] ?? 0) > (countsBefore["session.generate"] ?? 0),
    `session.generate was not dispatched by the generate API: ${JSON.stringify(hookHealth.hookRequests)}`)
  hookHealth = await waitForHook(bridgeContainer, "session.model.request", countsBefore["session.model.request"] ?? 0)
  assert((hookHealth.hookRequests?.["session.model.request"] ?? 0) > (countsBefore["session.model.request"] ?? 0),
    `session.model.request was not dispatched by the generate API: ${JSON.stringify(hookHealth.hookRequests)}`)
  console.log("PASS session.generate/model.request-dispatch")

  assert.equal((await api(`/api/session/${toolSessionID}/compact`, "POST", {})).response.status, 200)
  hookHealth = await waitForHook(bridgeContainer, "session.compaction", countsBefore["session.compaction"] ?? 0)
  assert((hookHealth.hookRequests?.["session.compaction"] ?? 0) > (countsBefore["session.compaction"] ?? 0),
    `session.compaction was not dispatched by the compact API: ${JSON.stringify(hookHealth.hookRequests)}`)
  console.log("PASS session.compaction-dispatch")

  const noTitleSession = await api("/api/session", "POST", {
    location: { directory: "/workspace" }, model,
    sandbox: { cpu: "1", memory: "2Gi", image: process.env.SANDBOX_IMAGE ?? "opencode-opensandbox-session-plugin-verify:local" },
  })
  assert.equal(noTitleSession.response.status, 200, noTitleSession.text)
  noTitleSessionID = noTitleSession.data.data.id
  assert.equal((await api(`/api/session/${noTitleSessionID}/plugins`, "POST", {
    name: "hook-bridge", description: "title dispatch fixture", source: { type: "code", code: bridgeCode },
  })).response.status, 200)
  await runPrompt(noTitleSessionID, "Say OK.", "OK")
  const titleContainer = execFileSync("docker", ["ps", "-aq", "--filter", `label=session=${noTitleSessionID}`], { encoding: "utf8" }).trim()
  assert(titleContainer, "no sandbox for title dispatch probe")
  const titleHealth = await waitForHook(titleContainer, "session.title")
  assert((titleHealth.hookRequests?.["session.title"] ?? 0) > 0,
    `session.title was not dispatched for an untitled session: ${JSON.stringify(titleHealth.hookRequests)}`)
  const contextHealth = await waitForHook(titleContainer, "session.context")
  assert((contextHealth.hookRequests?.["session.context"] ?? 0) > 0,
    `session.context was not dispatched by a primary model request: ${JSON.stringify(contextHealth.hookRequests)}`)
  console.log("PASS session.title/context-dispatch")

  // ---- Agent /configure 相同代次去重 ----
  const loadedCount = () => Number(execFileSync("docker", [
    "exec", bridgeContainer, "sh", "-c", "grep -c 'loaded:' /tmp/plugin-agent.log || echo 0",
  ], { encoding: "utf8" }).trim())
  const postConfigure = (plugins) => execFileSync("docker", [
    "exec", "-e", `BODY=${JSON.stringify({ plugins })}`, bridgeContainer, "bun", "-e",
    'fetch("http://127.0.0.1:9200/configure", { method: "POST", headers: { "content-type": "application/json" }, body: process.env.BODY }).then((r) => r.text()).then(console.log)',
  ], { encoding: "utf8" }).trim()
  const bridgeRows = [{ name: "hook-bridge", source: { type: "code", code: bridgeCode } }]
  const loadedBeforeDedup = loadedCount()
  postConfigure(bridgeRows)
  postConfigure(bridgeRows)
  assert.equal(loadedCount(), loadedBeforeDedup, "identical configure generations reloaded the plugin agent")
  postConfigure([{ name: "hook-bridge", source: { type: "code", code: `${bridgeCode}\n// generation-2` } }])
  assert(loadedCount() > loadedBeforeDedup, "changed configure generation did not reload the plugin agent")
  postConfigure(bridgeRows)
  console.log("PASS agent-configure-dedup/reload")

  // ---- permission.evaluate 真实触发：hook 强制 deny 内置 glob 工具（session tool 不走 Permission.assert）----
  assert.equal((await api(`/api/session/${toolSessionID}/plugins`, "POST", {
    name: "hook-bridge", description: "permission deny fixture", source: { type: "code", code: bridgeCode },
  })).response.status, 200)
  const callsBeforePerm = new Set((await readCalls()).map((call) => call.id))
  const permTurn = await runPrompt(toolSessionID,
    "Use the glob tool exactly once with pattern *.md. Do not retry or use other tools. Report the exact tool error.",
    "PERM")
  const globCalls = (await api(`/api/session/${toolSessionID}/message?order=asc&limit=100`)).data.data
    .flatMap((message) => message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool" && part.name === "glob") : [])
    .filter((call) => !callsBeforePerm.has(call.id))
  const deniedCall = globCalls.findLast((call) => call.state.status === "error")
  assert(deniedCall, `permission deny produced no failed glob call; statuses=${JSON.stringify(globCalls.map((c) => c.state.status))}; SSE=${permTurn.types.join(",")}`)
  const denyMessage = String(deniedCall.state.error?.message ?? "")
  assert(denyMessage.includes(`${bridgeMarker}_PERM_DENY`),
    `permission deny message missing: ${JSON.stringify(deniedCall.state.error)}`)
  assert(String(deniedCall.state.error?.type ?? "") === "permission.rejected",
    `deny cause classification was lost: ${JSON.stringify(deniedCall.state.error)}`)
  hookHealth = await waitForHook(bridgeContainer, "permission.evaluate", countsBefore["permission.evaluate"] ?? 0)
  assert((hookHealth.hookRequests?.["permission.evaluate"] ?? 0) > (countsBefore["permission.evaluate"] ?? 0),
    `permission.evaluate was not dispatched: ${JSON.stringify(hookHealth.hookRequests)}`)
  console.log("PASS permission.evaluate-deny")

  // tool.execute.after error message rewrite: a causeless Tool.Error keeps the rewritten message
  const callsBeforeRewrite = new Set((await readCalls()).map((call) => call.id))
  const rewriteTurn = await runPrompt(toolSessionID,
    "Call the failing_probe tool exactly once. Do not retry. Report the exact error.", "REWRITE")
  const messagesAfterRewrite = await api(`/api/session/${toolSessionID}/message?order=asc&limit=100`)
  const rewriteCalls = messagesAfterRewrite.data.data
    .flatMap((message) => message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool" && part.name === "failing_probe") : [])
  const rewritten = rewriteCalls.findLast((call) => call.state.status === "error")
  assert(rewritten, `no failed failing_probe call; calls=${JSON.stringify(rewriteCalls.map((c) => c.state.status))}; SSE=${rewriteTurn.types.join(",")}`)
  const rewrittenMessage = String(rewritten.state.error?.message ?? "")
  assert(rewrittenMessage.includes("ORIGINAL_FAIL|ERROR_REWRITTEN"),
    `causeless tool error message rewrite missing: ${JSON.stringify(rewritten.state.error)}`)
  console.log("PASS tool.execute.after-error-message-rewrite")

  // ---- Agent /shutdown 与自愈 ----
  execFileSync("docker", ["exec", bridgeContainer, "bun", "-e",
    'fetch("http://127.0.0.1:9200/shutdown", { method: "POST" }).then((r) => r.text()).then(console.log)',
  ], { encoding: "utf8" })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const downProbe = execFileSync("docker", ["exec", bridgeContainer, "bun", "-e",
    'fetch("http://127.0.0.1:9200/health", { signal: AbortSignal.timeout(2000) }).then(() => console.log("UP")).catch(() => console.log("DOWN"))',
  ], { encoding: "utf8" }).trim()
  assert.equal(downProbe, "DOWN", "agent did not stop after /shutdown")
  const recoveryWord = `SHUTDOWN_RECOVERED_${Date.now()}`
  await runPrompt(toolSessionID, `Do not call any tools. Reply exactly ${recoveryWord}.`, recoveryWord)
  const recoveryMessages = await api(`/api/session/${toolSessionID}/message?order=asc&limit=100`)
  const recoveryUser = recoveryMessages.data.data.findLast((message) => message.type === "user")?.text ?? ""
  assert(recoveryUser.includes(`${bridgeMarker}_PROMPT`),
    `agent restart did not restore the prompt hook mutation: ${recoveryUser}`)
  console.log("PASS agent-shutdown/self-heal")

  const probeMarker = `SANDBOX_CONTAINED_PROBE_${Date.now()}`
  const probeSource = `export default async () => ({ "session.prompt": async (event) => {
    const path = "/tmp/${probeMarker}"
    await Bun.write(path, "FILE_OK")
    const child = Bun.spawnSync(["sh", "-c", "printf SUBPROCESS_OK"])
    const response = await fetch("http://127.0.0.1:9200/health")
    const file = await Bun.file(path).text()
    await Bun.file(path).delete()
    if (child.exitCode !== 0 || child.stdout.toString() !== "SUBPROCESS_OK" || file !== "FILE_OK" || response.status !== 200)
      throw new Error("contained capability probe failed")
    event.prompt.text = "Reply exactly ${probeMarker}."
  } })`
  assert.equal((await api(`/api/session/${toolSessionID}/plugins`, "POST", {
    name: "contained-capability-probe", description: "temporary in-container file/process/loopback probe",
    source: { type: "code", code: probeSource },
  })).response.status, 200)
  const probeTurn = await runPrompt(toolSessionID, "Run the contained capability probe and follow its prompt.", probeMarker)
  assert(probeTurn.text.includes(probeMarker), `contained capability probe failed: ${probeTurn.text}`)
  const probeContainer = execFileSync("docker", ["ps", "-aq", "--filter", `label=session=${toolSessionID}`], { encoding: "utf8" }).trim()
  assert(probeContainer, "no disposable sandbox container found for capability probe")
  const security = execFileSync("docker", ["inspect", "--format",
    '{{.HostConfig.Privileged}}|{{json .HostConfig.SecurityOpt}}|{{json .HostConfig.CapDrop}}|{{.Config.User}}|{{.HostConfig.PidsLimit}}',
    probeContainer,
  ], { encoding: "utf8" }).trim().split("|")
  assert.equal(security[0], "false", `sandbox unexpectedly privileged: ${security.join("|")}`)
  assert(JSON.parse(security[1]).some((item) => item === "no-new-privileges:true"), `no_new_privileges absent: ${security[1]}`)
  const droppedCaps = JSON.parse(security[2])
  assert(droppedCaps.includes("SYS_ADMIN") && droppedCaps.includes("NET_ADMIN"), `expected capabilities not dropped: ${security[2]}`)
  console.log(`PASS contained-file/subprocess/loopback probes; container security=${security.join("|")}`)
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.stack : error}`)
  process.exitCode = 1
} finally {
  if (controlSessionID) {
    const cleanup = await api(`/api/session/${controlSessionID}`, "DELETE").catch(() => undefined)
    if (cleanup && ![200, 204, 404].includes(cleanup.response.status))
      console.error(`control session cleanup warning: DELETE session returned ${cleanup.response.status}`)
  }
  if (toolSessionID) {
    const cleanup = await api(`/api/session/${toolSessionID}`, "DELETE").catch(() => undefined)
    if (cleanup && ![200, 204, 404].includes(cleanup.response.status))
      console.error(`tool session cleanup warning: DELETE session returned ${cleanup.response.status}`)
  }
  if (noTitleSessionID) {
    const cleanup = await api(`/api/session/${noTitleSessionID}`, "DELETE").catch(() => undefined)
    if (cleanup && ![200, 204, 404].includes(cleanup.response.status))
      console.error(`no-title session cleanup warning: DELETE session returned ${cleanup.response.status}`)
  }
  if (sessionID) {
    const cleanup = await api(`/api/session/${sessionID}`, "DELETE").catch(() => undefined)
    if (cleanup && ![200, 204, 404].includes(cleanup.response.status))
      console.error(`cleanup warning: DELETE session returned ${cleanup.response.status}`)
  }
}
