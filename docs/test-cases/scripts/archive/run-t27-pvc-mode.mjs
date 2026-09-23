const BASE = "http://localhost:14096"
const results = []

const newSid = (body) => fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then(r => r.json())
const exec = (sid, cmd) => fetch(BASE + "/session/" + sid + "/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: cmd }) }).then(r => r.json())

// T27.1 默认行为
{
  const sid = await newSid({})
  const pass = sid.pvcMode === undefined
  results.push(["T27.1", pass, `pvcMode=${sid.pvcMode ?? "undefined"}`])
  console.log(`${pass?"✅":"❌"} T27.1 默认行为: pvcMode=${sid.pvcMode ?? "undefined"}`)
}

// T27.2 显式 session
{
  const sid = await newSid({ pvcMode: "session" })
  const pass = sid.pvcMode === "session"
  results.push(["T27.2", pass, `pvcMode=${sid.pvcMode}`])
  console.log(`${pass?"✅":"❌"} T27.2 显式session: pvcMode=${sid.pvcMode}`)
}

// T27.3 app + appId
{
  const sid = await newSid({ pvcMode: "app", appId: "test-app-1" })
  const pass = sid.pvcMode === "app" && sid.appId === "test-app-1"
  results.push(["T27.3", pass, `pvcMode=${sid.pvcMode} appId=${sid.appId}`])
  console.log(`${pass?"✅":"❌"} T27.3 app+appId: pvcMode=${sid.pvcMode} appId=${sid.appId}`)
}

// T27.4 app 缺 appId → 报错
{
  const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app" }) })
  const body = await res.text()
  const pass = res.status >= 400
  results.push(["T27.4", pass, `status=${res.status}`])
  console.log(`${pass?"✅":"❌"} T27.4 app缺appId: status=${res.status}`)
}

// T27.5 app 空白 appId → 报错
{
  const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "app", appId: "   " }) })
  const pass = res.status >= 400
  results.push(["T27.5", pass, `status=${res.status}`])
  console.log(`${pass?"✅":"❌"} T27.5 空白appId: status=${res.status}`)
}

// T27.6 非法 pvcMode → 报错
{
  const res = await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pvcMode: "global" }) })
  const pass = res.status >= 400
  results.push(["T27.6", pass, `status=${res.status}`])
  console.log(`${pass?"✅":"❌"} T27.6 非法pvcMode: status=${res.status}`)
}

// T27.7 同 appId 共享 PVC
{
  const APP_ID = "share-" + Date.now().toString(36)
  const sidA = (await newSid({ pvcMode: "app", appId: APP_ID })).id
  await exec(sidA, "mkdir -p /workspace/repo && echo shared-content > /workspace/repo/shared.txt")
  const wA = await exec(sidA, "cat /workspace/repo/shared.txt")
  
  const sidB = (await newSid({ pvcMode: "app", appId: APP_ID })).id
  const rB = await exec(sidB, "cat /workspace/repo/shared.txt 2>&1")
  const pass = rB.stdout?.includes("shared-content")
  results.push(["T27.7", pass, pass ? "共享成功" : "B读到: " + rB.stdout?.trim()])
  console.log(`${pass?"✅":"❌"} T27.7 同appId共享: ${pass ? "成功" : "B读到: " + rB.stdout?.trim()?.slice(0,60)}`)
}

// T27.8 不同 appId 隔离
{
  const TS = Date.now().toString(36)
  const sidA = (await newSid({ pvcMode: "app", appId: "iso-a-" + TS })).id
  await exec(sidA, "mkdir -p /workspace/repo && echo from-a > /workspace/repo/iso.txt")
  
  const sidB = (await newSid({ pvcMode: "app", appId: "iso-b-" + TS })).id
  const rB = await exec(sidB, "cat /workspace/repo/iso.txt 2>&1")
  const pass = rB.stdout?.includes("No such file") || !rB.stdout?.includes("from-a")
  results.push(["T27.8", pass, pass ? "隔离成功" : "泄漏"])
  console.log(`${pass?"✅":"❌"} T27.8 不同appId隔离: ${pass ? "成功" : "泄漏!"}`)
}

