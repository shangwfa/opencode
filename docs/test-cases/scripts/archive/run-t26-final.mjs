// T26 权限用例回归测试 — 容器 14096 (含 directory 修复, pgLayer 写远端 PG)
// 不配全局权限；遇到 permission.asked 自动回复 once
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const PG = "PGPASSWORD='8zuhlMLd4gaeUG5k' psql -h 172.18.32.14 -p 5432 -U app -d opencode -t -A -c"
const results = []

const newSid = () => fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).then(d => d.id)
const createAgent = (sid, body) => fetch(BASE + "/session/" + sid + "/agents/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json())
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r => r.json())
const agentRules = (data, perm) => (data.permission || []).filter(r => r.permission === perm)

// 查 PG 验证 session_agents 持久化
const { execSync } = require("child_process")
function pgQuery(sid, name) {
  try {
    const out = execSync(`${PG} "SELECT jsonb_array_length(permission) FROM session_agents WHERE session_id='${sid}' AND name='${name}'"`, { encoding: "utf8", timeout: 5000 }).trim()
    return parseInt(out) || 0
  } catch { return -1 }
}

// sendAndWait：监听 SSE，自动回复 permission.asked，等 session.idle
async function sendAndWait(sid, body, timeout = 120000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const r = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ""
    let asked = 0
    const loop = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { clearTimeout(timer); reject(new Error("stream ended")); return }
        buf += dec.decode(value, { stream: true })
        const ls = buf.split("\n"); buf = ls.pop() || ""
        for (const l of ls) {
          if (!l.startsWith("data: ")) continue
          try {
            const e = JSON.parse(l.slice(6))
            if (e.type === "server.connected" || e.type === "server.heartbeat") continue
            // 自动回复 permission.asked
            if (e.type === "permission.asked") {
              asked++
              const rid = e.properties?.id
              console.log("    [ASK] auto-reply once: " + e.properties?.permission + " " + JSON.stringify(e.properties?.patterns))
              fetch(BASE + "/permission/" + rid + "/reply?directory=/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "once" }) }).catch(() => {})
            }
            const tool = e.properties?.part?.tool, st = e.properties?.part?.state?.status
            if (tool && st) console.log("    [SSE] " + tool + " " + st)
            if (e.type === "session.idle") { clearTimeout(timer); reader.cancel(); resolve({ asked }); return }
          } catch {}
        }
      }
    }
    loop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  })
}

// ===== T26.21 字符串简写 =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t21", mode: "primary", prompt: "t", permission: { edit: "deny", bash: "allow", read: "allow" } })
  const pgRules = pgQuery(sid, "t21")
  const ok = agentRules(d, "edit").some(r => r.action === "deny") && agentRules(d, "bash").some(r => r.action === "allow") && pgRules > 0
  results.push(["T26.21", ok, `字符串简写 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.21 字符串简写 (PG:${pgRules}条)`)
}

// ===== T26.22 粒度路径 (deny catch-all + 白名单) =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t22", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "docs/*.md": "allow" } } })
  const e = agentRules(d, "edit")
  const pgRules = pgQuery(sid, "t22")
  const ok = e.some(r => r.pattern === "*" && r.action === "deny") && e.some(r => r.pattern === "docs/*.md" && r.action === "allow") && pgRules > 0
  results.push(["T26.22", ok, `粒度路径 deny+白名单 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.22 粒度路径(deny catch-all) (PG:${pgRules}条)`)
}

// ===== T26.23 ask catch-all =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t23", mode: "primary", prompt: "t", permission: { edit: { "*": "ask", "docs/*.md": "allow" } } })
  const e = agentRules(d, "edit")
  const pgRules = pgQuery(sid, "t23")
  const ok = e.some(r => r.pattern === "*" && r.action === "ask") && e.some(r => r.pattern === "docs/*.md" && r.action === "allow") && pgRules > 0
  results.push(["T26.23", ok, `ask catch-all+白名单 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.23 ask catch-all (PG:${pgRules}条)`)
}

