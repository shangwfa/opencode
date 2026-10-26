// files-api-v2 多 GB 压力补测：大体量工作区下的命令/浏览/搜索、停止快照、恢复与删除耗时。
// 通过 sandbox-vercel-t19.mjs 包装器运行（SSE、PG、清理证据）；耗时写入 STRESS_OUT。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"

const base = process.env.BASE.replace(/\/$/, "")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
}
const timings = []
const timed = async (name, fn) => {
  const started = Date.now()
  const value = await fn()
  timings.push({ name, ms: Date.now() - started })
  console.log(`⏱ ${name}: ${Date.now() - started} ms`)
  return value
}
const sql = (statement) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()
const binding = () => JSON.parse(sql(`SELECT json_build_object('id',id,'state',state,'remoteName',remote_name)::text FROM sandbox WHERE session_id='${id}'`))

const created = await fetch(`${base}/api/session`, { method: "POST", headers, body: JSON.stringify({ title: "files-api-stress-v2" }) })
assert.equal(created.status, 200)
const { data: session } = await created.json()
const id = session.id
const shell = async (command, timeoutMs = 600_000) => {
  const response = await fetch(`${base}/api/session/${id}/shell`, {
    method: "POST", headers, signal: AbortSignal.timeout(timeoutMs), body: JSON.stringify({ command }),
  })
  assert.equal(response.status, 204, `shell HTTP ${response.status}: ${command.slice(0, 60)}`)
}
const read = async (relative) => {
  const url = `${base}/api/session/${id}/fs/read/${relative.split("/").map(encodeURIComponent).join("/")}`
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) })
  return { status: response.status, body: response.status === 200 ? await response.text() : null }
}
const list = async (path) => {
  const url = new URL(`${base}/api/session/${id}/fs/list`)
  url.searchParams.set("path", path)
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) })
  return { status: response.status, data: response.status === 200 ? (await response.json()).data : null }
}

await timed("create 4 GiB workspace (2x2 GiB + 20k files)", () => shell(
  "mkdir -p /workspace/stress/tree && dd if=/dev/urandom of=/workspace/stress/big1.bin bs=1M count=2048 status=none && dd if=/dev/urandom of=/workspace/stress/big2.bin bs=1M count=2048 status=none && seq 1 20000 | xargs -P 8 -I{} touch /workspace/stress/tree/file-{}.txt && sha256sum /workspace/stress/big1.bin > /workspace/stress/big1.sha && ls /workspace/stress/tree | wc -l > /workspace/stress/tree.count",
))
const before = await read("stress/big1.sha")
assert.equal(before.status, 200)
const shaBefore = before.body.split(" ")[0]
assert.match(before.body, /^[0-9a-f]{64}\s/)
const treeCount = await read("stress/tree.count")
assert.equal(treeCount.body.trim(), "20000")

const rootList = await timed("fs/list direct children", () => list("stress"))
assert.equal(rootList.status, 200)
assert.deepEqual(rootList.data.map((entry) => entry.path).sort(), ["stress/big1.bin", "stress/big1.sha", "stress/big2.bin", "stress/tree", "stress/tree.count"].sort())
const found = await timed("fs/find across 20k-file tree", () => fetch(
  `${base}/api/session/${id}/fs/find?query=${encodeURIComponent("file-19??.txt")}&type=file&limit=50`, { headers, signal: AbortSignal.timeout(60_000) },
).then(async (response) => ({ status: response.status, data: (await response.json()).data })))
assert.equal(found.status, 200)
assert.equal(found.data.length, 50, "limit 截断 20k 树中的匹配")
const small = await timed("fs/read small file", () => read("stress/big1.sha"))
assert.equal(small.status, 200)
const limited = await timed("fs/read 2 GiB (expect 404 at 32 MiB cap)", () => read("stress/big1.bin"))
assert.equal(limited.status, 404)
console.log("✅ 大体量工作区浏览/搜索/读取上限正常")

const stopped = await timed("kill-sandbox stop+snapshot (4 GiB FS)", async () => {
  const response = await fetch(`${base}/api/session/${id}/kill-sandbox`, { method: "POST", headers, signal: AbortSignal.timeout(600_000) })
  assert.equal(response.status, 200, `kill HTTP ${response.status}`)
  return response
})
assert.equal(binding().state, "destroyed")
assert.equal((await list("stress")).status, 404)
console.log("✅ 4 GiB 工作区 kill-sandbox 完成，PG destroyed，浏览不重建")

await timed("resume from snapshot", () => shell("true"))
const resumed = binding()
assert.equal(resumed.state, "running")
const after = await timed("sha256 re-verify after resume", () => shell(
  "sha256sum /workspace/stress/big1.bin > /workspace/stress/big1.sha2 && ls /workspace/stress/tree | wc -l > /workspace/stress/tree.count2",
))
const shaAfter = await read("stress/big1.sha2")
assert.equal(shaAfter.status, 200)
assert.equal(shaAfter.body.split(" ")[0], shaBefore, "恢复后 2 GiB 文件 sha256 一致")
assert.equal((await read("stress/tree.count2")).body.trim(), "20000")
console.log("✅ 快照恢复后 2 GiB 文件与 2 万文件树完整")

const deleted = await timed("session delete + purge", async () => {
  const response = await fetch(`${base}/api/session/${id}`, { method: "DELETE", headers, signal: AbortSignal.timeout(600_000) })
  assert.ok([200, 204].includes(response.status), `delete HTTP ${response.status}`)
  return response
})
const final = binding()
assert.equal(final.state, "destroyed")
assert.equal(final.remoteName, null)
console.log("✅ 删除会话完成 purge，PG 保留 destroyed 记录")
await mkdir(process.env.STRESS_OUT, { recursive: true })
await writeFile(`${process.env.STRESS_OUT}/timings.json`, JSON.stringify({ timings }, null, 2))
console.log(`TIMINGS ${JSON.stringify(timings)}`)
