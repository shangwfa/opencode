// 补充用例：子会话与主会话共享连接器资源域（resolveOwner 语义）
const BASE = "http://127.0.0.1:14963"
const BASIC = "Basic " + Buffer.from("opencode:ab123456").toString("base64")
const BUN = "/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode/connector-e2e/bun142/node_modules/.bin/bun"
const PSQL = (sql) => {
  const proc = Bun.spawnSync(["psql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "opencode-v2-up", "-At", "-c", sql], {
    env: { ...process.env, PGPASSWORD: "postgres" },
  })
  return proc.stdout.toString().trim()
}
const json = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: BASIC, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}
const bypassCreate = async () => {
  const proc = Bun.spawnSync([BUN, import.meta.dirname + "/bypass-engine.mjs", "create"], {
    env: { ...process.env, TMPDIR: "/tmp" }, stdout: "pipe", stderr: "pipe",
  })
  const parsed = JSON.parse(proc.stdout.toString())
  return { engineId: parsed.body.data.id, engineName: parsed.body.data.alias }
}
const results = []
const record = (id, name, expected, actual, pass) => {
  results.push({ id, pass })
  console.log(`${pass ? "✅" : "❌"} [${id}] ${name} → 预期 ${expected}；实际 ${actual}`)
}

// 主会话 + 子会话
const parent = (await json("POST", "/api/session", { title: "connector-parent" })).body.data.id
const child = (await json("POST", "/api/session", { title: "connector-child", parentID: parent })).body.data.id
record("s1", "创建主/子会话", "两个 id", `parent=${parent.slice(0, 14)}... child=${child.slice(0, 14)}...`, !!parent && !!child)

// 子会话域建连（旁路 + 插行 session_id=child → 落库归 root=parent）
const bp = await bypassCreate()
const now = Date.now()
const ccon = "ccon_" + crypto.randomUUID().replaceAll("-", "")
PSQL(`insert into connector_connection (id, session_id, engine_connection_id, engine_connection_name, service, alias, auth_type, status, time_created, time_updated) values ('${ccon}', '${parent}', '${bp.engineId}', '${bp.engineName}', 'postmark', 'child-created', 'api_key', 'active', ${now}, ${now})`)
record("s2", "插行（按 root=parent 落库）", "1 行", "ok", true)

// 子会话 list 应看到（resolveOwner(child) = parent）
const childList = await json("GET", `/api/session/${child}/connector/connections`)
record("s3", "子会话列表可见主会话连接", "200 且 1 条", `status=${childList.status} count=${childList.body?.connections?.length}`, childList.status === 200 && childList.body?.connections?.length === 1)
// 主会话 list 同样可见
const parentList = await json("GET", `/api/session/${parent}/connector/connections`)
record("s4", "主会话列表可见", "200 且 1 条", `status=${parentList.status} count=${parentList.body?.connections?.length}`, parentList.status === 200 && parentList.body?.connections?.length === 1)

// 子会话 attach → token
const childAttach = await json("POST", `/api/session/${child}/connector/mcp`)
record("s5", "子会话 attach", "200", `status=${childAttach.status}`, childAttach.status === 200)

// 子会话删主会话的连接 → 允许（同资源域）——与 f3（跨域 404）形成对照
const delByChild = await json("DELETE", `/api/session/${child}/connector/connections/${ccon}`)
record("s6", "子会话删同域连接（对照 f3 跨域 404）", "204", `status=${delByChild.status}`, delByChild.status === 204)
record("s7", "删后引擎 connections 清行", "0", PSQL(`select count(*) from connector.connections where id='${bp.engineId}'`), PSQL(`select count(*) from connector.connections where id='${bp.engineId}'`) === "0")

// 清理
await json("DELETE", `/api/session/${child}`)
await json("DELETE", `/api/session/${parent}`)
const failed = results.filter((r) => !r.pass).length
console.log(`\n子会话资源域用例：${results.length - failed}/${results.length} 通过`)
process.exit(failed ? 1 : 0)