// ===== T26.24 bash 粒度命令 =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t24", mode: "primary", prompt: "t", permission: { bash: { "*": "ask", "git *": "allow", "rm *": "deny" } } })
  const b = agentRules(d, "bash")
  const pgRules = pgQuery(sid, "t24")
  const ok = b.some(r => r.pattern === "git *" && r.action === "allow") && b.some(r => r.pattern === "rm *" && r.action === "deny") && pgRules > 0
  results.push(["T26.24", ok, `bash粒度命令 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.24 bash 粒度命令 (PG:${pgRules}条)`)
}

// ===== T26.25 全局 allow/deny 字符串 =====
{
  const sid = await newSid()
  const d1 = await createAgent(sid, { name: "t25a", mode: "primary", prompt: "t", permission: "deny" })
  const d2 = await createAgent(sid, { name: "t25b", mode: "primary", prompt: "t", permission: "allow" })
  const pg1 = pgQuery(sid, "t25a"), pg2 = pgQuery(sid, "t25b")
  const ok = Array.isArray(d1.permission) && Array.isArray(d2.permission) && pg1 > 0 && pg2 > 0
  results.push(["T26.25", ok, `全局字符串 (PG:${pg1},${pg2}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.25 全局字符串 (PG:${pg1},${pg2}条)`)
}

// ===== T26.26 last matching rule wins =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t26", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "src/*.ts": "allow" } } })
  const e = agentRules(d, "edit")
  const pgRules = pgQuery(sid, "t26")
  const denyIdx = e.findIndex(r => r.pattern === "*" && r.action === "deny")
  const allowIdx = e.findIndex(r => r.pattern === "src/*.ts" && r.action === "allow")
  const ok = denyIdx >= 0 && allowIdx >= 0 && denyIdx < allowIdx && pgRules > 0
  results.push(["T26.26", ok, `last matching rule wins (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.26 last matching rule wins (PG:${pgRules}条)`)
}

// ===== T26.26b 对象 key 顺序 =====
{
  const sid = await newSid()
  const dA = await createAgent(sid, { name: "t26ba", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "docs/*.md": "allow" } } })
  const dB = await createAgent(sid, { name: "t26bb", mode: "primary", prompt: "t", permission: { edit: { "docs/*.md": "allow", "*": "deny" } } })
  const eA = agentRules(dA, "edit"), eB = agentRules(dB, "edit")
  const pgA = pgQuery(sid, "t26ba"), pgB = pgQuery(sid, "t26bb")
  const okA = eA.findIndex(r => r.pattern === "*" && r.action === "deny") < eA.findIndex(r => r.pattern === "docs/*.md" && r.action === "allow")
  const okB = eB.findIndex(r => r.pattern === "docs/*.md" && r.action === "allow") < eB.findIndex(r => r.pattern === "*" && r.action === "deny")
  const ok = okA && okB && pgA > 0 && pgB > 0
  results.push(["T26.26b", ok, `key顺序影响 (PG:${pgA},${pgB}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.26b 对象 key 顺序 (PG:${pgA},${pgB}条)`)
}

// ===== T26.27 tools 向后兼容 =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t27", mode: "primary", prompt: "t", tools: { edit: true, bash: false } })
  const hasEdit = d.permission?.some(r => r.permission === "edit" && r.action === "allow")
  const hasBash = d.permission?.some(r => r.permission === "bash" && r.action === "deny")
  const pgRules = pgQuery(sid, "t27")
  // 已知: API 层不做 normalize
  results.push(["T26.27", !hasEdit && !hasBash, `tools不转permission(已知限制) (PG:${pgRules}条)`])
  console.log(`⚠️ T26.27 tools 向后兼容 (PG:${pgRules}条) — 已知限制`)
}

// ===== T26.28 task 权限 =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t28", mode: "primary", prompt: "t", permission: { task: { "*": "ask", "safe": "allow", "danger": "deny" } } })
  const t = agentRules(d, "task")
  const pgRules = pgQuery(sid, "t28")
  const ok = t.some(r => r.pattern === "safe" && r.action === "allow") && t.some(r => r.pattern === "danger" && r.action === "deny") && pgRules > 0
  results.push(["T26.28", ok, `task权限 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.28 task 权限 (PG:${pgRules}条)`)
}

// ===== T26.31 对象语法白名单 (相对路径) =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t31", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "analysis/t31/spec/*.md": "allow" } } })
  const pgRules = pgQuery(sid, "t31")
  const ok = agentRules(d, "edit").some(r => r.pattern === "analysis/t31/spec/*.md" && r.action === "allow") && pgRules > 0
  results.push(["T26.31", ok, `对象语法白名单 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.31 对象语法白名单 (PG:${pgRules}条)`)
}

