const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "sandbox-shared-test" }) })).json()
console.log("SID:", SID.id)

const init = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "mkdir -p /workspace/shared-test && echo done" }),
})).json()
console.log("沙箱初始化:", init.exitCode === 0 ? "✅" : "❌")

await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "main-agent", description: "主 agent", mode: "primary",
    prompt: "你是主 agent。按用户要求操作文件，简洁回答。",
    temperature: 0.3,
    permission: { edit: "allow", write: "allow", bash: "allow", read: "allow", glob: "allow", grep: "allow", task: "allow" },
  }),
})
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "sub-worker", description: "子 agent", mode: "subagent",
    prompt: "你是子 agent。按用户要求操作文件，简洁回答。",
    temperature: 0.3,
    permission: { edit: "allow", write: "allow", bash: "allow", read: "allow", glob: "allow", grep: "allow" },
  }),
})
console.log("agents 创建完成")

async function sendAndWait(sid, body, timeout = 120000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              if (evt.type === "server.connected" || evt.type === "server.heartbeat") continue
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
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

// ============ 测试 1：主 agent 写文件 → 子 agent 读 ============
console.log("\n━━ 测试 1：主 agent 写文件，子 agent 读取 ━━")
const msg1 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请用 write 工具在 /workspace/shared-test/main-writes.txt 写入：SANDBOX_SHARED_TEST_MARKER_12345" }],
  agent: "main-agent", model: MODEL,
})
const t1 = msg1.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("主 agent 回复:", t1.slice(0, 200))

const msg2 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "@sub-worker 请用 read 工具读取 /workspace/shared-test/main-writes.txt 的完整内容，一字不差地告诉我。" }],
  agent: "main-agent", model: MODEL,
})
const t2 = msg2.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("子 agent 回复:", t2.slice(0, 300))
const test1Pass = t2.includes("SANDBOX_SHARED_TEST_MARKER_12345")
console.log("测试1 PASS (子 agent 能读主 agent 写的文件):", test1Pass)

// ============ 测试 2：子 agent 写文件 → 主 agent 读 ============
console.log("\n━━ 测试 2：子 agent 写文件，主 agent 读取 ━━")
const msg3 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "@sub-worker 请用 write 工具在 /workspace/shared-test/sub-writes.txt 写入：SUB_AGENT_MARKER_67890" }],
  agent: "main-agent", model: MODEL,
})
const t3 = msg3.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("子 agent 写入回复:", t3.slice(0, 200))

const msg4 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请用 read 工具读取 /workspace/shared-test/sub-writes.txt 的完整内容，一字不差地告诉我。" }],
  agent: "main-agent", model: MODEL,
})
const t4 = msg4.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("主 agent 回复:", t4.slice(0, 300))
const test2Pass = t4.includes("SUB_AGENT_MARKER_67890")
console.log("测试2 PASS (主 agent 能读子 agent 写的文件):", test2Pass)

// ============ 测试 3：exec 验证两文件都存在 ============
console.log("\n━━ 测试 3：exec 验证文件存在 ━━")
const verify = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "cat /workspace/shared-test/main-writes.txt && echo '---' && cat /workspace/shared-test/sub-writes.txt" }),
})).json()
console.log("exec 输出:", verify.stdout)
const test3Pass = verify.stdout.includes("SANDBOX_SHARED_TEST_MARKER_12345") && verify.stdout.includes("SUB_AGENT_MARKER_67890")
console.log("测试3 PASS (exec 确认两文件存在):", test3Pass)

// ============ 汇总 ============
console.log("\n" + "═".repeat(50))
console.log("主子 agent 沙箱共享测试结果:")
console.log("  测试1 (主→子 文件共享):", test1Pass ? "✅" : "❌")
console.log("  测试2 (子→主 文件共享):", test2Pass ? "✅" : "❌")
console.log("  测试3 (exec 验证):", test3Pass ? "✅" : "❌")
const allPass = test1Pass && test2Pass && test3Pass
console.log("  总体:", allPass ? "✅ 通过" : "❌ 失败")
console.log("═".repeat(50))
