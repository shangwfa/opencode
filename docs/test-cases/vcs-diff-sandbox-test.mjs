const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const GIT_TOKEN = "eY8gCHMpNWrJpRLHDvK3f286MQp1OmJiCA.01.0y10q698d"
const GIT_REPO = `https://oauth2:${GIT_TOKEN}@gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git`

async function api(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, opts)
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return text }
}

// Step 1: 配置权限 + 创建会话
console.log("━━ Step 1: 创建会话 ━━")
await api("/global/config", "PATCH", {
  permission: { bash: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", read: "allow", webfetch: "allow" },
})
await new Promise(r => setTimeout(r, 3000))
const session = await api("/session", "POST", {})
const sid = session.id
console.log("SID:", sid)

// Step 2: exec 拉取代码
console.log("\n━━ Step 2: exec 拉取代码 ━━")
const clone = await api(`/session/${sid}/exec`, "POST", {
  command: `cd /workspace && rm -rf xybot-front-home-v3 && git clone ${GIT_REPO} xybot-front-home-v3 --depth 1 2>&1 && echo CLONE_OK`,
})
console.log("clone exitCode:", clone.exitCode, clone.stdout?.includes("CLONE_OK") ? "✅" : "❌")
if (clone.exitCode !== 0) { console.log("stderr:", clone.stderr); process.exit(1) }

// Step 3: exec 修改代码
console.log("\n━━ Step 3: exec 修改代码 ━━")
const modify = await api(`/session/${sid}/exec`, "POST", {
  command: `cd /workspace/xybot-front-home-v3 && echo "// VCS_DIFF_TEST_MARKER_$(date +%s)" >> src/App.tsx && echo MODIFIED`,
})
console.log("modify exitCode:", modify.exitCode, modify.stdout?.includes("MODIFIED") ? "✅" : "❌")

// Step 4: keepAlive
console.log("\n━━ Step 4: keepAlive ━━")
await api(`/session/${sid}/keep-alive`, "POST", { enabled: true })
console.log("✅ keepAlive 已启用")

// Step 5: vcs/diff（沙箱存活）
console.log("\n━━ Step 5: vcs/diff（沙箱存活） ━━")
const diff1 = await api(`/vcs/diff?directory=/workspace/xybot-front-home-v3&mode=git&sessionID=${sid}`)
console.log("diff 结果:", Array.isArray(diff1) ? `${diff1.length} 个文件变更` : JSON.stringify(diff1).slice(0, 200))
if (Array.isArray(diff1) && diff1.length > 0) {
  for (const d of diff1) {
    console.log(`  ${d.status} ${d.file} +${d.additions} -${d.deletions}`)
  }
}
const step5Pass = Array.isArray(diff1) && diff1.length > 0
console.log("Step 5 PASS:", step5Pass)

// Step 6: 获取沙箱信息（sandbox ID）
console.log("\n━━ Step 6: 查看沙箱状态 ━━")
const sandboxInfo = await api(`/session/${sid}/sandbox`)
console.log("沙箱状态:", JSON.stringify(sandboxInfo).slice(0, 200))

// Step 7: 关闭沙箱
console.log("\n━━ Step 7: 关闭/销毁沙箱 ━━")
const disposeRes = await fetch(`${BASE}/session/${sid}/sandbox`, { method: "DELETE", headers: { "Content-Type": "application/json" } })
console.log("dispose status:", disposeRes.status)
const disposeBody = await disposeRes.text()
console.log("dispose response:", disposeBody.slice(0, 200))
await new Promise(r => setTimeout(r, 3000))

// 验证沙箱确实被销毁
const sandboxInfo2 = await api(`/session/${sid}/sandbox`)
console.log("销毁后沙箱状态:", JSON.stringify(sandboxInfo2).slice(0, 200))

// Step 8: vcs/diff（沙箱已销毁，应自动重建）
console.log("\n━━ Step 8: vcs/diff（沙箱已销毁，自动重建） ━━")
const diff2 = await api(`/vcs/diff?directory=/workspace/xybot-front-home-v3&mode=git&sessionID=${sid}`)
console.log("diff 结果:", Array.isArray(diff2) ? `${diff2.length} 个文件变更` : JSON.stringify(diff2).slice(0, 200))
if (Array.isArray(diff2) && diff2.length > 0) {
  for (const d of diff2) {
    console.log(`  ${d.status} ${d.file} +${d.additions} -${d.deletions}`)
  }
}
const step8Pass = Array.isArray(diff2) && diff2.length > 0
console.log("Step 8 PASS:", step8Pass)

// 汇总
console.log("\n" + "═".repeat(50))
console.log("VCS Diff 沙箱重建测试结果:")
console.log("  Step 5 (沙箱存活时 diff):", step5Pass ? "✅" : "❌")
console.log("  Step 8 (沙箱销毁后 diff):", step8Pass ? "✅" : "❌")
console.log("  总体:", (step5Pass && step8Pass) ? "✅ 通过" : "❌ 失败")
console.log("═".repeat(50))
