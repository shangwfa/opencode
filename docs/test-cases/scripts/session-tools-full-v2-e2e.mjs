import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { spawnSync } from "node:child_process"

const base = (process.env.BASE ?? "http://127.0.0.1:14296").replace(/\/$/, "")
const pgURL = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-test"
const model = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const headers = {
  "content-type": "application/json",
  ...(process.env.OPENCODE_PASSWORD
    ? { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}` }
    : {}),
}
const sessions = new Set()
const results = []
const code = (description, body, args = "") => `import {tool} from "@opencode-ai/plugin"
export default tool({description:${JSON.stringify(description)},args:{${args}},async execute(args){${body}}})`
const str = (key = "text") => `${key}:tool.schema.string().describe(${JSON.stringify(key)})`
const num = (key) => `${key}:tool.schema.number().describe(${JSON.stringify(key)})`
const boolean = (key) => `${key}:tool.schema.boolean().describe(${JSON.stringify(key)})`

function pg(query) {
  const result = spawnSync("psql", [pgURL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
async function api(path, method = "GET", body, allow = []) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(180_000),
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  assert(
    response.ok || allow.includes(response.status),
    `${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`,
  )
  return { response, text, data }
}
async function createSession(label) {
  const result = await api("/api/session", "POST", {
    title: `T32-${label}-${Date.now()}`,
    model,
    location: { directory: "/workspace" },
  })
  const id = result.data?.data?.id
  assert(id, `session create did not return id: ${JSON.stringify(result.data)}`)
  sessions.add(id)
  return id
}
async function tools(id) {
  return (await api(`/api/session/${id}/tools`)).data.data
}
async function register(id, name, description, source) {
  return api(`/api/session/${id}/tools`, "POST", { name, description, code: source }, [400, 404])
}
async function prompt(id, text) {
  const before = new Set(
    (await api(`/api/session/${id}/message?order=asc&limit=200`)).data.data.flatMap((message) =>
      message.type === "assistant" ? (message.content ?? []).filter((part) => part.type === "tool").map((part) => part.id) : [],
    ),
  )
  const response = await fetch(`${base}/api/session/${id}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(180_000),
  })
  const stream = await response.text()
  assert(response.ok, `prompt failed HTTP ${response.status}: ${stream.slice(0, 400)}`)
  const rows = (await api(`/api/session/${id}/message?order=asc&limit=200`)).data.data
  const calls = rows.flatMap((message) =>
    message.type === "assistant"
      ? (message.content ?? []).filter((part) => part.type === "tool" && !before.has(part.id))
      : [],
  )
  return { stream, rows, calls }
}
async function shell(id, command) {
  const result = await api(`/api/session/${id}/shell`, "POST", { command })
  const deadline = Date.now() + 90_000
  assert([200, 204].includes(result.response.status), `shell failed HTTP ${result.response.status}: ${result.text}`)
  while (Date.now() < deadline) {
    const rows = (await api(`/api/session/${id}/message?order=asc&limit=200`)).data.data
    const latest = rows.findLast((message) => message.type === "shell")
    if (latest?.time?.completed != null) return latest
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`shell timed out: ${command}`)
}
function output(call) {
  const content = call?.state?.content
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      : ""
}
function callsFor(result, name) {
  return result.calls.filter((call) => call.name === name)
}
function pass(id, name, evidence = "") {
  results.push({ id, passed: true, evidence })
  console.log(`✅ ${id}${evidence ? ` — ${evidence}` : ""}`)
}
function verify(id, condition, evidence = "") {
  if (!condition) {
    results.push({ id, passed: false, evidence })
    console.error(`❌ ${id}${evidence ? ` — ${evidence}` : ""}`)
    return false
  }
  pass(id, id, evidence)
  return true
}
function auditEntries(id) {
  const file = process.env.MODEL_REQUEST_LOG_FILE
  if (!file) return []
  try {
    return fs.readFile(file, "utf8").then((text) =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse)
        .filter((entry) => entry.sessionID === id && entry.kind === "primary"),
    )
  } catch {
    return Promise.resolve([])
  }
}