// T27.9 session/app 隔离
{
  const TS = Date.now().toString(36)
  const sidS = (await newSid({ pvcMode: "session" })).id
  await exec(sidS, "mkdir -p /workspace/repo && echo session-data > /workspace/repo/s.txt")
  
  const sidA = (await newSid({ pvcMode: "app", appId: "cross-" + TS })).id
  const rA = await exec(sidA, "cat /workspace/repo/s.txt 2>&1")
  const pass = rA.stdout?.includes("No such file") || !rA.stdout?.includes("session-data")
  results.push(["T27.9", pass, pass ? "隔离成功" : "泄漏"])
  console.log(`${pass?"✅":"❌"} T27.9 session/app隔离: ${pass ? "成功" : "泄漏!"}`)
}

// T27.10 自动 worktree
{
  const APP_ID = "wt-" + Date.now().toString(36)
  const sid = (await newSid({ pvcMode: "app", appId: APP_ID })).id
  await exec(sid, "mkdir -p /workspace/repo && cd /workspace/repo && git init && echo h > R.md && git add . && git commit -m init 2>&1")
  await exec(sid, "echo trigger")  // 触发 sandbox 创建 + worktree
  await new Promise(r => setTimeout(r, 5000))
  const wt = await exec(sid, "ls -d /workspace/worktrees/*/ 2>&1")
  const pass = wt.stdout?.includes("worktrees")
  results.push(["T27.10", pass, wt.stdout?.trim()?.slice(0,60)])
  console.log(`${pass?"✅":"❌"} T27.10 自动worktree: ${wt.stdout?.trim()?.slice(0,80)}`)
}

// T27.11 repo 不存在时降级
{
  const APP_ID = "norepo-" + Date.now().toString(36)
  const sid = (await newSid({ pvcMode: "app", appId: APP_ID })).id
  const r1 = await exec(sid, "echo ok-no-repo")
  const wt = await exec(sid, "ls -d /workspace/worktrees/*/ 2>&1")
  const pass = r1.exitCode === 0
  results.push(["T27.11", pass, `exec=${r1.exitCode} wt=${wt.stdout?.trim()?.slice(0,40)}`])
  console.log(`${pass?"✅":"❌"} T27.11 repo不存在降级: exec=${r1.exitCode} wt=${wt.stdout?.trim()?.slice(0,40)}`)
}

// T27.12 worktree 幂等
{
  const APP_ID = "idem-" + Date.now().toString(36)
  const sid = (await newSid({ pvcMode: "app", appId: APP_ID })).id
  await exec(sid, "mkdir -p /workspace/repo && cd /workspace/repo && git init && echo h > R.md && git add . && git commit -m init 2>&1")
  await exec(sid, "echo first")
  await new Promise(r => setTimeout(r, 5000))
  const wt1 = await exec(sid, "ls -d /workspace/worktrees/*/ 2>&1 | wc -l")
  
  await fetch(BASE + "/session/" + sid + "/kill-sandbox", { method: "POST" })
  await new Promise(r => setTimeout(r, 2000))
  await exec(sid, "echo second")
  await new Promise(r => setTimeout(r, 5000))
  const wt2 = await exec(sid, "ls -d /workspace/worktrees/*/ 2>&1 | wc -l")
  
  const pass = parseInt(wt1.stdout?.trim()||"0") === parseInt(wt2.stdout?.trim()||"0")
  results.push(["T27.12", pass, `wt1=${wt1.stdout?.trim()} wt2=${wt2.stdout?.trim()}`])
  console.log(`${pass?"✅":"❌"} T27.12 worktree幂等: wt1=${wt1.stdout?.trim()} wt2=${wt2.stdout?.trim()}`)
}

// T27.13 PG 持久化
{
  const APP_ID = "pg-" + Date.now().toString(36)
  const sid = (await newSid({ pvcMode: "app", appId: APP_ID })).id
  const info = await (await fetch(BASE + "/session/" + sid)).json()
  const pass = info.pvcMode === "app" && info.appId === APP_ID
  results.push(["T27.13", pass, `pvcMode=${info.pvcMode} appId=${info.appId}`])
  console.log(`${pass?"✅":"❌"} T27.13 PG持久化: pvcMode=${info.pvcMode} appId=${info.appId}`)
}

// 汇总
console.log("\n" + "═".repeat(60))
for (const [id, pass, desc] of results) console.log(`  ${pass?"✅":"❌"} ${id}: ${desc}`)
console.log(`\n通过: ${results.filter(r=>r[1]).length}/${results.length}`)
console.log("═".repeat(60))
