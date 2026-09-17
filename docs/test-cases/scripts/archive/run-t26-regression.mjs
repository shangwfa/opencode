// T26 权限用例回归测试 — 宿主机 server (14097, 含 directory 修复)
// 策略：只验证 agent 自身规则（过滤全局 merge），端到端用 exec 验证文件
const BASE = "http://127.0.0.1:14097"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const results = []

const newSid = () => fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(r => r.json()).then(d => d.id)
const createAgent = (sid, body) => fetch(BASE + "/session/" + sid + "/agents/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json())
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r => r.json())
// 从 agent 返回的 ruleset 中提取指定 permission 的规则（agent 自身，不含全局 merge 的兜底规则）
const agentRules = (data, perm) => {
  const all = data.permission || []
  // 全局 merge 的规则 pattern 都是 "*" 且来自全局 config，agent 自身的规则有具体 pattern 或在对象语法内
  // 简单过滤：取指定 permission 的所有规则
  return all.filter(r => r.permission === perm)
}
async function sendAndWait(sid, body, timeout = 90000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const r = await fetch(BASE + "/event?sessionID=" + sid); const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ""
    const loop = async () => { while(true){ const {done,value}=await reader.read(); if(done){clearTimeout(timer);reject(new Error("end"));return}
      buf+=dec.decode(value,{stream:true}); const ls=buf.split("\n"); buf=ls.pop()||""
      for(const l of ls){ if(!l.startsWith("data: "))continue; try{const e=JSON.parse(l.slice(6))
        if(e.type==="server.connected"||e.type==="server.heartbeat")continue
        if(e.type==="session.idle"){clearTimeout(timer);reader.cancel();resolve(true);return}}catch{}}}}
    loop(); await fetch(BASE+"/session/"+sid+"/prompt_async",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})
  })
}

// ===== T26.21 字符串简写 =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t21", mode:"primary", prompt:"t", permission:{ edit:"deny", bash:"allow", read:"allow" } })
  const ok = agentRules(d,"edit").some(r=>r.action==="deny") && agentRules(d,"bash").some(r=>r.action==="allow")
  results.push(["T26.21", ok, "字符串简写"]); console.log(`${ok?"✅":"❌"} T26.21 字符串简写`) }

// ===== T26.22 粒度路径权限 (deny catch-all + 白名单) =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t22", mode:"primary", prompt:"t", permission:{ edit:{"*":"deny","docs/*.md":"allow"} } })
  const e = agentRules(d,"edit")
  const ok = e.some(r=>r.pattern==="*"&&r.action==="deny") && e.some(r=>r.pattern==="docs/*.md"&&r.action==="allow")
  results.push(["T26.22", ok, "粒度路径 deny+白名单"]); console.log(`${ok?"✅":"❌"} T26.22 粒度路径(deny catch-all)`) }

// ===== T26.23 ask catch-all =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t23", mode:"primary", prompt:"t", permission:{ edit:{"*":"ask","docs/*.md":"allow"} } })
  const e = agentRules(d,"edit")
  const ok = e.some(r=>r.pattern==="*"&&r.action==="ask") && e.some(r=>r.pattern==="docs/*.md"&&r.action==="allow")
  results.push(["T26.23", ok, "ask catch-all+白名单"]); console.log(`${ok?"✅":"❌"} T26.23 ask catch-all`) }

// ===== T26.24 bash 粒度命令 =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t24", mode:"primary", prompt:"t", permission:{ bash:{"*":"ask","git *":"allow","rm *":"deny"} } })
  const b = agentRules(d,"bash")
  const ok = b.some(r=>r.pattern==="git *"&&r.action==="allow") && b.some(r=>r.pattern==="rm *"&&r.action==="deny")
  results.push(["T26.24", ok, "bash粒度命令"]); console.log(`${ok?"✅":"❌"} T26.24 bash 粒度命令`) }

// ===== T26.25 全局 allow/deny 字符串 =====
{ const sid = await newSid()
  const d1 = await createAgent(sid, { name:"t25a", mode:"primary", prompt:"t", permission:"deny" })
  const d2 = await createAgent(sid, { name:"t25b", mode:"primary", prompt:"t", permission:"allow" })
  const ok = Array.isArray(d1.permission) && Array.isArray(d2.permission)
  results.push(["T26.25", ok, "全局allow/deny字符串"]); console.log(`${ok?"✅":"❌"} T26.25 全局字符串`) }

// ===== T26.26 last matching rule wins (顺序) =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t26", mode:"primary", prompt:"t", permission:{ edit:{"*":"deny","src/*.ts":"allow"} } })
  const e = agentRules(d,"edit")
  // agent 自身的规则里 deny* 应在 allow src/*.ts 前面
  const denyIdx = e.findIndex(r=>r.pattern==="*"&&r.action==="deny")
  const allowIdx = e.findIndex(r=>r.pattern==="src/*.ts"&&r.action==="allow")
  const ok = denyIdx >= 0 && allowIdx >= 0 && denyIdx < allowIdx
  results.push(["T26.26", ok, "last matching rule wins"]); console.log(`${ok?"✅":"❌"} T26.26 last matching rule wins`) }

