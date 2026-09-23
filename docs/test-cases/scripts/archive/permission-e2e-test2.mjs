const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const AID = "perm2-" + Date.now().toString(36)

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
            const tool = e.properties?.part?.tool || ""
            const status = e.properties?.part?.state?.status || ""
            if (tool) console.log("  [SSE] " + tool + " " + status)
            if (e.type === "session.idle") {
              const s = e.properties?.sessionID || e.sessionID
              if (!s || s === sid) {
                clearTimeout(timer)
                reader.cancel()
                resolve(true)
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

async function testConfig(label, editAllowPattern) {
  console.log(`\n━━━ ${label} ━━━`)
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  await exec(sid.id, `mkdir -p /workspace/analysis/${AID}/spec && rm -f /workspace/analysis/${AID}/spec/spec.md`)

  const res = await (await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "specer", mode: "primary",
      prompt: "你是需求分析 agent。用户要求写文件时，直接用 write 工具执行。",
      permission: {
        read: "allow",
        edit: { "*": "deny", [editAllowPattern]: "allow" },
        glob: "allow", grep: "allow", list: "allow", bash: "allow",
      },
    }),
  })).json()
  const editRules = res.permission?.filter(r => r.permission === "edit").map(r => r.pattern + ":" + r.action)
  console.log("edit 规则:", JSON.stringify(editRules))

  await sendAndWait(sid.id, {
    parts: [{ type: "text", text: `用 write 工具在 /workspace/analysis/${AID}/spec/spec.md 写入: # Test` }],
    agent: "specer", model: MODEL,
  })

  const verify = await exec(sid.id, `cat /workspace/analysis/${AID}/spec/spec.md 2>&1`)
  const fileExists = verify.stdout?.includes("# Test")
  console.log("文件存在:", fileExists, fileExists ? "" : "(stdout: " + (verify.stdout || "").trim().slice(0, 100) + ")")
  return { label, fileExists }
}

const r1 = await testConfig(
  "*analysis/ 前缀",
  `*analysis/${AID}/spec/*.md`,
)

const r2 = await testConfig(
  "analysis/ 前缀（无 *）",
  `analysis/${AID}/spec/*.md`,
)

const r3 = await testConfig(
  "/workspace/analysis/ 绝对路径前缀",
  `/workspace/analysis/${AID}/spec/*.md`,
)

const r4 = await testConfig(
  "**/analysis/ 前缀",
  `**/analysis/${AID}/spec/*.md`,
)

console.log("\n" + "═".repeat(60))
console.log("端到端测试结果 (worktree='/'):")
console.log(`  ${r1.label.padEnd(30)} file=${r1.fileExists ? "✅" : "❌"}`)
console.log(`  ${r2.label.padEnd(30)} file=${r2.fileExists ? "✅" : "❌"}`)
console.log(`  ${r3.label.padEnd(30)} file=${r3.fileExists ? "✅" : "❌"}`)
console.log(`  ${r4.label.padEnd(30)} file=${r4.fileExists ? "✅" : "❌"}`)
console.log("═".repeat(60))
