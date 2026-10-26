// files-api-v2 边界补测：大文件、符号链接语义、并发 kill/浏览、kill 后恢复的文件持久化。
// 通过 sandbox-vercel-t19.mjs 包装器运行（提前订阅公共 SSE、留存 PG 与清理证据）。
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

const base = process.env.BASE.replace(/\/$/, "")
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`,
}
const pg = (statement) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", statement], { encoding: "utf8" }).trim()

const created = await fetch(`${base}/api/session`, { method: "POST", headers, body: JSON.stringify({ title: "files-api-edge-v2" }) })
assert.equal(created.status, 200)
const { data: session } = await created.json()
const id = session.id
const binding = () => JSON.parse(pg(`SELECT json_build_object('id',id,'provider',provider,'state',state,'remoteName',remote_name)::text FROM sandbox WHERE session_id='${id.replaceAll("'", "''")}'`))
const shell = async (command) => {
  const response = await fetch(`${base}/api/session/${id}/shell`, {
    method: "POST", headers, signal: AbortSignal.timeout(120_000), body: JSON.stringify({ command }),
  })
  assert.equal(response.status, 204, `shell ${command.slice(0, 40)}: HTTP ${response.status}`)
}
const list = async (path = ".") => {
  const url = new URL(`${base}/api/session/${id}/fs/list`)
  url.searchParams.set("path", path)
  const response = await fetch(url, { headers })
  return { status: response.status, data: response.status === 200 ? (await response.json()).data : null }
}
const read = async (relative) => {
  const url = `${base}/api/session/${id}/fs/read/${relative.split("/").map(encodeURIComponent).join("/")}`
  const response = await fetch(url, { headers })
  return { status: response.status, contentType: response.headers.get("content-type"), bytes: response.status === 200 ? Buffer.from(await response.arrayBuffer()) : null }
}

const marker = `edge-marker-${Date.now()}\n`
await shell(`mkdir -p /workspace/edge && printf '${marker.replace("\n", "\\n")}' > /workspace/edge/marker.txt`)
assert.equal(binding().state, "running")
console.log("✅ shell 夹具创建并 boot 沙箱")

await shell("dd if=/dev/urandom of=/workspace/edge/big.bin bs=1048576 count=8 2>/dev/null && sha256sum /workspace/edge/big.bin > /workspace/edge/big.sha")
const shaFile = await read("edge/big.sha")
assert.equal(shaFile.status, 200)
const expectedSha = shaFile.bytes.toString("utf8").split(" ")[0]
const big = await read("edge/big.bin")
assert.equal(big.status, 200)
assert.equal(big.contentType, "application/octet-stream")
assert.equal(big.bytes.length, 8 * 1048576)
assert.equal(createHash("sha256").update(big.bytes).digest("hex"), expectedSha)
console.log("✅ 8 MiB 二进制读取逐字节一致（sha256 校验）")

await shell("dd if=/dev/urandom of=/workspace/edge/huge.bin bs=1048576 count=40 2>/dev/null")
const huge = await read("edge/huge.bin")
assert.equal(huge.status, 404, `超过 32 MiB 读取上限应返回 404，实际 ${huge.status}`)
console.log("✅ 40 MiB 文件按 32 MiB 读取上限返回 404（文档化限制）")

await shell("ln -s /etc/hostname /workspace/edge/escape && ln -s /etc /workspace/edge/lnkdir")
const escape = await read("edge/escape")
assert.equal(escape.status, 200, `符号链接文件读取应与 shell 语义一致返回 200，实际 ${escape.status}`)
assert.ok(escape.bytes.length > 0)
const linkDir = await list("edge/lnkdir")
assert.equal(linkDir.status, 200)
console.log(`✅ 符号链接语义：read 跟随目标（${escape.bytes.length} 字节）、list 返回 ${linkDir.data.length} 项（文件 API 与 shell 同权限，不构成提权）`)

await shell("sleep 30")
const browseBefore = list("edge")
const browseKill = fetch(`${base}/api/session/${id}/kill-sandbox`, { method: "POST", headers, signal: AbortSignal.timeout(120_000) })
const [duringList, duringRead, killed] = await Promise.all([browseBefore, read("edge/marker.txt"), browseKill])
assert.equal(killed.status, 200)
assert.ok([200, 404].includes(duringList.status), `并发浏览出现异常状态 ${duringList.status}`)
assert.ok([200, 404].includes(duringRead.status), `并发读取出现异常状态 ${duringRead.status}`)
const afterKill = await list("edge")
const finalBinding = binding()
assert.equal(afterKill.status, 404, "kill 后浏览不得隐式重建")
assert.equal(finalBinding.state, "destroyed")
console.log(`✅ 并发 kill/浏览：无 5xx（浏览 ${duringList.status}、读取 ${duringRead.status}），kill 后 404，PG 保持 ${finalBinding.id} destroyed`)

const beforeResume = finalBinding
await shell("true")
const resumed = binding()
assert.equal(resumed.state, "running")
assert.notEqual(resumed.id, beforeResume, "恢复后应为新运行代次")
assert.equal(resumed.remoteName, beforeResume.remoteName, "kill→resume 保留稳定远端身份，只有 purge 清空")
const markerAfter = await read("edge/marker.txt")
assert.equal(markerAfter.status, 200)
assert.equal(markerAfter.bytes.toString("utf8"), marker)
const bigAfter = await read("edge/big.bin")
assert.equal(bigAfter.status, 200)
assert.equal(createHash("sha256").update(bigAfter.bytes).digest("hex"), expectedSha)
const root = await list(".")
assert.ok(root.data.some((entry) => entry.path === "edge" && entry.type === "directory"))
console.log("✅ kill→resume：marker 与 8 MiB 文件经快照恢复逐字节一致，代次已更新")
