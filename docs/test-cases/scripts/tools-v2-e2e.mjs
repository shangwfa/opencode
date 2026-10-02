import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14096").replace(/\/$/, "")
const PG_URL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const password = process.env.OPENCODE_PASSWORD
const headers = {
  "content-type": "application/json",
  ...(password ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } : {}),
}
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const sessions = []
let failed = 0

function check(name, passed, evidence = "") {
  console.log(`${passed ? "✅" : "❌"} ${name}${evidence ? ` — ${evidence}` : ""}`)
  if (!passed) failed++
}

async function api(path, method = "GET", body, timeout = 180_000) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { response, text, data }
}

function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function create(title) {
  const result = await api("/api/session", "POST", {
    title: `tools-e2e-${title}-${Date.now()}`,
    model,
    location: { directory: "/workspace" },
  })
  assert(result.response.ok, `create failed ${result.response.status}: ${result.text}`)
  const id = result.data?.data?.id
  assert(id, `create response missing id: ${result.text}`)
  sessions.push(id)
  return id
}

async function messages(id) {
  const result = await api(`/api/session/${id}/message?order=asc&limit=200`)
  assert(result.response.ok, `messages failed ${result.response.status}: ${result.text}`)
  return result.data?.data ?? []
}

async function prompt(id, text, timeout = 180_000) {
  const before = new Set(
    (await messages(id)).flatMap((message) =>
      message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool").map((part) => part.id) : [],
    ),
  )
  const response = await fetch(`${BASE}/api/session/${id}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(timeout),
  })
  const body = await response.text()
  assert(response.ok, `prompt_stream failed ${response.status}: ${body.slice(0, 600)}`)
  const events = [...body.matchAll(/^data:\s*(.+)$/gm)].flatMap((match) => {
    try {
      return [JSON.parse(match[1])]
    } catch {
      return []
    }
  })
  const rows = await messages(id)
  const tools = rows.flatMap((message) =>
    message.type === "assistant"
      ? (message.content ?? []).filter((part) => part.type === "tool" && !before.has(part.id))
      : [],
  )
  return { body, events, rows, tools }
}

async function shell(id, command) {
  const result = await api(`/api/session/${id}/shell`, "POST", { command }, 90_000)
  assert([200, 204].includes(result.response.status), `shell failed ${result.response.status}: ${result.text}`)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const rows = await messages(id)
    const latest = rows.findLast((message) => message.type === "shell")
    if (latest?.time?.completed != null) return latest
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`shell timed out: ${command}`)
}

const escape = (value) => value.replaceAll("'", "''")
const toolContent = (part) => {
  const content = part?.state?.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.filter((item) => item.type === "text").map((item) => item.text).join("\n")
  return ""
}

console.log(`Tools V2 E2E: ${BASE}; PG=${PG_URL}; model=${model.providerID}/${model.id}`)
try {
  // Session tools CRUD, validation, timestamps and PG consistency (T32.1-9, 14-19, 23).
  const crud = await create("crud")
  const code = `export default { description: "echo", args: {}, async execute() { return { title: "echo", output: "ok" } } }`
  const created = await api(`/api/session/${crud}/tools`, "POST", { name: "z-tool", description: "z", code })
  check("T32 CRUD create/upsert", created.response.ok, `HTTP ${created.response.status}`)
  const duplicate = await api(`/api/session/${crud}/tools`, "POST", { name: "z-tool", description: "updated", code })
  const added = await api(`/api/session/${crud}/tools`, "POST", { name: "a-tool", description: "a", code })
  const listing = await api(`/api/session/${crud}/tools`)
  check(
    "T32 upsert and ordered list",
    duplicate.response.ok && added.response.ok && listing.data?.data?.map((x) => x.name).join(",") === "a-tool,z-tool",
  )
  const count = pg(`select count(*) from session_tools where session_id='${escape(crud)}'`)
  check("T32 PG agrees with API", count === "2", `session_tools=${count}`)
  const bad = await api(`/api/session/${crud}/tools`, "POST", { name: "bad name", description: "bad", code })
  check("T32 invalid tool name rejected", bad.response.status === 400, `HTTP ${bad.response.status}`)
  const deleted = await api(`/api/session/${crud}/tools/a-tool`, "DELETE")
  const cleared = await api(`/api/session/${crud}/tools`, "DELETE")
  const empty = await api(`/api/session/${crud}/tools`)
  check("T32 delete and clear", deleted.response.ok && cleared.response.ok && (empty.data?.data ?? []).length === 0)
  check("T32 PG cascade/clear", pg(`select count(*) from session_tools where session_id='${escape(crud)}'`) === "0")

  // Real sandbox setup; verifies cold lazy glob and files API from the same /workspace.
  const fs = await create("filesystem")
  const started = Date.now()
  const cold = await prompt(fs, "只用 glob 工具列出 /workspace 下匹配 *.json 的文件；即使没有文件也必须实际调用 glob。")
  check(
    "T-LZY.1 cold first-call glob",
    cold.tools.some((part) => part.name === "glob" && part.state.status === "completed"),
    cold.tools.map((part) => `${part.name}:${part.state.status}`).join(","),
  )
  check(
    "T-LZY.1b lazy sandbox created",
    pg(`select count(*) from sandbox where session_id='${escape(fs)}' and state='running'`) === "1",
  )
  const initialized = await shell(
    fs,
    "mkdir -p /workspace/tools-check/src /workspace/tools-check/wide; printf 'alpha\\nbeta\\ngamma\\n' > /workspace/tools-check/small.txt; touch /workspace/tools-check/empty.txt; printf 'old-content\\n' > /workspace/tools-check/existing.txt; printf \"export const profileCardToken = 'PROFILE_CARD_SENTINEL';\\n\" > /workspace/tools-check/src/target.ts; touch /workspace/tools-check/src/empty.ts; for i in $(seq 1 120); do echo 'gtr-needle line' >> /workspace/tools-check/wide/big.txt; done",
  )
  check("sandbox shell fixture setup", initialized.exit === 0, String(initialized.exit))

  const writeEmpty = await prompt(fs, "只用 write 工具把 /workspace/tools-check/empty.txt 写成 empty-now-has-content。")
  const writePart = writeEmpty.tools.find((part) => part.name === "write")
  const writeMeta = writePart?.state?.metadata
  check(
    "T-WEX.1 empty file is recognized as existing",
    writePart?.state.status === "completed" && writeMeta?.existed === true,
    JSON.stringify(writeMeta),
  )
  const existsPG = pg(
    `select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') p where m.session_id='${escape(fs)}' and p->>'type'='tool' and p->>'name'='write' and p->'state'->'metadata'->>'existed'='true'`,
  )
  check("T-WEX.1 PG persists existed metadata", Number(existsPG) >= 1, `rows=${existsPG}`)

  const createFile = await prompt(fs, "只用 write 工具新建 /workspace/tools-check/new.txt，内容严格为 new-content；不要用 shell。")
  const createPart = createFile.tools.find(
    (part) => part.name === "write" && part.state?.input?.path === "/workspace/tools-check/new.txt",
  )
  check(
    "T-WEX.2 new file existed=false",
    createPart?.state.status === "completed" && createPart.state.metadata?.existed === false,
    JSON.stringify(createPart?.state),
  )
  const newContent = await shell(fs, "cat /workspace/tools-check/new.txt")
  check(
    "T-WEX.2 sandbox contains new content",
    newContent.exit === 0 && newContent.output?.output?.includes("new-content"),
    JSON.stringify(newContent.output),
  )

  const overwriteFile = await prompt(
    fs,
    "只用 write 工具把已有的 /workspace/tools-check/existing.txt 覆盖为 new-existing-content；不要用 shell 或其他工具。",
  )
  const overwritePart = overwriteFile.tools.find(
    (part) => part.name === "write" && part.state?.input?.path === "/workspace/tools-check/existing.txt",
  )
  check(
    "T-WEX.3 existing non-empty file existed=true",
    overwritePart?.state.status === "completed" && overwritePart.state.metadata?.existed === true,
    JSON.stringify(overwritePart?.state),
  )
  const existingContent = await shell(fs, "cat /workspace/tools-check/existing.txt")
  check(
    "T-WEX.3 sandbox contains replacement content",
    existingContent.exit === 0 &&
      existingContent.output?.output?.includes("new-existing-content") &&
      !existingContent.output?.output?.includes("old-content"),
    JSON.stringify(existingContent.output),
  )

  const createMetaPG = pg(
    `select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') p where m.session_id='${escape(fs)}' and p->>'type'='tool' and p->>'name'='write' and p->'state'->'input'->>'path'='/workspace/tools-check/new.txt' and p->'state'->'metadata'->>'existed'='false' and p->'state'->>'status'='completed'`,
  )
  const overwriteMetaPG = pg(
    `select count(*) from session_message m, jsonb_array_elements(m.data::jsonb->'content') p where m.session_id='${escape(fs)}' and p->>'type'='tool' and p->>'name'='write' and p->'state'->'input'->>'path'='/workspace/tools-check/existing.txt' and p->'state'->'metadata'->>'existed'='true' and p->'state'->>'status'='completed'`,
  )
  check(
    "T-WEX.2/.3 PG persists per-path existed metadata",
    createMetaPG === "1" && overwriteMetaPG === "1",
    `new=${createMetaPG}; overwrite=${overwriteMetaPG}`,
  )

  const read = await prompt(fs, "只用 read 工具读取 /workspace/tools-check/small.txt，返回原文 alpha beta gamma。")
  const readPart = read.tools.find((part) => part.name === "read")
  check(
    "T-RDX.2 read complete and bounded",
    readPart?.state.status === "completed" &&
      toolContent(readPart).includes("alpha") &&
      toolContent(readPart).includes("gamma") &&
      Date.now() - started < 120_000,
    `${readPart?.state.status}; elapsed=${Date.now() - started}ms`,
  )

  const search = await prompt(
    fs,
    "必须只调用 grep 工具，pattern 原样为 PROFILE_CARD_SENTINEL，path=/workspace/tools-check/src，include=*.ts；然后只调用 glob 工具，path 严格填写 /workspace/tools-check/src，pattern 严格填写 **/*.ts。",
  )
  const grepPart = search.tools.find((part) => part.name === "grep")
  const globPart = search.tools.find((part) => part.name === "glob")
  check(
    "T18.2 grep/glob sandbox search",
    grepPart?.state.status === "completed" && globPart?.state.status === "completed",
    `${grepPart?.state.status ?? "no grep"}/${globPart?.state.status ?? "no glob"}`,
  )
  check(
    "T18.2 grep matched sentinel",
    grepPart?.state.status === "completed" && toolContent(grepPart).includes("PROFILE_CARD_SENTINEL"),
    `${grepPart?.state.status}; ${toolContent(grepPart).slice(0, 300)}`,
  )
  check(
    "T18.2 glob lists both fixture files",
    globPart?.state.status === "completed" &&
      toolContent(globPart).includes("target.ts") &&
      toolContent(globPart).includes("empty.ts"),
    `${globPart?.state.status}; input=${JSON.stringify(globPart?.state?.input)}; ${toolContent(globPart).slice(0, 300)}`,
  )
  const wide = await prompt(
    fs,
    "只调用一次 grep 工具，path=/workspace/tools-check/wide，pattern 严格为 gtr-needle，limit=100；不要用 glob/read/shell 搜索。",
  )
  const widePart = wide.tools.find((part) => part.name === "grep")
  check(
    "T-GTR.1 wide match truncates",
    widePart?.state.status === "completed" &&
      widePart.state.metadata?.matches === 100 &&
      widePart.state.metadata?.truncated === true,
    `${widePart?.state.status}; input=${JSON.stringify(widePart?.state?.input)}; metadata=${JSON.stringify(widePart?.state?.metadata)}`,
  )

  // CodeMode session tool runtime + persistent custom tool projection.
  const customCode = `import { tool } from "@opencode-ai/plugin"\nexport default tool({ description: "Reverse input", args: { text: tool.schema.string().describe("Text") }, async execute(args) { return { title: "Reverse", output: args.text.split("").reverse().join("") } } })`
  const registered = await api(`/api/session/${fs}/tools`, "POST", {
    name: "reverse-text",
    description: "Reverse text",
    code: customCode,
  })
  const custom = await prompt(fs, "必须调用 reverse-text 工具，text 参数严格传 hello，然后告知结果。")
  const customPart = custom.tools.find((part) => part.name === "reverse-text")
  check(
    "T32 custom session tool invoked",
    registered.response.ok && customPart?.state.status === "completed",
    `${registered.response.status}; ${customPart?.state.status ?? "not called"}`,
  )
  check(
    "T32 custom result persisted",
    JSON.stringify(customPart?.state).includes("olleh"),
    JSON.stringify(customPart?.state?.metadata),
  )

  // Read not-found and missing shell commands should fail fast, not hang.
  const missingAt = Date.now()
  const missing = await prompt(
    fs,
    "用 shell 工具只执行命令 `tools-e2e-command-that-does-not-exist`，不要尝试别的命令。",
    60_000,
  )
  const missingShell = missing.tools.find((part) => part.name === "shell")
  check(
    "T18.9 missing shell command returns quickly",
    missingShell?.state.status === "completed" &&
      /not found|command not found/i.test(toolContent(missingShell)) &&
      Date.now() - missingAt < 30_000,
    `${missingShell?.state.status ?? "not called"}; ${toolContent(missingShell)}; ${Date.now() - missingAt}ms`,
  )

  // Session-tools title/error/isolation CRUD invariants.
  const second = await create("isolation")
  const otherTools = await api(`/api/session/${second}/tools`)
  check("T32 session-tool isolation", (otherTools.data?.data ?? []).length === 0)

  // Sandbox destruction must be observable in PG; the API path can rebuild on the next call.
  const killed = await api(`/api/session/${fs}/kill-sandbox`, "POST", {})
  const destroyed = pg(`select count(*) from sandbox where session_id='${escape(fs)}' and state='destroyed'`)
  check(
    "T18.10a kill-sandbox destroys sandbox",
    killed.response.ok && Number(destroyed) >= 1,
    `HTTP ${killed.response.status}; destroyed=${destroyed}`,
  )
  const afterKill = await prompt(
    fs,
    "只调用一次 glob 工具，path 严格填写 tools-check/src，pattern 严格填写 target.ts；报告找到的路径，不要调用其他工具。",
    120_000,
  )
  const recoveryGlob = afterKill.tools.find(
    (part) =>
      part.name === "glob" &&
      part.state.status === "completed" &&
      part.state.input?.path === "tools-check/src" &&
      part.state.input?.pattern === "target.ts",
  )
  check(
    "T18.10a new glob call recovers after sandbox kill",
    recoveryGlob !== undefined,
    afterKill.tools.map((part) => `${part.name}:${part.state.status}:${JSON.stringify(part.state.input)}`).join(","),
  )
  check(
    "T18.10a sandbox is running after recovery",
    pg(`select count(*) from sandbox where session_id='${escape(fs)}' and state='running'`) === "1",
  )

  // T-LZY.2: each shell request refreshes sandbox activity timestamp.
  const before = Number(pg(`select time_updated from sandbox where session_id='${escape(fs)}' and state='running'`))
  await shell(fs, "echo lzy-touch")
  const after = Number(pg(`select time_updated from sandbox where session_id='${escape(fs)}' and state='running'`))
  check(
    "T-LZY.2 sandbox activity timestamp advances",
    Number.isFinite(before) && Number.isFinite(after) && after > before,
    `${before} -> ${after}`,
  )
} catch (error) {
  console.error(`Tools E2E error: ${error instanceof Error ? error.stack : String(error)}`)
  failed++
} finally {
  for (const id of sessions) {
    try {
      const killed = await api(`/api/session/${id}/kill-sandbox`, "POST", {})
      assert(killed.response.ok, `sandbox cleanup ${id}: HTTP ${killed.response.status}`)
      assert.equal(pg(`select count(*) from sandbox where session_id='${escape(id)}' and state='running'`), "0")
      const result = await api(`/api/session/${id}`, "DELETE")
      assert([200, 204].includes(result.response.status), `cleanup ${id}: HTTP ${result.response.status}`)
    } catch (error) {
      console.error(`cleanup failed for ${id}: ${String(error)}`)
      failed++
    }
  }
}

console.log(`Summary: ${failed} failed assertion(s)`)
if (failed) process.exitCode = 1
