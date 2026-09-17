// 03-ai-conversation.md 回归测试：T4.1-T4.7
// 集成 SSE 监听 + permission.asked 自动回复（reply: always）
// 用法: bun run run-03-ai-conversation.mjs
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const NO_PROXY = "localhost,127.0.0.1"

// 简易 fetch wrapper（绕过代理）
const fjson = async (url, opts) => {
  const r = await fetch(url, opts)
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: r.status, text, json }
}

const newSid = async () => (await fjson(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json.id

const keepAlive = async (sid) => {
  await fjson(BASE + "/session/" + sid + "/keep-alive", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, boot: true }),
  })
}

// 监听 SSE，遇 permission.asked 自动 reply(always)，等 session.idle
const sendAndWait = (sid, body, timeout = 120000) => new Promise(async (resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout " + timeout + "ms")), timeout)
  const asked = []
  const tools = []
  let eventRes
  try {
    eventRes = await fetch(BASE + "/event?sessionID=" + sid)
  } catch (e) { clearTimeout(timer); reject(e); return }
  const reader = eventRes.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const loop = async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) { clearTimeout(timer); reject(new Error("stream ended")); return }
      buf += dec.decode(value, { stream: true })
      const lines = buf.split("\n"); buf = lines.pop() || ""
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue
        let e
        try { e = JSON.parse(line.slice(6)) } catch { continue }
        if (e.type === "server.connected" || e.type === "server.heartbeat") continue
        // 权限自动回复（reply: always）
        if (e.type === "permission.asked") {
          const rid = e.properties?.id
          asked.push({ id: rid, permission: e.properties?.permission, patterns: e.properties?.patterns })
          console.log("    [ASK] " + e.properties?.permission + " " + JSON.stringify(e.properties?.patterns || []) + " → always")
          fetch(BASE + "/permission/" + rid + "/reply", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reply: "always" }),
          }).catch(err => console.log("    reply err:", err.message))
        }
        const part = e.properties?.part
        if (part?.tool && part?.state?.status) {
          tools.push(part.tool + "(" + part.state.status + ")")
        }
        if (e.type === "session.idle") {
          clearTimeout(timer); reader.cancel(); resolve({ asked, tools }); return
        }
      }
    }
  }
  loop()
  await fjson(BASE + "/session/" + sid + "/prompt_async", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
})

// 同步发消息（POST /message），返回最后一条消息 JSON
const sendMessage = async (sid, text) => {
  const { json, text: raw } = await fjson(BASE + "/session/" + sid + "/message", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text }], model: MODEL }),
  })
  return { json, raw }
}

// 获取最近 N 条消息（strict=False 在 python 里用；这里 node JSON.parse 默认非严格）
const getRecentMsgs = async (sid, n = 5) => {
  const { json } = await fjson(BASE + "/session/" + sid + "/message")
  if (!Array.isArray(json)) return []
  return json.slice(-n)
}

// 从消息列表提取工具调用 + 文本
const inspect = (msgs) => {
  const tools = [], texts = []
  for (const m of msgs) {
    for (const p of (m.parts || [])) {
      if (p.type === "tool") {
        const st = p.state?.status || "?"
        const out = (p.state?.output || "").slice(0, 80)
        tools.push(p.tool + "(" + st + ")")
      } else if (p.type === "text") {
        texts.push(p.text || "")
      }
    }
  }
  return { tools, texts }
}

// ==================== 测试开始 ====================
const results = []
const record = (label, ok, detail = "") => {
  results.push({ label, ok })
  console.log((ok ? "✅" : "❌") + " " + label + (detail ? " — " + detail : ""))
}

console.log("━━━ 创建 session（keepAlive+boot）━━━")
const SID = await newSid()
console.log("SID:", SID)
await keepAlive(SID)
// 等沙箱启动
await new Promise(r => setTimeout(r, 4000))

