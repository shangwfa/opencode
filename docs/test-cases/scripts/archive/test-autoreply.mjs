// 带自动权限回复的测试 helper —— 不配全局权限，模拟交互审批
const BASE = "http://127.0.0.1:14097"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

const newSid = () => fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).then(d => d.id)
const createAgent = (sid, body) => fetch(BASE + "/session/" + sid + "/agents/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json())
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r => r.json())

// 监听 SSE，自动回复 permission.asked（reply=once），等 session.idle
async function sendWithAutoReply(sid, body, autoReply = "once", timeout = 90000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const dec = new TextDecoder()
    let buf = ""
    const asked = []
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
              const reqId = e.properties?.id
              asked.push({ id: reqId, permission: e.properties?.permission, patterns: e.properties?.patterns })
              console.log("  [ASK] " + e.properties?.permission + " " + JSON.stringify(e.properties?.patterns) + " → reply:" + autoReply)
              await fetch(BASE + "/permission/" + reqId + "/reply", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reply: autoReply }),
              }).catch(err => console.log("  reply err:", err.message))
            }
            const tool = e.properties?.part?.tool, st = e.properties?.part?.state?.status
            if (tool && st) console.log("  [SSE] " + tool + " " + st)
            if (e.type === "session.idle") { clearTimeout(timer); reader.cancel(); resolve({ asked }); return }
          } catch {}
        }
      }
    }
    loop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  })
}

// ==================== 验证: 不配全局权限, ask 自动回复能跑通 write ====================
console.log("━━━ 验证: 自动权限回复机制 (不配全局权限) ━━━")
const AID = "autoreply-" + Date.now().toString(36)
const sid = await newSid()
await exec(sid, `mkdir -p /workspace/analysis/${AID}/spec && rm -f /workspace/analysis/${AID}/spec/spec.md`)

// agent 只配 edit ask (catch-all)，不配全局权限
await createAgent(sid, {
  name: "ask-test", mode: "primary",
  prompt: "你是 agent。用户要求写文件时直接用 write 工具执行。",
  permission: {
    read: "allow",
    edit: { "*": "ask" },   // ask → 触发 permission.asked
    glob: "allow", grep: "allow", list: "allow", bash: "allow",
  },
})

const { asked } = await sendWithAutoReply(sid, {
  parts: [{ type: "text", text: `用 write 工具在 /workspace/analysis/${AID}/spec/spec.md 写入: # AutoReply Test` }],
  agent: "ask-test", model: MODEL,
}, "once")

const v = await exec(sid, `cat /workspace/analysis/${AID}/spec/spec.md 2>&1`)
const ok = v.stdout?.includes("# AutoReply Test")

console.log("\n" + "═".repeat(60))
console.log("ask 请求数:", asked.length)
console.log("write 文件写入:", ok)
console.log("✅ 自动回复机制: " + (asked.length > 0 && ok ? "PASS — ask→reply(once)→write 成功，无需全局权限" : (ok ? "PASS(无ask但写成功)" : "FAIL")))
console.log("═".repeat(60))
