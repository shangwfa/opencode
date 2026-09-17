const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const ANALYSIS_ID = "test-perm-" + Date.now().toString(36)

async function sendAndWait(sid, body, timeout = 60000) {
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
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const e = JSON.parse(line.slice(6))
            if (e.type === "server.connected" || e.type === "server.heartbeat") continue
            if (e.properties?.tool) console.log("  [SSE] " + e.type + " tool=" + e.properties.tool)
            if (e.type === "session.idle") {
              clearTimeout(timer)
              const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
              const lastAi = msgs.filter(m => m.info.role === "assistant").pop()
              if (lastAi) { resolve(lastAi); return }
            }
          } catch {}
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

// ==============================
// 测试1: *analysis/ 前缀（正确写法）
// ==============================
console.log("━━━ 测试1: *analysis/ 前缀 ━━━")
const sid1 = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
console.log("SID:", sid1.id)

// 先创建目录
await fetch(BASE + "/session/" + sid1.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: `mkdir -p /workspace/analysis/${ANALYSIS_ID}/spec` }),
})

// 创建 specer agent — 用 *analysis/ 前缀
const res1 = await (await fetch(BASE + "/session/" + sid1.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "specer", mode: "primary",
    prompt: "你是需求分析 agent。用户要求写文件时直接执行，不要解释。",
    permission: {
      read: "allow",
      edit: { "*": "deny", [`*analysis/${ANALYSIS_ID}/spec/*.md`]: "allow" },
      bash: { "*": "deny", "echo *": "allow" },
      glob: "allow", grep: "allow", list: "allow",
    },
  }),
})).json()
console.log("agent permission 规则数:", res1.permission?.length)
const editRules1 = res1.permission?.filter(r => r.permission === "edit")
console.log("edit 规则:", JSON.stringify(editRules1))

// 发消息让 specer 写 spec.md
const msg1 = await sendAndWait(sid1.id, {
  parts: [{ type: "text", text: `请用 write 工具在 /workspace/analysis/${ANALYSIS_ID}/spec/spec.md 写入内容: # Test Spec` }],
  agent: "specer", model: MODEL,
})
const tools1 = msg1.parts.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state?.status }))
const text1 = msg1.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("工具调用:", JSON.stringify(tools1))
console.log("回复:", text1.slice(0, 200))
const writeOk1 = tools1.some(t => (t.tool === "write" || t.tool === "edit") && t.status === "completed")
const writeErr1 = tools1.some(t => (t.tool === "write" || t.tool === "edit") && t.status === "error")
console.log("write 完成:", writeOk1, "| write 错误:", writeErr1)

// exec 验证文件是否写入
const verify1 = await (await fetch(BASE + "/session/" + sid1.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: `cat /workspace/analysis/${ANALYSIS_ID}/spec/spec.md 2>&1` }),
})).json()
console.log("文件内容:", verify1.stdout?.trim())
console.log("✅ 测试1 " + (writeOk1 ? "PASS" : "FAIL") + " — *analysis/ 前缀\n")

// ==============================
// 测试2: analysis/ 前缀（错误写法，无 * 前缀）
// ==============================
console.log("━━━ 测试2: analysis/ 前缀（无 * 前缀）━━━")
const sid2 = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
console.log("SID:", sid2.id)

await fetch(BASE + "/session/" + sid2.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: `mkdir -p /workspace/analysis/${ANALYSIS_ID}-v2/spec` }),
})

// 创建 specer agent — 用 analysis/ 前缀（无 *）
const res2 = await (await fetch(BASE + "/session/" + sid2.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "specer", mode: "primary",
    prompt: "你是需求分析 agent。用户要求写文件时直接执行，不要解释。",
    permission: {
      read: "allow",
      edit: { "*": "deny", [`analysis/${ANALYSIS_ID}-v2/spec/*.md`]: "allow" },
      bash: { "*": "deny", "echo *": "allow" },
      glob: "allow", grep: "allow", list: "allow",
    },
  }),
})).json()
const editRules2 = res2.permission?.filter(r => r.permission === "edit")
console.log("edit 规则:", JSON.stringify(editRules2))

const msg2 = await sendAndWait(sid2.id, {
  parts: [{ type: "text", text: `请用 write 工具在 /workspace/analysis/${ANALYSIS_ID}-v2/spec/spec.md 写入内容: # Test Spec v2` }],
  agent: "specer", model: MODEL,
})
const tools2 = msg2.parts.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state?.status }))
console.log("工具调用:", JSON.stringify(tools2))
const writeErr2 = tools2.some(t => (t.tool === "write" || t.tool === "edit") && t.status === "error")
console.log("✅ 测试2 " + (writeErr2 ? "PASS（如预期被 deny）" : "NOTE — 未被 deny") + "\n")

// ==============================
// 汇总
// ==============================
console.log("═".repeat(50))
console.log("权限 pattern 前缀验证结果:")
console.log("  *analysis/ 前缀 → write " + (writeOk1 ? "✅ allow" : "❌ fail"))
console.log("  analysis/ 前缀  → write " + (writeErr2 ? "❌ deny（已知限制）" : "✅ allow"))
console.log("═".repeat(50))
