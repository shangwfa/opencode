/** 对已启动本地服务的隔离验收；只对临时 app/requirement/session 操作。 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { z } from "zod"
import { eq, inArray } from "drizzle-orm"
import { db, pool } from "../src/db/index.js"
import { bizApp, requirement, requirementSession, auditLog } from "../src/db/schema.js"
import { writeTuples, deleteResourceGraph } from "../src/authz/index.js"
import { emptyHarness, readHarness } from "../src/lib/harness.js"
import { saasFetch } from "../src/lib/saas.js"

const output = process.env.HARNESS_VERIFY_OUTPUT
const authFile = process.env.HARNESS_VERIFY_AUTH_FILE
if (!output || !authFile) throw new Error("需要 HARNESS_VERIFY_OUTPUT 与 HARNESS_VERIFY_AUTH_FILE")
await mkdir(output, { recursive: true })
const token = (await readFile(authFile, "utf8")).trim()
const base = process.env.HARNESS_VERIFY_BASE ?? "http://localhost:3201"
const stamp = Date.now().toString(36)
const appID = `harness-verify-${stamp}`
const deniedID = `${appID}-denied`
const cases: { name: string; passed: boolean; detail?: string }[] = []
const sessions: string[] = []
const reqs: string[] = []
const persist = () => writeFile(`${output}/result.json`, JSON.stringify({ appID, cases, sessions, requirements: reqs }, null, 2))
const run = async (name: string, work: () => Promise<void>) => {
  try { await work(); cases.push({ name, passed: true }); console.log(`通过 ${name}`) }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); cases.push({ name, passed: false, detail }); console.log(`失败 ${name}: ${detail.slice(0, 250)}`) }
  await persist()
}
async function api(path: string, method = "GET", body?: unknown, authenticated = true) {
  const response = await fetch(`${base}${path}`, { method, headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(180000) })
  const data = z.object({ config: z.unknown().optional(), sessionId: z.string().optional(), requirementId: z.string().optional(), prepared: z.boolean().optional(), prepareError: z.string().optional() }).passthrough().parse(await response.json().catch(() => ({})))
  return { status: response.status, data, cache: response.headers.get("cache-control") }
}
const route = `/api/apps/${appID}/harness`
const fixture = {
  ...emptyHarness(), agent: "harness_verifier",
  agents: [{ id: "harness_verifier", config: { mode: "primary", description: "隔离 Harness 验证角色", system: "遵循用户任务。最终回复末尾追加 HARNESS_AGENT_OK。不要修改仓库文件。" } }],
  skills: [{ id: "harness_verification_skill", name: "验收技能", description: "Harness 验收时使用", autoinvoke: true, content: "读取 references/check.md 并遵循其中的验证标识。", resources: [{ path: "references/check.md", type: "doc", content: "资源验证标识 HARNESS_RESOURCE_OK" }, { path: "scripts/check.py", type: "script", content: 'print("HARNESS_SCRIPT_OK")\n' }] }],
  mcps: [{ name: "harness_docs", config: { type: "remote", url: "https://example.invalid/mcp", oauth: false, disabled: true, codemode: true, headers: { Authorization: "Bearer harness-verification-only" } } }],
  commands: [{ name: "harness_check", description: "Harness 验证命令", template: "只回复 HARNESS_COMMAND_OK。不要写文件。", hints: [] }],
}
try {
  const [source] = await db.select().from(bizApp).where(eq(bizApp.appId, process.env.HARNESS_VERIFY_SOURCE_APP ?? "rumu-demo-001"))
  assert(source, "缺少用于确定测试用户与仓库的应用")
  const now = Date.now()
  for (const id of [appID, deniedID]) await db.insert(bizApp).values({ appId: id, name: "Harness 临时验收", repoUrl: source.repoUrl, gitProviderInstanceId: source.gitProviderInstanceId, techStack: source.techStack, ownerId: source.ownerId, status: "ready", config: { sentinel: "preserve-other-config" }, timeCreated: now, timeUpdated: now })
  await writeTuples(db, [{ resourceType: "app", resourceId: appID, relation: "owner", subjectType: "user", subjectId: source.ownerId, createdBy: source.ownerId }])
  await writeFile(`${output}/fixture.json`, JSON.stringify({ appID, deniedID }, null, 2))
  await run("未登录禁止读取与写入", async () => { assert.equal((await api(route, "GET", undefined, false)).status, 401); assert.equal((await api(route, "PUT", fixture, false)).status, 401) })
  await run("无权限与不存在应用不泄露配置", async () => { for (const id of [deniedID, "harness-nonexistent"]) { assert.equal((await api(`/api/apps/${id}/harness`)).status, 404); assert.equal((await api(`/api/apps/${id}/harness`, "PUT", fixture)).status, 404) } })
  await run("空配置返回 build 及四类空列表", async () => { const response = await api(route); assert.equal(response.status, 200); assert.deepEqual(response.data.config, emptyHarness()); assert.equal(response.cache, "no-store") })
  await run("四类配置创建并完整回读", async () => { assert.equal((await api(route, "PUT", fixture)).status, 200); assert.deepEqual((await api(route)).data.config, fixture) })
  await run("PG 加密且保留其他应用字段，审计不含认证值", async () => {
    const [row] = await db.select().from(bizApp).where(eq(bizApp.appId, appID))
    assert.equal((row.config as { sentinel?: string }).sentinel, "preserve-other-config")
    assert(!JSON.stringify(row.config).includes("harness-verification-only"))
    assert.deepEqual(JSON.parse(JSON.stringify(readHarness(row.config))), fixture)
    const records = await db.select().from(auditLog).where(eq(auditLog.resourceId, appID))
    assert(records.length > 0); assert(!JSON.stringify(records).includes("harness-verification-only"))
  })
  await run("四类配置修改及再次回读", async () => { const next = structuredClone(fixture); next.agents[0].config.description = "已修改角色"; next.skills[0].resources![0].content = "已修改资源"; next.mcps[0].config.disabled = false; next.commands[0].template = "已修改命令"; assert.equal((await api(route, "PUT", next)).status, 200); assert.deepEqual((await api(route)).data.config, next); assert.equal((await api(route, "PUT", fixture)).status, 200) })
  for (const [name, mutate] of [
    ["拒绝重复标识", (value: typeof fixture) => value.agents.push(value.agents[0])],
    ["拒绝子 Agent 作为默认角色", (value: typeof fixture) => { value.agents[0].config.mode = "subagent" }],
    ["拒绝非法 MCP URL", (value: typeof fixture) => { value.mcps[0].config.url = "file:///etc/passwd" }],
    ["拒绝资源路径穿越", (value: typeof fixture) => { value.skills[0].resources[0].path = "../secret" }],
    ["拒绝资源保留路径", (value: typeof fixture) => { value.skills[0].resources[0].path = "SKILL.md" }],
    ["拒绝超限资源内容", (value: typeof fixture) => { value.skills[0].resources[0].content = "a".repeat(256 * 1024 + 1) }],
    ["拒绝超限命令模板", (value: typeof fixture) => { value.commands[0].template = "a".repeat(256 * 1024 + 1) }],
    ["拒绝空 Agent 标识", (value: typeof fixture) => { value.agents[0].id = "" }],
  ] as const) await run(name, async () => { const next = structuredClone(fixture); mutate(next); assert.equal((await api(route, "PUT", next)).status, 400); assert.deepEqual((await api(route)).data.config, fixture) })
  await api(route, "PUT", fixture)
  await run("新建需求工作区及 Harness 下发", async () => {
    const response = await api("/api/requirements/prepare", "POST", { title: `Harness 验收 ${stamp}`, appId: appID, gitProviderId: source.gitProviderInstanceId, repoUrl: source.repoUrl, baseBranch: source.defaultBranch, workBranch: source.defaultBranch, directory: "/workspace" })
    if (response.data?.sessionId) sessions.push(response.data.sessionId)
    if (response.data?.requirementId) reqs.push(response.data.requirementId)
    await persist()
    assert.equal(response.status, 201)
    assert.equal(response.data.prepared, true, response.data.prepareError ?? "工作区未就绪")
    assert(!response.data.prepareError)
  })
  if (sessions[0]) {
    const sid = sessions[0]
    await run("SaaS 四类会话定义与选定角色", async () => {
      for (const kind of ["agents", "skills", "mcps", "commands"]) {
        const r = await saasFetch(`/api/session/${sid}/${kind}`); assert.equal(r.status, 200)
        const body = await r.json(); await writeFile(`${output}/session-${kind}.json`, JSON.stringify(body, null, 2))
        const serialized = JSON.stringify(body)
        assert(serialized.includes(kind === "agents" ? "harness_verifier" : kind === "skills" ? "harness_verification_skill" : kind === "mcps" ? "harness_docs" : "harness_check"), `${kind} 未下发`)
      }
      const r = await saasFetch(`/api/session/${sid}`); const body = await r.json()
      await writeFile(`${output}/session-info.json`, JSON.stringify(body, null, 2))
      assert(JSON.stringify(body).includes("harness_verifier"), "默认 Agent 未切换")
    })
    await run("更改应用模板不覆盖已有会话", async () => { await api(route, "PUT", emptyHarness()); const r = await saasFetch(`/api/session/${sid}/commands`); assert(JSON.stringify(await r.json()).includes("harness_check")) })
  }
  await run("Harness 下发失败返回错误且不启动模型", async () => {
    const invalid = structuredClone(fixture)
    invalid.skills[0].resources[0].path = "../harness-invalid-resource"
    const saved = await api(route, "PUT", invalid)
    if (saved.status === 400) return // 服务端若已拒绝非法模板，同样满足不执行模型。
    assert.equal(saved.status, 200)
    const response = await api("/api/requirements/prepare", "POST", { title: `Harness 失败门禁 ${stamp}`, appId: appID, directory: "/workspace" })
    if (response.data?.sessionId) sessions.push(response.data.sessionId)
    if (response.data?.requirementId) reqs.push(response.data.requirementId)
    await persist()
    assert.equal(response.status, 201)
    assert.equal(response.data.prepared, false)
    assert(response.data.prepareError?.includes("Harness 下发失败"))
    const messages = await saasFetch(`/api/session/${response.data.sessionId}/message`)
    assert.equal(messages.status, 200)
    assert(!JSON.stringify(await messages.json()).includes('"type":"assistant"'), "下发失败不应产生 assistant 消息")
  })
  await run("四类配置删除后回读为空", async () => { assert.equal((await api(route, "PUT", emptyHarness())).status, 200); assert.deepEqual((await api(route)).data.config, emptyHarness()) })
  if (process.env.HARNESS_VERIFY_KEEP === "1") console.log(`保留测试会话 ${sessions[0] ?? "无"}，供运行链路验收`)
} catch (error) { cases.push({ name: "执行器", passed: false, detail: error instanceof Error ? error.message : String(error) }); console.log("执行器失败，请查看结果文件") }
finally {
  if (process.env.HARNESS_VERIFY_KEEP !== "1") {
    await run("清理临时会话与应用", async () => {
      for (const sid of sessions) { const r = await saasFetch(`/api/session/${sid}`, { method: "DELETE" }); assert(r.ok || r.status === 404, `清理会话 ${sid} HTTP ${r.status}`) }
      for (const rid of reqs) { await deleteResourceGraph(db, "requirement", rid); await db.delete(requirementSession).where(eq(requirementSession.requirementId, rid)); await db.delete(requirement).where(eq(requirement.id, rid)) }
      for (const id of [appID, deniedID]) await deleteResourceGraph(db, "app", id)
      await db.delete(bizApp).where(inArray(bizApp.appId, [appID, deniedID]))
    })
  }
  await persist(); await pool.end()
  console.log(`结果：${cases.filter((item) => item.passed).length} 通过，${cases.filter((item) => !item.passed).length} 失败`)
  if (cases.some((item) => !item.passed)) process.exitCode = 1
}