// ---- T4.1 简单文本对话 ----
console.log("\n━━━ T4.1 简单文本对话 ━━━")
try {
  const { json } = await sendMessage(SID, "1+1等于几？只回答数字。")
  const text = (json?.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
  const ok = /2/.test(text)
  record("T4.1", ok, "回复: " + text.slice(0, 80))
} catch (e) { record("T4.1", false, e.message) }

// ---- T4.2 多轮上下文记忆 ----
console.log("\n━━━ T4.2 多轮上下文记忆 ━━━")
try {
  await sendMessage(SID, "请记住我的名字叫张三。").catch(() => {})
  const { json } = await sendMessage(SID, "我叫什么名字？")
  const text = (json?.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
  const ok = text.includes("张三")
  record("T4.2", ok, "回复: " + text.slice(0, 80))
} catch (e) { record("T4.2", false, e.message) }

// ---- T4.3 写文件工具 ----
console.log("\n━━━ T4.3 写文件工具 ━━━")
try {
  const { asked, tools } = await sendAndWait(SID, {
    parts: [{ type: "text", text: "使用 write 工具在 /workspace 创建文件 t4-3.txt，内容是 hello" }],
    model: MODEL,
  }, 120000)
  console.log("    权限 ask 次数:", asked.length, "SSE 工具事件:", tools)
  const msgs = await getRecentMsgs(SID, 5)
  const { tools: msgTools, texts } = inspect(msgs)
  console.log("    消息工具:", msgTools, "文字:", texts[texts.length - 1]?.slice(0, 80))
  const ok = msgTools.some(t => /^(write|edit|bash)\(completed\)/.test(t)) || tools.some(t => /^(write|edit|bash)\(completed\)/.test(t))
  record("T4.3", ok, "工具=" + msgTools.join(",") + " asks=" + asked.length)
} catch (e) { record("T4.3", false, e.message) }

// ---- T4.4 读文件工具 ----
console.log("\n━━━ T4.4 读文件工具 ━━━")
try {
  const { asked, tools } = await sendAndWait(SID, {
    parts: [{ type: "text", text: "使用 read 工具读取 /workspace/t4-3.txt 文件内容" }],
    model: MODEL,
  }, 120000)
  console.log("    权限 ask:", asked.length, "SSE 工具:", tools)
  const msgs = await getRecentMsgs(SID, 5)
  const { tools: msgTools, texts } = inspect(msgs)
  const lastText = texts[texts.length - 1] || ""
  console.log("    消息工具:", msgTools, "文字:", lastText.slice(0, 80))
  const ok = msgTools.some(t => /^read\(completed\)/.test(t)) || tools.some(t => /^read\(completed\)/.test(t))
  record("T4.4", ok && lastText.toLowerCase().includes("hello"), "工具=" + msgTools.join(","))
} catch (e) { record("T4.4", false, e.message) }

// ---- T4.5 bash 命令执行 ----
console.log("\n━━━ T4.5 bash 命令执行 ━━━")
try {
  const { asked, tools } = await sendAndWait(SID, {
    parts: [{ type: "text", text: "使用 bash 工具执行命令: ls /workspace" }],
    model: MODEL,
  }, 120000)
  console.log("    权限 ask:", asked.length, "SSE 工具:", tools)
  const msgs = await getRecentMsgs(SID, 5)
  const { tools: msgTools, texts } = inspect(msgs)
  const lastText = texts[texts.length - 1] || ""
  console.log("    消息工具:", msgTools, "文字:", lastText.slice(0, 120))
  const toolOk = msgTools.some(t => /^(bash|read)\(completed\)/.test(t)) || tools.some(t => /^(bash|read)\(completed\)/.test(t))
  const textOk = lastText.includes("t4-3.txt") || lastText.toLowerCase().includes("workspace")
  record("T4.5", toolOk, "工具=" + msgTools.join(",") + " 含文件名=" + lastText.includes("t4-3.txt"))
} catch (e) { record("T4.5", false, e.message) }

// ---- T4.6 异步消息（不等结果）----
console.log("\n━━━ T4.6 异步消息 ━━━")
try {
  const r = await fetch(BASE + "/session/" + SID + "/prompt_async", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "写一首五言绝句，关于春天" }], model: MODEL }),
  })
  const status = r.status
  record("T4.6", status === 204, "HTTP " + status)
  // 等一会儿，让任务跑完
  console.log("    等待异步任务完成...")
  await new Promise(r => setTimeout(r, 30000))
} catch (e) { record("T4.6", false, e.message) }

// ---- T4.7 中断会话 ----
console.log("\n━━━ T4.7 中断会话 ━━━")
let abortOk = false
let abortDetail = ""
try {
  // 先确认 session idle
  await new Promise(r => setTimeout(r, 3000))
  // 发送一个长任务
  await fetch(BASE + "/session/" + SID + "/prompt_async", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "写一篇1万字的科幻小说，要求详细展开" }], model: MODEL }),
  })
  // 立即中断
  await new Promise(r => setTimeout(r, 3000))
  const ar = await fjson(BASE + "/session/" + SID + "/abort", { method: "POST" })
  console.log("    abort status:", ar.status, "body:", ar.text.slice(0, 100))
  // 检查最后一条消息 finish 状态
  await new Promise(r => setTimeout(r, 5000))
  const msgs = await getRecentMsgs(SID, 3)
  const last = msgs[msgs.length - 1] || {}
  const finishReason = last.finishReason || last.finish_reason || last.finish || ""
  console.log("    最后消息 finishReason:", finishReason, "role:", last.role)
  abortOk = ar.status === 200 || ar.text === "true" || /abort/i.test(JSON.stringify(msgs))
  abortDetail = "abort=" + ar.status + " finish=" + finishReason
  record("T4.7", abortOk, abortDetail)
} catch (e) { record("T4.7", false, e.message) }

// ==================== 汇总 ====================
const passed = results.filter(r => r.ok).length
const total = results.length
console.log("\n" + "═".repeat(60))
console.log("结果: " + passed + "/" + total)
console.log("═".repeat(60))
process.exit(passed === total ? 0 : 1)
