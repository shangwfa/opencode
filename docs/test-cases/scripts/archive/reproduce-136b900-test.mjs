const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const ID = "9f06e4c6-82b9-44e5-9a3e-a97737e29cc5"  // 原会话的 analysis ID

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

// 原样复制 ses_136b900 的 specer 权限（对象语法，只有 edit 规则，无 write 规则，**/ pattern）
// 注意 API 接受对象格式，会经 fromConfig 转为 ruleset；规则顺序 = 对象 key 顺序
const ORIGINAL_SPECER_PERMISSION = {
  read: "allow",
  edit: {
    "*": "deny",
    [`**/analysis/${ID}/spec/*.md`]: "allow",
    [`**/analysis/${ID}/suggest-step.json`]: "allow",
  },
  glob: "allow",
  grep: "allow",
  list: "allow",
  bash: "deny",
}

console.log("━━━ 复现 ses_136b900: specer (只配 edit, **/ pattern) ━━━")
const sid = (await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()).id
console.log("SID:", sid)
await exec(sid, `mkdir -p /workspace/analysis/${ID}/spec && rm -f /workspace/analysis/${ID}/spec/spec.md`)

const res = await (await fetch(BASE + "/session/" + sid + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "specer", mode: "primary",
    prompt: "你是需求分析 agent。用户要求写文件时直接用 write 工具执行，不要解释。",
    permission: ORIGINAL_SPECER_PERMISSION,
  }),
})).json()
const editN = res.permission?.filter(r => r.permission === "edit").length
const writeN = res.permission?.filter(r => r.permission === "write").length
console.log(`持久化规则: edit=${editN} write=${writeN} (原会话: edit=2白名单 write=0)`)

await sendAndWait(sid, {
  parts: [{ type: "text", text: `用 write 工具在 /workspace/analysis/${ID}/spec/spec.md 写入: # Test Spec` }],
  agent: "specer", model: MODEL,
})
const v = await exec(sid, `cat /workspace/analysis/${ID}/spec/spec.md 2>&1`)
const ok = v.stdout?.includes("# Test Spec")

console.log("\n" + "═".repeat(60))
console.log("ses_136b900 远端结果: write error（文件未写入）")
console.log(`本地复现结果:        write ${ok ? "✅ 成功（文件已写入）" : "❌ 失败（文件未写入）"}`)
console.log()
if (ok) {
  console.log("→ 本地无法复现远端 error。证实本地代码 write 走 edit 权限，")
  console.log("  只配 edit 白名单即可成功 → 本地 ≠ 远端")
} else {
  console.log("→ 本地也复现 error。本地代码与远端一致（write 需独立 write 规则）")
}
console.log("═".repeat(60))
