// 补充文件搜索契约；通过同一 SSE 包装器运行，保留原 files-api-v2.mjs 不变。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE.replace(/\/$/, "")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
}
const created = await fetch(`${base}/api/session`, { method: "POST", headers, body: JSON.stringify({ title: "files-api-glob-v2" }) })
assert.equal(created.status, 200)
const { data: session } = await created.json()
const id = session.id
const binding = () => JSON.parse(execFileSync("psql", [process.env.PG_URL, "-XAtq", "-c",
  `SELECT json_build_object('id',id,'provider',provider,'state',state,'remoteName',remote_name)::text FROM sandbox WHERE session_id='${id.replaceAll("'", "''")}'`,
], { encoding: "utf8" }).trim())
const shell = await fetch(`${base}/api/session/${id}/shell`, {
  method: "POST", headers, signal: AbortSignal.timeout(90_000),
  body: JSON.stringify({ command: "mkdir -p /workspace/glob-v2/nested && touch /workspace/glob-v2/nested/readme.txt /workspace/glob-v2/notes.txt /workspace/glob-v2/.hidden.txt /workspace/glob-v2/data.bin \"/workspace/glob-v2/literal'quote.txt\"" }),
})
assert.equal(shell.status, 204)
const before = binding()
assert.equal(before.provider, "vercel")
assert.equal(before.state, "running")
async function find(query, type = "file", limit = 100) {
  const url = new URL(`${base}/api/session/${id}/fs/find`)
  for (const [key, value] of Object.entries({ query, type, limit })) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers })
  assert.equal(response.status, 200, `find ${query}: HTTP ${response.status}`)
  return (await response.json()).data
}
assert.deepEqual((await find("*.txt")).map(x => x.path).sort(), [
  "glob-v2/.hidden.txt", "glob-v2/literal'quote.txt", "glob-v2/nested/readme.txt", "glob-v2/notes.txt",
])
console.log("✅ fs.find glob: *.txt 命中嵌套、隐藏和带引号文件")
assert.deepEqual(await find("readme"), [], "完整名称匹配，不做子串搜索")
assert.deepEqual(await find("r?adme.[t]xt"), [{ path: "glob-v2/nested/readme.txt", type: "file" }])
assert.deepEqual(await find("literal'quote.txt"), [{ path: "glob-v2/literal'quote.txt", type: "file" }])
assert.deepEqual(await find("nest*", "directory"), [{ path: "glob-v2/nested", type: "directory" }])
assert.equal((await find("*.txt", "file", 1)).length, 1)
assert.deepEqual(binding(), before)
console.log("✅ fs.find: ?/字符类、精确匹配、directory 过滤、limit；PG 代次与绑定未改变")
const removed = await fetch(`${base}/api/session/${id}`, { method: "DELETE", headers })
assert.ok([200, 204].includes(removed.status))
assert.equal(binding().state, "destroyed")
assert.equal(binding().remoteName, null)