try {
  if (process.env.ONLY !== "T32.29") {
    // T32.1–9 CRUD contract: create, ordered list, upsert, delete, clear, isolation, cascade, validation, missing session.
    const crud = await createSession("crud")
    const toolCode = `export default {description:"ok",args:{},execute(){return "ok"}}`
    const first = await register(crud, "zeta", "first", toolCode)
    verify(
      "T32.1",
      first.response.ok &&
        first.data.id.startsWith("stl_") &&
        pg(
          `select count(*) from session_tools where session_id='${crud}' and name='zeta' and code='${toolCode.replaceAll("'", "''")}'`,
        ) === "1",
    )
    await register(crud, "alpha", "alpha", toolCode)
    verify("T32.2", (await tools(crud)).map((item) => item.name).join(",") === "alpha,zeta")
    const updatedCode = `export default {description:"updated",args:{},execute(){return "updated"}}`
    const updated = await register(crud, "zeta", "updated", updatedCode)
    verify(
      "T32.3",
      updated.data.description === "updated" && updated.data.code === updatedCode && (await tools(crud)).length === 2,
    )
    const deleteOne = await api(`/api/session/${crud}/tools/alpha`, "DELETE")
    verify(
      "T32.4",
      deleteOne.response.ok &&
        !(await tools(crud)).some((item) => item.name === "alpha") &&
        pg(`select count(*) from session_tools where session_id='${crud}' and name='alpha'`) === "0",
    )
    await register(crud, "a", "a", toolCode)
    await register(crud, "b", "b", toolCode)
    const clear = await api(`/api/session/${crud}/tools`, "DELETE")
    verify(
      "T32.5",
      clear.response.ok &&
        (await tools(crud)).length === 0 &&
        pg(`select count(*) from session_tools where session_id='${crud}'`) === "0",
    )
    const isolated = await createSession("isolation")
    await register(crud, "same", "root", toolCode)
    await register(isolated, "same", "other", toolCode)
    verify("T32.6", (await tools(crud))[0].description === "root" && (await tools(isolated))[0].description === "other")
    const cascade = await createSession("cascade")
    await register(cascade, "cascade-tool", "cascade", toolCode)
    const deletedSession = await api(`/api/session/${cascade}`, "DELETE")
    sessions.delete(cascade)
    verify(
      "T32.7",
      deletedSession.response.ok &&
        (await api(`/api/session/${cascade}/tools`, "GET", undefined, [404])).response.status === 404 &&
        pg(`select count(*) from session_tools where session_id='${cascade}'`) === "0",
    )
    const invalidMissing = await Promise.all([
      api(`/api/session/${crud}/tools`, "POST", { description: "x", code: toolCode }, [400]),
      api(`/api/session/${crud}/tools`, "POST", { name: "x", code: toolCode }, [400]),
      api(`/api/session/${crud}/tools`, "POST", { name: "x", description: "x" }, [400]),
    ])
    verify(
      "T32.8",
      invalidMissing.every((item) => item.response.status === 400),
    )
    const nonexistent = "ses_NOTEXIST"
    const missingCreate = await api(
      `/api/session/${nonexistent}/tools`,
      "POST",
      { name: "x", description: "x", code: toolCode },
      [404],
    )
    const missingList = await api(`/api/session/${nonexistent}/tools`, "GET", undefined, [404])
    verify("T32.9 V2 contract", missingCreate.response.status === 404 && missingList.response.status === 404)

    const session = await createSession("runtime")
    // T32.10 visible to model + real execution.
    await register(
      session,
      "add-numbers",
      "Calculate the sum of two numbers",
      code("Calculate sum", `return {title:"Sum",output:String(args.a+args.b)}`, `${num("a")},${num("b")}`),
    )
    let result = await prompt(session, "必须调用 add-numbers 一次，a=3,b=5，收到工具结果后只报告答案。")
    verify(
      "T32.10",
      callsFor(result, "add-numbers").some((call) => call.state.status === "completed" && output(call).includes("8")),
    )
    // T32.11 model sees and calls custom tool.
    await register(
      session,
      "reverse-text",
      "Reverse input",
      code("Reverse text", `return {title:"Reverse",output:args.text.split("").reverse().join("")}`, str()),
    )
    result = await prompt(session, "必须调用 reverse-text 一次，text=hello，告诉我结果。")
    verify(
      "T32.11",
      callsFor(result, "reverse-text").some(
        (call) => call.state.status === "completed" && output(call).includes("olleh"),
      ),
    )
    // T32.12 invalid syntax does not block a valid neighboring tool.
    await register(session, "broken-tool", "broken", "export default {{{{ invalid")
    await register(
      session,
      "greet",
      "greet",
      code("Greeting", `return {title:"Greet",output:"Hello from session tool!"}`),
    )
    result = await prompt(session, "必须调用 greet 一次打招呼，不要调用 broken-tool。")
    verify(
      "T32.12",
      callsFor(result, "greet").some(
        (call) => call.state.status === "completed" && output(call).includes("Hello from session tool"),
      ) && !(await auditEntries(session)).some((entries) => entries.toolNames.includes("broken-tool")),
    )
    // T32.13 full create -> execute -> list -> delete.
    const workflow = await createSession("workflow")
    const convertCode = code(
      "Convert Celsius to Fahrenheit",
      `return {title:"Convert",output:args.celsius*9/5+32+"F"}`,
      num("celsius"),
    )
    await register(workflow, "c-to-f", "Convert Celsius to Fahrenheit", convertCode)
    result = await prompt(workflow, "调用 c-to-f 一次，将 100 摄氏度转换为华氏度。")
    const workflowList = await tools(workflow)
    await api(`/api/session/${workflow}/tools/c-to-f`, "DELETE")
    verify(
      "T32.13",
      callsFor(result, "c-to-f").some((call) => call.state.status === "completed" && output(call).includes("212")) &&
        workflowList.some((item) => item.name === "c-to-f") &&
        !(await tools(workflow)).some((item) => item.name === "c-to-f"),
    )
    // T32.14 persisted schema helper source.
    const typed = await createSession("schema")
    const typedCode = code(
      "Profile",
      `return {title:"Profile",output:args.name+" is "+args.age+", active="+args.active}`,
      `${str("name")},${num("age")},${boolean("active")}`,
    )
    const typedTool = await register(typed, "profile", "Profile", typedCode)
    verify(
      "T32.14",
      typedTool.response.ok &&
        ["string", "number", "boolean"].every((type) => typedTool.data.code.includes(`tool.schema.${type}`)),
    )
    // T32.15 current V2 schema rejects empty and unsafe names.
    const emptyName = await register(typed, "", "empty", toolCode)
    const unsafeName = await register(typed, "bad name", "unsafe", toolCode)
    verify("T32.15 V2 contract", emptyName.response.status === 400 && unsafeName.response.status === 400)
    // T32.16 user tools must not disturb canonical shell.
    for (const name of ["extra-1", "extra-2", "extra-3"]) await register(session, name, name, toolCode)
    result = await prompt(session, "用 shell 工具只执行 echo BUILTIN_STILL_WORKS，并停止。")
    const shellCall = callsFor(result, "shell")[0]
    verify(
      "T32.16",
      shellCall?.state.status === "completed" && JSON.stringify(shellCall.state).includes("BUILTIN_STILL_WORKS"),
    )
    // T32.17 strict timestamp semantics.
    const timestamps = await createSession("timestamps")
    const timestampCode1 = "// timestamp-v1"
    const timestampCode2 = "// timestamp-v2"
    const time1 = (await register(timestamps, "ts-tool", "v1", timestampCode1)).data.time
    await new Promise((resolve) => setTimeout(resolve, 20))
    const time2 = (await register(timestamps, "ts-tool", "v2", timestampCode2)).data.time
    verify(
      "T32.17",
      time1.created === time1.updated && time2.created === time1.created && time2.updated > time1.updated,
    )
    // T32.18 and T32.19 idempotency.
    verify("T32.18", (await api(`/api/session/${timestamps}/tools/nonexistent-tool`, "DELETE")).response.ok)
    const empty = await createSession("empty")
    verify(
      "T32.19",
      (await api(`/api/session/${empty}/tools`, "DELETE")).response.ok && (await tools(empty)).length === 0,
    )
    // T32.20 failed tool does not prevent subsequent healthy tool execution.
    const crashCode = code("Always fail", `throw new Error("Simulated tool failure: "+args.input)`, str("input"))
    await register(session, "crash-tool", "Always fail", crashCode)
    await register(
      session,
      "safe-tool",
      "Return greeting",
      code("Safe greeting", `return {title:"Greet",output:"Hello!"}`),
    )
    result = await prompt(session, "先调用 crash-tool 一次 input=test，再调用 safe-tool 一次。两个工具之后停止。")
    verify(
      "T32.20",
      callsFor(result, "crash-tool").some(
        (call) => call.state.status === "error" && JSON.stringify(call.state).includes("Simulated tool failure"),
      ) &&
        callsFor(result, "safe-tool").some(
          (call) => call.state.status === "completed" && output(call).includes("Hello!"),
        ),
    )
    // T32.21 title and output semantics.
    const title = await createSession("title")
    await register(
      title,
      "title-tool",
      "Title",
      code("Greet by name", `return {title:"Greeted "+args.name,output:"Hello, "+args.name+"!"}`, str("name")),
    )
    result = await prompt(title, "调用 title-tool 一次，name=World。")
    const titleCall = callsFor(result, "title-tool")[0]
    verify(
      "T32.21",
      titleCall?.state.status === "completed" &&
        titleCall.state.metadata?.title === "Greeted World" &&
        output(titleCall) === "Hello, World!",
    )
    // T32.22 both tools selected, parallel calls are permitted.
    const multi = await createSession("multi")
    await register(
      multi,
      "add",
      "Add",
      code("Add two numbers", `return {title:"Add",output:String(args.a+args.b)}`, `${num("a")},${num("b")}`),
    )
    await register(
      multi,
      "multiply",
      "Multiply",
      code("Multiply two numbers", `return {title:"Multiply",output:String(args.a*args.b)}`, `${num("a")},${num("b")}`),
    )
    result = await prompt(multi, "必须分别调用 add 一次计算 10+20，并调用 multiply 一次计算 5*6；不要遗漏任何一个。")
    verify(
      "T32.22",
      callsFor(result, "add").some((call) => call.state.status === "completed" && output(call).includes("30")) &&
        callsFor(result, "multiply").some((call) => call.state.status === "completed" && output(call).includes("30")),
    )
    // T32.23 direct PG counts after every API mutation.
    const pgSession = await createSession("pg")
    const pgA = await register(pgSession, "pg-verify-a", "A", "// a")
    const pgB = await register(pgSession, "pg-verify-b", "B", "// b")
    const count2 = pg(`select count(*) from session_tools where session_id='${pgSession}'`)
    const pgList = await tools(pgSession)
    await api(`/api/session/${pgSession}/tools/pg-verify-a`, "DELETE")
    const count1 = pg(`select count(*) from session_tools where session_id='${pgSession}'`)
    await api(`/api/session/${pgSession}/tools`, "DELETE")
    const count0 = pg(`select count(*) from session_tools where session_id='${pgSession}'`)
    verify(
      "T32.23",
      pgA.data.id && pgB.data.id && pgList.length === 2 && count2 === "2" && count1 === "1" && count0 === "0",
    )
    // T32.24 collision with native shell, then removing overlay restores native behavior.
    const override = code(
      "Shell override",
      `return {title:"Override",output:"SESSION_BASH_OVERRIDE:"+args.command}`,
      str("command"),
    )
    await register(session, "shell", "Shell override", override)
    result = await prompt(session, "必须调用 shell 一次，command=echo SHOULD_NOT_RUN。")
    const overridden = callsFor(result, "shell")[0]
    const markerFromOverride =
      overridden?.state.status === "completed" && JSON.stringify(overridden.state).includes("SESSION_BASH_OVERRIDE")
    await api(`/api/session/${session}/tools/shell`, "DELETE")
    result = await prompt(session, "调用内置 shell 工具执行 echo FALLBACK_SHELL_OK，并停止。")
    const fallback = callsFor(result, "shell")[0]
    verify(
      "T32.24",
      markerFromOverride &&
        fallback?.state.status === "completed" &&
        JSON.stringify(fallback.state).includes("FALLBACK_SHELL_OK") &&
        !JSON.stringify(fallback.state).includes("SESSION_BASH_OVERRIDE"),
    )
    // T32.27 invalid export persists but never enters the advertised tool catalog.
    const invalid = await createSession("invalid-export")
    await register(invalid, "not-a-tool", "Invalid export", "export default {foo: 'bar'}")
    await register(invalid, "good-tool", "Good", code("Good tool", `return {title:"Good",output:"GOOD_TOOL_OK"}`))
    result = await prompt(invalid, "必须调用 good-tool 一次，之后停止。")
    const invalidAudit = await auditEntries(invalid)
    verify(
      "T32.27",
      (await tools(invalid)).some((item) => item.name === "not-a-tool") &&
        callsFor(result, "good-tool").some(
          (call) => call.state.status === "completed" && output(call).includes("GOOD_TOOL_OK"),
        ) &&
        invalidAudit.length > 0 &&
        invalidAudit.every((entry) => !entry.toolNames.includes("not-a-tool") && entry.toolNames.includes("good-tool")),
    )
    // T32.28 upsert publishes a new code hash for the next request.
    const hot = await createSession("hot-update")
    const version = (n) => code(`Version ${n}`, `return {title:"Version",output:"VERSION_${n}"}`)
    await register(hot, "version-tool", "Version 1", version(1))
    const firstVersion = await prompt(hot, "调用 version-tool 一次，之后停止。")
    await register(hot, "version-tool", "Version 2", version(2))
    const secondVersion = await prompt(hot, "再次调用 version-tool 一次，之后停止。")
    verify(
      "T32.28",
      callsFor(firstVersion, "version-tool").some(
        (call) => call.state.status === "completed" && output(call).includes("VERSION_1"),
      ) &&
        callsFor(secondVersion, "version-tool").some(
          (call) => call.state.status === "completed" && output(call).includes("VERSION_2"),
        ) &&
        !callsFor(secondVersion, "version-tool").some((call) => JSON.stringify(call.state).includes("VERSION_1")),
    )
  }
  // T32.29 three-layer collision: Sandbox .opencode > Session API > Location/global builtin.
  const priority = await createSession("source-priority")
  const sessionShell = code(
    "Session shell override",
    `return {title:"Session",output:"SESSION_SHELL_OVERRIDE"}`,
    str("command"),
  )
  await register(priority, "shell", "Session shell override", sessionShell)
  const projectShell = code(
    "Project .opencode shell override",
    `return {title:"Sandbox project",output:"SANDBOX_OPENCODE_OVERRIDE"}`,
    str("command"),
  )
  await register(
    priority,
    "seed-project-shell",
    "Create the project .opencode tool file",
    code(
      "Create project tool",
      `const fs=await import("node:fs/promises");await fs.mkdir("/workspace/.opencode/tool",{recursive:true});await fs.writeFile("/workspace/.opencode/tool/shell.ts",${JSON.stringify(projectShell)});return "PROJECT_TOOL_SEEDED"`,
    ),
  )
  const seeded = await prompt(priority, "必须调用 seed-project-shell 一次创建工具文件，然后停止。")
  const seedCall = callsFor(seeded, "seed-project-shell")[0]
  const projectFile = await shell(priority, "cat /workspace/.opencode/tool/shell.ts")
  await api(`/api/session/${priority}/tools/seed-project-shell`, "DELETE")
  const sandboxSelected = await prompt(priority, "必须调用 shell 一次，command=echo ignored，并停止。")
  const sandboxCall = callsFor(sandboxSelected, "shell")[0]
  const sandboxWon =
    seedCall?.state.status === "completed" &&
    output(seedCall).includes("PROJECT_TOOL_SEEDED") &&
    sandboxCall?.state.status === "completed" &&
    output(sandboxCall).includes("SANDBOX_OPENCODE_OVERRIDE")
  await register(
    priority,
    "remove-project-shell",
    "Remove the project .opencode tool file",
    code(
      "Remove project tool",
      `const fs=await import("node:fs/promises");await fs.rm("/workspace/.opencode/tool/shell.ts",{force:true});return "PROJECT_TOOL_REMOVED"`,
    ),
  )
  const removed = await prompt(priority, "必须调用 remove-project-shell 一次，然后停止。")
  await api(`/api/session/${priority}/tools/remove-project-shell`, "DELETE")
  const sessionSelected = await prompt(priority, "必须调用 shell 一次，command=echo ignored，并停止。")
  const sessionCall = callsFor(sessionSelected, "shell")[0]
  await api(`/api/session/${priority}/tools/shell`, "DELETE")
  const globalSelected = await prompt(priority, "调用 shell 工具执行 echo GLOBAL_SHELL_FALLBACK，并停止。")
  const globalCall = callsFor(globalSelected, "shell")[0]
  verify(
    "T32.29",
    removed.calls.some(
      (call) =>
        call.name === "remove-project-shell" &&
        call.state.status === "completed" &&
        output(call).includes("PROJECT_TOOL_REMOVED"),
    ) &&
      sandboxWon &&
      sessionCall?.state.status === "completed" &&
      output(sessionCall).includes("SESSION_SHELL_OVERRIDE") &&
      globalCall?.state.status === "completed" &&
      JSON.stringify(globalCall.state).includes("GLOBAL_SHELL_FALLBACK") &&
      !JSON.stringify(globalCall.state).includes("SESSION_SHELL_OVERRIDE") &&
      pg(`select count(*) from session_tools where session_id='${priority}' and name='shell'`) === "0",
    JSON.stringify({
      removed: removed.calls.map((call) => ({ name: call.name, status: call.state.status, output: output(call) })),
      seed: { status: seedCall?.state.status, output: output(seedCall) },
      projectFile: { exit: projectFile.exit, output: projectFile.output?.output },
      sandboxCall: { status: sandboxCall?.state.status, input: sandboxCall?.state.input, output: output(sandboxCall) },
      sandboxWon,
      session: { status: sessionCall?.state.status, output: output(sessionCall) },
      global: { status: globalCall?.state.status, output: output(globalCall) },
      sessionRows: pg(`select count(*) from session_tools where session_id='${priority}' and name='shell'`),
    }),
  )
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  results.push({ id: "fatal", passed: false, evidence: error instanceof Error ? error.message : String(error) })
  process.exitCode = 1
} finally {
  for (const id of sessions) {
    try {
      const killed = await api(`/api/session/${id}/kill-sandbox`, "POST", {})
      assert.equal(killed.response.ok, true, `sandbox cleanup failed: HTTP ${killed.response.status}`)
      assert.equal(
        pg(`select count(*) from sandbox where session_id='${id}' and state='running'`),
        "0",
        `sandbox still running for session ${id}`,
      )
      await api(`/api/session/${id}`, "DELETE")
    } catch (error) {
      console.error(`清理 session ${id} 失败: ${String(error)}`)
      results.push({ id: "cleanup", passed: false, evidence: String(error) })
      process.exitCode = 1
    }
  }
  const report = {
    base,
    pgURL,
    model,
    results,
    passed: results.filter((value) => value.passed).length,
    failed: results.filter((value) => !value.passed).length,
    skipped: ["T32.25", "T32.26"],
  }
  if (process.env.REPORT) await fs.writeFile(process.env.REPORT, JSON.stringify(report, null, 2))
  console.log(`T32 汇总：${report.passed} passed, ${report.failed} failed；T32.25/26 文档标记为历史移除，跳过。`)
  if (report.failed) process.exitCode = 1
}