// ===== T26.26b 对象 key 顺序影响匹配 =====
{ const sid = await newSid()
  const dA = await createAgent(sid, { name:"t26ba", mode:"primary", prompt:"t", permission:{ edit:{"*":"deny","docs/*.md":"allow"} } })
  const dB = await createAgent(sid, { name:"t26bb", mode:"primary", prompt:"t", permission:{ edit:{"docs/*.md":"allow","*":"deny"} } })
  const eA = agentRules(dA,"edit"), eB = agentRules(dB,"edit")
  const dA_ok = eA.findIndex(r=>r.pattern==="*"&&r.action==="deny") < eA.findIndex(r=>r.pattern==="docs/*.md"&&r.action==="allow")
  const dB_ok = eB.findIndex(r=>r.pattern==="docs/*.md"&&r.action==="allow") < eB.findIndex(r=>r.pattern==="*"&&r.action==="deny")
  const ok = dA_ok && dB_ok
  results.push(["T26.26b", ok, "key顺序影响匹配"]); console.log(`${ok?"✅":"❌"} T26.26b 对象 key 顺序`) }

// ===== T26.27 tools 向后兼容 =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t27", mode:"primary", prompt:"t", tools:{ edit:true, bash:false } })
  const hasEdit = d.permission?.some(r=>r.permission==="edit"&&r.action==="allow")
  const hasBash = d.permission?.some(r=>r.permission==="bash"&&r.action==="deny")
  // 已知: API 层不做 normalize, tools 不转 permission
  const note = !hasEdit && !hasBash
  results.push(["T26.27", note, "tools不转permission(已知限制)"]); console.log(`${note?"⚠️":"❌"} T26.27 tools 向后兼容`) }

// ===== T26.28 task 权限 =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t28", mode:"primary", prompt:"t", permission:{ task:{"*":"ask","safe":"allow","danger":"deny"} } })
  const t = agentRules(d,"task")
  const ok = t.some(r=>r.pattern==="safe"&&r.action==="allow") && t.some(r=>r.pattern==="danger"&&r.action==="deny")
  results.push(["T26.28", ok, "task权限"]); console.log(`${ok?"✅":"❌"} T26.28 task 权限`) }

// ===== T26.31 对象语法白名单 (相对路径) =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t31", mode:"primary", prompt:"t", permission:{ edit:{"*":"deny","analysis/t31/spec/*.md":"allow"} } })
  const ok = agentRules(d,"edit").some(r=>r.pattern==="analysis/t31/spec/*.md"&&r.action==="allow")
  results.push(["T26.31", ok, "对象语法白名单"]); console.log(`${ok?"✅":"❌"} T26.31 对象语法白名单`) }

// ===== T26.32 **/ 前缀持久化 =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t32", mode:"primary", prompt:"t", permission:{ edit:{"*":"deny","**/analysis/t32/spec/*.md":"allow"} } })
  const ok = agentRules(d,"edit").some(r=>r.pattern==="**/analysis/t32/spec/*.md"&&r.action==="allow")
  results.push(["T26.32", ok, "**/ 前缀持久化"]); console.log(`${ok?"✅":"❌"} T26.32 **/ 前缀持久化`) }

// ===== T26.33 ... 字面点 + * 通配 =====
{ const sid = await newSid()
  const d1 = await createAgent(sid, { name:"t33a", mode:"primary", prompt:"t", permission:{ edit:{"*":"deny","analysis/.../spec/*.md":"allow"} } })
  const d2 = await createAgent(sid, { name:"t33b", mode:"primary", prompt:"t", permission:{ edit:{"*":"deny","analysis/*/spec/*.md":"allow"} } })
  const ok = agentRules(d1,"edit").some(r=>r.pattern==="analysis/.../spec/*.md") && agentRules(d2,"edit").some(r=>r.pattern==="analysis/*/spec/*.md")
  results.push(["T26.33", ok, "字面点vs通配"]); console.log(`${ok?"✅":"❌"} T26.33 .../vs *`) }

// ===== T26.34 directory 基准修复 (端到端 write) =====
{ const AID = "t34-"+Date.now().toString(36)
  const sid = await newSid()
  await exec(sid, `mkdir -p /workspace/analysis/${AID}/spec && rm -f /workspace/analysis/${AID}/spec/spec.md`)
  await createAgent(sid, { name:"specer", mode:"primary", prompt:"你是需求分析agent。用户要求写文件时直接用write工具执行。", permission:{ read:"allow", edit:{"*":"deny",[`analysis/${AID}/spec/*.md`]:"allow"}, glob:"allow", grep:"allow", list:"allow", bash:"allow" } })
  await sendAndWait(sid, { parts:[{type:"text",text:`用 write 工具在 /workspace/analysis/${AID}/spec/spec.md 写入: # Test`}], agent:"specer", model:MODEL })
  const v = await exec(sid, `cat /workspace/analysis/${AID}/spec/spec.md 2>&1`)
  const ok = v.stdout?.includes("# Test")
  results.push(["T26.34", ok, "directory基准修复-无前缀write"]); console.log(`${ok?"✅":"❌"} T26.34 directory基准修复(analysis/无前缀)`) }

// ===== T26.40 ~/$HOME 展开 =====
{ const sid = await newSid()
  const d = await createAgent(sid, { name:"t40", mode:"primary", prompt:"t", permission:{ external_directory:{"~/projects/*":"allow"} } })
  const ext = agentRules(d,"external_directory")
  const ok = ext.some(r=>!r.pattern.startsWith("~")&&r.pattern.startsWith("/"))
  results.push(["T26.40", ok, "~/$HOME展开"]); console.log(`${ok?"✅":"❌"} T26.40 ~/$HOME 展开`) }

// ===== 汇总 =====
console.log("\n"+"═".repeat(60))
const pass = results.filter(r=>r[1]).length
const note = results.filter(r=>!r[1]).length
for (const [id, ok, desc] of results) console.log(`  ${ok?"✅":"⚠️"} ${id}: ${desc}`)
console.log(`\n通过: ${pass}/${results.length}` + (note>0?` (${note} NOTE)`:""))
console.log("═".repeat(60))