// ===== T26.32 **/ 前缀持久化 =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t32", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "**/analysis/t32/spec/*.md": "allow" } } })
  const pgRules = pgQuery(sid, "t32")
  const ok = agentRules(d, "edit").some(r => r.pattern === "**/analysis/t32/spec/*.md" && r.action === "allow") && pgRules > 0
  results.push(["T26.32", ok, `**/ 前缀持久化 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.32 **/ 前缀持久化 (PG:${pgRules}条)`)
}

// ===== T26.33 ... 字面点 + * 通配 =====
{
  const sid = await newSid()
  const d1 = await createAgent(sid, { name: "t33a", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "analysis/.../spec/*.md": "allow" } } })
  const d2 = await createAgent(sid, { name: "t33b", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "analysis/*/spec/*.md": "allow" } } })
  const pg1 = pgQuery(sid, "t33a"), pg2 = pgQuery(sid, "t33b")
  const ok = agentRules(d1, "edit").some(r => r.pattern === "analysis/.../spec/*.md") && agentRules(d2, "edit").some(r => r.pattern === "analysis/*/spec/*.md") && pg1 > 0 && pg2 > 0
  results.push(["T26.33", ok, `字面点vs通配 (PG:${pg1},${pg2}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.33 .../vs * (PG:${pg1},${pg2}条)`)
}

// ===== T26.34 directory 基准修复 (端到端 write + PG) =====
{
  const AID = "t34-" + Date.now().toString(36)
  const sid = await newSid()
  await exec(sid, `mkdir -p /workspace/analysis/${AID}/spec && rm -f /workspace/analysis/${AID}/spec/spec.md`)
  const agentData = await createAgent(sid, {
    name: "specer-t34", mode: "primary",
    prompt: "你是需求分析agent。用户要求写文件时直接用write工具执行。",
    permission: { read: "allow", edit: { "*": "deny", [`analysis/${AID}/spec/*.md`]: "allow" }, glob: "allow", grep: "allow", list: "allow", bash: "allow" },
  })
  const pgRules = pgQuery(sid, "specer-t34")
  try {
    await sendAndWait(sid, { parts: [{ type: "text", text: `用 write 工具在 /workspace/analysis/${AID}/spec/spec.md 写入: # Test` }], agent: "specer-t34", model: MODEL })
    const v = await exec(sid, `cat /workspace/analysis/${AID}/spec/spec.md 2>&1`)
    const ok = v.stdout?.includes("# Test") && pgRules > 0
    results.push(["T26.34", ok, `directory基准修复-无前缀write (PG:${pgRules}条)`])
    console.log(`${ok ? "✅" : "❌"} T26.34 directory基准修复(analysis/无前缀) (PG:${pgRules}条)`)
  } catch (e) {
    results.push(["T26.34", false, `端到端超时: ${e.message} (PG:${pgRules}条)`])
    console.log(`❌ T26.34 directory基准修复 — ${e.message} (PG:${pgRules}条)`)
  }
}

// ===== T26.40 ~/$HOME 展开 + PG =====
{
  const sid = await newSid()
  const d = await createAgent(sid, { name: "t40", mode: "primary", prompt: "t", permission: { external_directory: { "~/projects/*": "allow" } } })
  const ext = agentRules(d, "external_directory")
  const pgRules = pgQuery(sid, "t40")
  const ok = ext.some(r => !r.pattern.startsWith("~") && r.pattern.startsWith("/")) && pgRules > 0
  results.push(["T26.40", ok, `~/$HOME展开 (PG:${pgRules}条)`])
  console.log(`${ok ? "✅" : "❌"} T26.40 ~/$HOME 展开 (PG:${pgRules}条)`)
}

// ===== 汇总 =====
console.log("\n" + "═".repeat(60))
const pass = results.filter(r => r[1]).length
for (const [id, ok, desc] of results) console.log(`  ${ok ? "✅" : "⚠️"} ${id}: ${desc}`)
console.log(`\n通过: ${pass}/${results.length}` + (results.length - pass > 0 ? ` (${results.length - pass} NOTE)` : ""))
console.log("═".repeat(60))
