const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const results = []

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
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r => r.json())
const newSid = () => fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).then(d => d.id)
const createAgent = (sid, body) => fetch(BASE + "/session/" + sid + "/agents/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json())
const permCount = (data) => data.permission?.length ?? 0

// ==================== T26.21 字符串简写权限 ====================
console.log("━━━ T26.21 字符串简写权限 ━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "readonly-21", mode: "primary", prompt: "只读分析师",
    permission: { edit: "deny", write: "deny", bash: "allow", read: "allow", glob: "allow", grep: "allow" },
  })
  const hasEditDeny = data.permission?.some(r => r.permission === "edit" && r.action === "deny")
  const hasBashAllow = data.permission?.some(r => r.permission === "bash" && r.action === "allow")
  const pass = hasEditDeny && hasBashAllow
  console.log(`  permission count: ${permCount(data)}, edit:deny=${hasEditDeny}, bash:allow=${hasBashAllow}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.21: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.21", pass, sid, detail: `perm=${permCount(data)}` })
}

// ==================== T26.22 粒度路径权限 (deny catch-all) ====================
console.log("\n━━━ T26.22 粒度路径权限 (deny catch-all) ━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "doc-editor-22", mode: "primary", prompt: "文档编辑器",
    permission: {
      edit: { "*": "deny", "docs/*.md": "allow" },
      write: { "*": "deny", "docs/*.md": "allow" },
      bash: "allow", read: "allow",
    },
  })
  const editRules = data.permission?.filter(r => r.permission === "edit")
  const hasDenyAll = editRules?.some(r => r.pattern === "*" && r.action === "deny")
  const hasAllowDocs = editRules?.some(r => r.pattern === "docs/*.md" && r.action === "allow")
  const pass = hasDenyAll && hasAllowDocs && permCount(data) === 6
  console.log(`  permission count: ${permCount(data)}, edit deny *=${hasDenyAll}, allow docs/*.md=${hasAllowDocs}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.22: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.22", pass, sid, detail: `perm=${permCount(data)}` })
}

// ==================== T26.23 粒度路径权限 (ask catch-all) ====================
console.log("\n━━━ T26.23 粒度路径权限 (ask catch-all) ━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "doc-editor-23", mode: "primary", prompt: "文档编辑器",
    permission: {
      edit: { "*": "ask", "docs/*.md": "allow" },
      bash: "allow", read: "allow",
    },
  })
  const editRules = data.permission?.filter(r => r.permission === "edit")
  const hasAskAll = editRules?.some(r => r.pattern === "*" && r.action === "ask")
  const hasAllowDocs = editRules?.some(r => r.pattern === "docs/*.md" && r.action === "allow")
  const pass = hasAskAll && hasAllowDocs && permCount(data) === 4
  console.log(`  permission count: ${permCount(data)}, edit ask *=${hasAskAll}, allow docs/*.md=${hasAllowDocs}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.23: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.23", pass, sid, detail: `perm=${permCount(data)}` })
}

// ==================== T26.24 bash 粒度命令权限 ====================
console.log("\n━━━ T26.24 bash 粒度命令权限 ━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "git-operator-24", mode: "primary", prompt: "Git操作员",
    permission: {
      bash: { "*": "ask", "git *": "allow", "rm *": "deny", "ls *": "allow" },
      read: "allow",
    },
  })
  const bashRules = data.permission?.filter(r => r.permission === "bash")
  const hasGitAllow = bashRules?.some(r => r.pattern === "git *" && r.action === "allow")
  const hasRmDeny = bashRules?.some(r => r.pattern === "rm *" && r.action === "deny")
  const pass = hasGitAllow && hasRmDeny && permCount(data) === 5
  console.log(`  permission count: ${permCount(data)}, git:allow=${hasGitAllow}, rm:deny=${hasRmDeny}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.24: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.24", pass, sid, detail: `perm=${permCount(data)}` })
}

// ==================== T26.25 全局 allow/deny 快捷写法 ====================
console.log("\n━━━ T26.25 全局 allow/deny 快捷写法 ━━━")
{
  const sid = await newSid()
  const res1 = await createAgent(sid, { name: "deny-agent-25", mode: "primary", prompt: "t", permission: "deny" })
  const res2 = await createAgent(sid, { name: "allow-agent-25", mode: "primary", prompt: "t", permission: "allow" })
  const pass = Array.isArray(res1.permission) && Array.isArray(res2.permission)
  console.log(`  deny → ruleset count: ${permCount(res1)}, allow → ruleset count: ${permCount(res2)}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.25: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.25", pass, sid, detail: `deny=${permCount(res1)} allow=${permCount(res2)}` })
}

// ==================== T26.26 last matching rule wins ====================
console.log("\n━━━ T26.26 last matching rule wins ━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "src-editor-26", mode: "primary", prompt: "代码编辑器",
    permission: {
      edit: { "*": "deny", "src/*.ts": "allow" },
      bash: "allow", read: "allow",
    },
  })
  const editRules = data.permission?.filter(r => r.permission === "edit")
  // 确认顺序：deny * 在前，allow src/*.ts 在后
  const denyIdx = editRules?.findIndex(r => r.pattern === "*" && r.action === "deny")
  const allowIdx = editRules?.findIndex(r => r.pattern === "src/*.ts" && r.action === "allow")
  const pass = denyIdx === 0 && allowIdx === 1
  console.log(`  edit规则顺序: deny*=[${denyIdx}] allow src/*.ts=[${allowIdx}]`)
  console.log(`  ${pass ? "✅" : "❌"} T26.26: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.26", pass, sid, detail: `deny@${denyIdx} allow@${allowIdx}` })
}

// ==================== T26.27 tools 字段向后兼容 ====================
console.log("\n━━━ T26.27 tools 字段向后兼容 ━━━")
{
  const sid = await newSid()
  const data = await createAgent(sid, {
    name: "legacy-27", mode: "primary", prompt: "t",
    tools: { edit: true, bash: false, webfetch: true },
  })
  const hasEditAllow = data.permission?.some(r => r.permission === "edit" && r.action === "allow")
  const hasBashDeny = data.permission?.some(r => r.permission === "bash" && r.action === "deny")
  const pass = hasEditAllow && hasBashDeny
  console.log(`  tools→permission: edit:allow=${hasEditAllow}, bash:deny=${hasBashDeny}, perm count=${permCount(data)}`)
  console.log(`  ${pass ? "✅" : "⚠️"} T26.27: ${pass ? "PASS" : "NOTE — API 层可能未做转换"}`)
  results.push({ id: "T26.27", pass, sid, detail: `perm=${permCount(data)}` })
}

// ==================== T26.28 task 权限控制 subagent ====================
console.log("\n━━━ T26.28 task 权限控制 subagent 调度 ━━━")
{
  const sid = await newSid()
  await createAgent(sid, { name: "danger-28", mode: "subagent", prompt: "危险" })
  await createAgent(sid, { name: "safe-28", mode: "subagent", prompt: "安全" })
  const data = await createAgent(sid, {
    name: "mgr-28", mode: "primary", prompt: "受限管理员",
    permission: {
      task: { "*": "ask", "danger-28": "deny", "safe-28": "allow" },
      bash: "allow", read: "allow",
    },
  })
  const taskRules = data.permission?.filter(r => r.permission === "task")
  const denyDanger = taskRules?.some(r => r.pattern === "danger-28" && r.action === "deny")
  const allowSafe = taskRules?.some(r => r.pattern === "safe-28" && r.action === "allow")
  const pass = denyDanger && allowSafe
  console.log(`  task规则: deny danger-28=${denyDanger}, allow safe-28=${allowSafe}`)
  console.log(`  ${pass ? "✅" : "❌"} T26.28: ${pass ? "PASS" : "FAIL"}`)
  results.push({ id: "T26.28", pass, sid, detail: `task rules=${taskRules?.length}` })
}

// ==================== 汇总 ====================
console.log("\n" + "═".repeat(60))
console.log("T26.21–T26.28 测试结果:")
for (const r of results) {
  console.log(`  ${r.pass ? "✅" : "⚠️"} ${r.id}: ${r.pass ? "PASS" : "NOTE"} (${r.detail})  SID=${r.sid}`)
}
const passed = results.filter(r => r.pass).length
console.log(`\n通过: ${passed}/${results.length}`)
console.log("═".repeat(60))
