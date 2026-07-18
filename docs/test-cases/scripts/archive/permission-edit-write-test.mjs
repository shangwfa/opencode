const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const AID = "ew-" + Date.now().toString(36)

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
            const tool = e.properties?.part?.tool, st = e.properties?.part?.state?.status
            if (tool && st) console.log("  [SSE] " + tool + " " + st)
            if (e.type === "session.idle") { clearTimeout(timer); reader.cancel(); resolve(true); return }
          } catch {}
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  })
}
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r => r.json())

async function test(label, permission) {
  console.log(`\n━━━ ${label} ━━━`)
  const sid = (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id
  await exec(sid, `mkdir -p /workspace/analysis/${AID}/spec && rm -f /workspace/analysis/${AID}/spec/spec.md`)
  const res = await (await fetch(BASE + "/session/" + sid + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "specer-test", mode: "primary", prompt: "你是需求分析 agent。用户要求写文件时直接用 write 工具执行。", permission }),
  })).json()
  const editN = res.permission?.filter(r => r.permission === "edit").length
  const writeN = res.permission?.filter(r => r.permission === "write").length
  console.log(`持久化规则: edit=${editN} write=${writeN}`)
  await sendAndWait(sid, { parts: [{ type: "text", text: `用 write 工具在 /workspace/analysis/${AID}/spec/spec.md 写入: # Test` }], agent: "specer-test", model: MODEL })
  const v = await exec(sid, `cat /workspace/analysis/${AID}/spec/spec.md 2>&1`)
  const ok = v.stdout?.includes("# Test")
  console.log(`${ok ? "✅" : "❌"} file=${ok}`)
  return ok
}

// 用 *analysis/ 前缀(保证路径匹配)，区别只在是否配 write 规则
const P = `*analysis/${AID}/spec/*.md`

// 配置A: 只配 edit 规则（缺 write）
const rA = await test("A. 只配 edit 白名单（无 write 规则）", {
  read: "allow",
  edit: { "*": "deny", [P]: "allow" },
  glob: "allow", grep: "allow", list: "allow", bash: "allow",
})

// 配置B: edit + write 都配（specer-lite 做法）
const rB = await test("B. edit + write 都配白名单", {
  read: "allow",
  edit: { "*": "deny", [P]: "allow" },
  write: { "*": "deny", [P]: "allow" },
  glob: "allow", grep: "allow", list: "allow", bash: "allow",
})

console.log("\n" + "═".repeat(60))
console.log("本地结果:")
console.log(`  A 只配 edit:        write=${rA ? "✅成功" : "❌失败"}`)
console.log(`  B edit+write 都配:  write=${rB ? "✅成功" : "❌失败"}`)
console.log()
if (rA && rB) console.log("→ 本地代码: write 工具走 edit 权限(EDIT_TOOLS归并)，只配 edit 即可")
else if (!rA && rB) console.log("→ 本地代码: write 工具走 write 权限，必须配 write 规则（同远端）")
console.log("═".repeat(60))
