const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const AID = "perm-" + Date.now().toString(36)

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
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const e = JSON.parse(line.slice(6))
            if (e.type === "server.connected" || e.type === "server.heartbeat") continue
            const tool = e.properties?.tool || e.properties?.part?.tool || ""
            if (tool) console.log("  [SSE] " + e.type + " " + tool + " " + (e.properties?.part?.state?.status || ""))
            if (e.type === "session.idle") {
              const s = e.properties?.sessionID || e.sessionID
              if (!s || s === sid) {
                clearTimeout(timer)
                const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                const lastAi = msgs.filter(m => m.info.role === "assistant").pop()
                reader.cancel()
                resolve(lastAi)
                return
              }
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

async function exec(sid, cmd) {
  return await (await fetch(BASE + "/session/" + sid + "/exec", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command: cmd }),
  })).json()
}

async function testConfig(label, permConfig) {
  console.log(`\n━━━ ${label} ━━━`)
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 创建目录
  await exec(sid.id, `mkdir -p /workspace/analysis/${AID}/spec`)

  // 创建 specer agent
  const res = await (await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "specer", mode: "primary",
      prompt: "你是需求分析 agent。用户要求写文件时，直接用 write 工具执行，不要解释，不要犹豫。",
      permission: permConfig,
    }),
  })).json()
  const editRules = res.permission?.filter(r => r.permission === "edit")
  console.log("edit 规则:", JSON.stringify(editRules))

  // 发消息
  const msg = await sendAndWait(sid.id, {
    parts: [{ type: "text", text: `用 write 工具在 /workspace/analysis/${AID}/spec/spec.md 写入: # Test` }],
    agent: "specer", model: MODEL,
  })

  const tools = msg?.parts?.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state?.status })) || []
  const text = msg?.parts?.filter(p => p.type === "text").map(p => p.text).join(" ") || ""
  console.log("工具调用:", JSON.stringify(tools))
  if (text) console.log("回复:", text.slice(0, 200))

  const writeCompleted = tools.some(t => (t.tool === "write" || t.tool === "edit") && t.status === "completed")
  const writeError = tools.some(t => (t.tool === "write" || t.tool === "edit") && t.status === "error")

  // 验证文件
  const verify = await exec(sid.id, `cat /workspace/analysis/${AID}/spec/spec.md 2>&1`)
  const fileExists = verify.stdout?.includes("Test") && !verify.stdout?.includes("No such file")

  console.log(`write completed: ${writeCompleted} | write error: ${writeError} | file exists: ${fileExists}`)
  return { label, writeCompleted, writeError, fileExists }
}

// ==============================
// 测试1: *analysis/ 前缀（推荐写法）
// ==============================
const r1 = await testConfig("*analysis/ 前缀（推荐）", {
  read: "allow",
  edit: { "*": "deny", [`*analysis/${AID}/spec/*.md`]: "allow" },
  glob: "allow", grep: "allow", list: "allow",
  bash: "allow",
})

// ==============================
// 测试2: analysis/ 前缀（无 *，当前线上配置）
// ==============================
const r2 = await testConfig("analysis/ 前缀（无 *，线上当前配置）", {
  read: "allow",
  edit: { "*": "deny", [`analysis/${AID}/spec/*.md`]: "allow" },
  glob: "allow", grep: "allow", list: "allow",
  bash: "allow",
})

// ==============================
// 汇总
// ==============================
console.log("\n" + "═".repeat(60))
console.log("端到端测试结果:")
console.log(`  ${r1.label}: write=${r1.writeCompleted ? "✅" : "❌"} file=${r1.fileExists ? "✅" : "❌"}`)
console.log(`  ${r2.label}: write=${r2.writeError ? "❌ deny" : r2.writeCompleted ? "✅" : "?"} file=${r2.fileExists ? "✅" : "❌"}`)
console.log("═".repeat(60))
