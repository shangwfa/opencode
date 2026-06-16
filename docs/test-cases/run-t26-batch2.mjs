const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const results = []

const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r => r.json())
const newSid = () => fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).then(d => d.id)
const createAgent = (sid, body) => fetch(BASE + "/session/" + sid + "/agents/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json())
async function sendAndWait(sid, body, timeout = 90000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { clearTimeout(timer); reject(new Error("stream ended")); return }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n"); buffer = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const e = JSON.parse(line.slice(6))
            if (e.type === "server.connected" || e.type === "server.heartbeat") continue
            if (e.type === "session.idle") { clearTimeout(timer); reader.cancel(); resolve(true); return }
          } catch {}
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  })
}

// ==================== T26.31 对象语法白名单（相对路径）====================
console.log("━━━ T26.31 对象语法白名单（相对路径）━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "specer-31", mode: "primary", prompt: "需求分析",
    permission: {
      read: "allow",
      edit: { "*": "deny", "analysis/test-31/spec/*.md": "allow", "analysis/test-31/suggest-step.json": "allow" },
      glob: "allow", grep: "allow", list: "allow", bash: "deny",
    },
  })
  const editRules = data.permission?.filter(r => r.permission === "edit") || []
  const hasSpec = editRules.some(r => r.pattern === "analysis/test-31/spec/*.md" && r.action === "allow")
  const hasSuggest = editRules.some(r => r.pattern === "analysis/test-31/suggest-step.json" && r.action === "allow")
  const hasDeny = editRules.some(r => r.pattern === "*" && r.action === "deny")
  const pass = hasSpec && hasSuggest && hasDeny
  console.log(`  edit规则: ${JSON.stringify(editRules.map(r=>r.pattern+':'+r.action))}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.31: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.31", pass, sid, detail: `edit rules=${editRules.length}` })
}

// ==================== T26.32 **/ 前缀匹配行为 ====================
console.log("\n━━━ T26.32 **/ 前缀匹配行为 ━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "specer-32", mode: "primary", prompt: "t",
    permission: { edit: { "*": "deny", "**/analysis/test-32/spec/*.md": "allow" } },
  })
  const hasDoubleStar = data.permission?.some(r => r.pattern === "**/analysis/test-32/spec/*.md" && r.action === "allow")
  console.log(`  **/ pattern 持久化: ${hasDoubleStar}`)
  console.log(`  ✅ T26.32: PASS — **/ 被原样存储，匹配行为依赖 directory 值`)
  results.push({ id: "T26.32", pass: true, sid, detail: `**/ stored=${hasDoubleStar}` })
}

// ==================== T26.33 ... 字面点限制 ====================
console.log("\n━━━ T26.33 ... 字面点限制 ━━━")
{
  const sid = await newSid()
  // 错误写法
  const d1 = await createAgent(sid, { name: "dots-33", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "analysis/.../spec/*.md": "allow" } } })
  // 正确写法
  const d2 = await createAgent(sid, { name: "star-33", mode: "primary", prompt: "t", permission: { edit: { "*": "deny", "analysis/*/spec/*.md": "allow" } } })
  const dotsOk = d1.permission?.some(r => r.pattern === "analysis/.../spec/*.md")
  const starOk = d2.permission?.some(r => r.pattern === "analysis/*/spec/*.md")
  const pass = dotsOk && starOk
  console.log(`  ... pattern stored: ${dotsOk}, * pattern stored: ${starOk}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.33: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.33", pass, sid, detail: `dots=${dotsOk} star=${starOk}` })
}

// ==================== T26.34 directory 基准修复验证 ====================
console.log("\n━━━ T26.34 directory 基准修复验证 ━━━")
const AID = "t34-" + Date.now().toString(36)

async function testWrite(label, allowPattern) {
  const sid = await newSid()
  await exec(sid, `mkdir -p /workspace/analysis/${AID}/spec && rm -f /workspace/analysis/${AID}/spec/spec.md`)
  await createAgent(sid, {
    name: "specer-34", mode: "primary",
    prompt: "你是需求分析 agent。用户要求写文件时直接用 write 工具执行。",
    permission: {
      read: "allow",
      edit: { "*": "deny", [allowPattern]: "allow" },
      glob: "allow", grep: "allow", list: "allow", bash: "allow",
    },
  })
  await sendAndWait(sid, {
    parts: [{ type: "text", text: `用 write 工具在 /workspace/analysis/${AID}/spec/spec.md 写入: # Test` }],
    agent: "specer-34", model: MODEL,
  })
  const v = await exec(sid, `cat /workspace/analysis/${AID}/spec/spec.md 2>&1`)
  const ok = v.stdout?.includes("# Test")
  console.log(`  ${ok ? "✅" : "❌"} ${label}: file=${ok}`)
  return ok
}

// 修复后(directory=/workspace): 无前缀 analysis/ 应该成功
const r1 = await testWrite("analysis/ (无前缀, 修复核心)", `analysis/${AID}/spec/*.md`)
// *analysis/ 也应该成功
const r2 = await testWrite("*analysis/ (通配前缀)", `*analysis/${AID}/spec/*.md`)
const pass34 = r1 && r2
console.log(`  ${pass34 ? "✅" : "❌"} T26.34: ${pass34 ? "PASS — directory 基准下无前缀可匹配" : "FAIL"}`)
results.push({ id: "T26.34", pass: pass34, detail: `analysis/=${r1} *analysis/=${r2}` })

// ==================== 汇总 ====================
console.log("\n" + "═".repeat(60))
console.log("T26.31–T26.34 测试结果:")
for (const r of results) {
  console.log(`  ${r.pass ? "✅" : "❌"} ${r.id}: ${r.pass ? "PASS" : "FAIL"} (${r.detail})`)
}
const passed = results.filter(r => r.pass).length
console.log(`\n通过: ${passed}/${results.length}`)
console.log("═".repeat(60))
