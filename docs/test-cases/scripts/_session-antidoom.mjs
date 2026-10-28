// anti-doom-loop.md T42.2.1/T42.2.3/T42.4.1（真实模型可驱动子集：连续失败阻断、非零退出不算失败、零误伤）
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

const base = process.env.BASE ?? "http://127.0.0.1:15193"
const pg = process.env.PG_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const auth = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD ?? "ab123456"}`).toString("base64")}`
const H = { authorization: auth, "content-type": "application/json" }
const model = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const q = (sql) => execFileSync("psql", [pg, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const R = []
const t = async (id, fn) => { try { await fn(); R.push(id); console.log(`✓ ${id}`) } catch (e) { console.log(`✗ ${id}: ${String(e.message).slice(0, 140)}`) } }
const create = async (ti) => (await (await fetch(base + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: `adl-${ti}-${Date.now()}`, model, location: { directory: "/workspace" } }) })).json()).data.id
const stream = async (id, text) => {
  const r = await fetch(base + `/api/session/${id}/prompt_stream`, { method: "POST", headers: H, body: JSON.stringify({ text, model }), signal: AbortSignal.timeout(240000) })
  const body = await r.text()
  return body.split("\n").filter((l) => l.startsWith("data:")).map((l) => { try { return JSON.parse(l.slice(5)) } catch { return null } }).filter(Boolean)
}
const toolParts = (id) => {
  const raw = q(`select data::text from session_message where session_id='${id}' and type='assistant' order by time_created`)
  return raw.split("\n").filter(Boolean).flatMap((line) => {
    try {
      const d = JSON.parse(line)
      return (d.content ?? []).filter((p) => p.type === "tool")
    } catch { return [] }
  })
}

await t("T42.4.1 正常会话零误伤（多轮工具调用全部完成）", async () => {
  const id = await create("t441")
  const evs = await stream(id, "依次用 shell 工具执行：echo a、echo b、echo c（三次独立调用），然后回复 DONE-NORMAL。")
  assert.ok(evs.some((e) => e.type === "session.execution.succeeded"), "执行未成功")
  const tools = toolParts(id).filter((p) => p.name === "shell")
  assert.ok(tools.length >= 3, `应≥3 次工具调用，实际 ${tools.length}`)
  assert.ok(tools.every((p) => p.state?.status === "completed"), "存在未完成的工具调用（误伤）")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T42.2.3 bash 非零退出不算连续失败", async () => {
  const id = await create("t423")
  const evs = await stream(id, "用 shell 工具依次执行这四条命令（每次独立调用，失败也要继续）：ls /definitely-not-exist-1; ls /definitely-not-exist-2; ls /definitely-not-exist-3; echo final-ok。最后回复 DONE-NONZERO。")
  assert.ok(evs.some((e) => e.type === "session.execution.succeeded"), "执行未成功（非零退出不应导致 fatal）")
  const tools = toolParts(id).filter((p) => p.name === "shell")
  assert.ok(tools.length >= 4, `应≥4 次调用，实际 ${tools.length}`)
  const d = q(`select data from session_message where session_id='${id}' and type='assistant' order by time_created`)
  assert.ok(d.includes("DONE-NONZERO") || d.includes("final-ok"), "模型未走完流程")
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

await t("T42.2.1 同工具连续失败 3 次后阻断盲重试（温和停止）", async () => {
  const id = await create("t421")
  const evs = await stream(id, "用 shell 工具连续执行完全相同的命令 cat /no-such-loop-file 共 5 次（每次都执行，不要换命令不要换参数，即使失败也要原样重试）。")
  const tools = toolParts(id).filter((p) => p.name === "shell" && JSON.stringify(p.state).includes("no-such-loop-file"))
  const failed = tools.filter((p) => p.state?.status === "error" || p.state?.error)
  const exec = evs.find((e) => e.type === "session.execution.failed" || e.type === "session.execution.interrupted")
  // 断言：要么被阻断（fatal 温和停止），要么模型被 block 后停止重试（工具调用收敛 < 5）
  const blockedOrStopped = exec !== undefined || tools.length < 5
  assert.ok(blockedOrStopped, `连续失败未触发阻断：调用 ${tools.length} 次、失败 ${failed.length}、终态 ${exec?.type ?? "succeeded"}`)
  await fetch(base + `/api/session/${id}`, { method: "DELETE", headers: H })
})

console.log(`\nanti-doom-loop: ${R.length}/3 通过`)
process.exitCode = R.length === 3 ? 0 : 1
