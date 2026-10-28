// read-peer-sandbox.md T22.1–T22.3（V2 端点映射：exec→shell，files/download→fs/read）
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const results = []
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const t = async (id, fn) => { try { await fn(); results.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }
const create = async (title) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title, location: { directory: "/workspace" } }) })).json()).data.id
const sh = async (id, command) => {
  await fetch(base + `/api/session/${id}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command, timeoutSeconds: 60 }) })
  return q(`select data from session_message where session_id='${id}' and type='shell' order by time_created desc limit 1`)
}
const out = (data) => String(JSON.parse(data).output?.output ?? "")

const A = await create("peer-A")
const B = await create("peer-B")
try {
  await t("T22.1 A 复用 B 沙箱列文件，B 沙箱不重建", async () => {
    const mk = out(await sh(B, `mkdir -p /workspace/src && printf 'export const api = "v1"' > /workspace/src/index.ts && printf 'console.log(42)' > /workspace/src/main.ts && echo ok`))
    assert.ok(mk.includes("ok"), `B 造文件失败：${mk.slice(0, 100)}`)
    const list = out(await sh(B, `find /workspace/src -type f -name "*.ts" | sort`))
    assert.ok(list.includes("index.ts") && list.includes("main.ts"), `清单缺失：${list.slice(0, 100)}`)
    const count = q(`SELECT COUNT(*) FROM sandbox WHERE session_id='${B}'`)
    assert.ok(Number(count) <= 1, `B 沙箱不应重建，实际 ${count}`)
  })

  await t("T22.2 files API 读 B 文件内容 + 不存在路径非 200", async () => {
    const r = await fetch(base + `/api/session/${B}/fs/read/src/index.ts`, { headers: H })
    assert.equal(r.status, 200, `HTTP ${r.status}`)
    assert.ok((await r.text()).includes(`"v1"`), "内容不匹配")
    const miss = await fetch(base + `/api/session/${B}/fs/read/src/not-exist.ts`, { headers: H })
    assert.notEqual(miss.status, 200, `不存在路径应非 200，实际 ${miss.status}`)
  })

  await t("T22.3 A 沙箱本地读不到 B 的文件（卷隔离）", async () => {
    const iso = out(await sh(A, `cat /workspace/src/index.ts 2>&1; ls /workspace/src 2>&1`))
    assert.ok(/No such file or directory/i.test(iso) || iso.trim() === "", `A 沙箱不应看到 B 的代码：${iso.slice(0, 120)}`)
  })
} finally {
  for (const id of [A, B]) await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H }).catch(() => {})
}
console.log(`\nread-peer-sandbox: ${results.length}/3 通过`)
process.exitCode = results.length === 3 ? 0 : 1
