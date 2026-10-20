/** 保存边界回归：此前五项非法配置必须返回 400，且不能覆盖已保存配置。 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import assert from "node:assert/strict"
import { eq, inArray } from "drizzle-orm"
import { db, pool } from "../src/db/index.js"
import { bizApp } from "../src/db/schema.js"
import { deleteResourceGraph, writeTuples } from "../src/authz/index.js"


const output = process.env.HARNESS_VERIFY_OUTPUT
const authFile = process.env.HARNESS_VERIFY_AUTH_FILE
if (!output || !authFile) throw new Error("需要 HARNESS_VERIFY_OUTPUT 与 HARNESS_VERIFY_AUTH_FILE")
await mkdir(output, { recursive: true })
const token = (await readFile(authFile, "utf8")).trim()
const base = process.env.HARNESS_VERIFY_BASE ?? "http://localhost:3201"
const appId = `harness-validation-${Date.now().toString(36)}`
const cases: { name: string; passed: boolean; detail?: string }[] = []
type Resource = { path: string; type: "doc" | "script" | "template" | "asset"; content: string }
type ValidationDraft = {
  agent: string
  agents: { id: string; config: Record<string, unknown> }[]
  skills: { id: string; content: string; resources: Resource[] }[]
  mcps: unknown[]
  commands: { name: string; template: string }[]
  tools: unknown[]
  plugins: unknown[]
  agentsMd: string
}
const valid: ValidationDraft = {
  agent: "build",
  agents: [],
  skills: [{ id: "validation_skill", content: "检查资源", resources: [{ path: "references/guide.md", type: "doc", content: "验证标识" }] }],
  mcps: [],
  commands: [{ name: "validation_command", template: "只回复 OK" }],
  tools: [],
  plugins: [],
  agentsMd: "",
}
const api = async (path: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const data = await response.json().catch(() => null)
  return { status: response.status, data }
}
const persist = () => writeFile(`${output}/validation-result.json`, JSON.stringify({ appId, cases }, null, 2))
try {
  const [source] = await db.select().from(bizApp).where(eq(bizApp.appId, process.env.HARNESS_VERIFY_SOURCE_APP ?? "rumu-demo-001"))
  assert(source, "缺少用于确定测试用户的应用")
  const now = Date.now()
  await db.insert(bizApp).values({ appId, name: "Harness 校验回归", repoUrl: source.repoUrl, techStack: source.techStack, ownerId: source.ownerId, status: "ready", timeCreated: now, timeUpdated: now })
  await writeTuples(db, [{ resourceType: "app", resourceId: appId, relation: "owner", subjectType: "user", subjectId: source.ownerId, createdBy: source.ownerId }])
  const route = `/api/apps/${appId}/harness`
  assert.equal((await api(route, "PUT", valid)).status, 200)
  const casesToRun: Array<[string, (value: ValidationDraft) => void]> = [
    ["资源路径穿越", (value) => { value.skills[0].resources[0].path = "../secret" }],
    ["资源保留名称", (value) => { value.skills[0].resources[0].path = "SKILL.md" }],
    ["资源文件超限", (value) => { value.skills[0].resources[0].content = "a".repeat(256 * 1024 + 1) }],
    ["命令模板超限", (value) => { value.commands[0].template = "a".repeat(256 * 1024 + 1) }],
    ["空 Agent 标识", (value) => { value.agents = [{ id: "", config: {} }] }],
    ["空白 Command 名称", (value) => { value.commands[0].name = "  " }],
    ["资源文件与目录冲突", (value) => { value.skills[0].resources = [{ path: "docs", type: "doc", content: "" }, { path: "docs/guide.md", type: "doc", content: "" }] }],
  ]
  for (const [name, mutate] of casesToRun) {
    try {
      const next = structuredClone(valid)
      mutate(next)
      const response = await api(route, "PUT", next)
      assert.equal(response.status, 400, `期望 400，实际 ${response.status}`)
      const stored = await api(route)
      assert.equal(stored.status, 200)
      assert.deepEqual((stored.data as { config?: unknown } | null)?.config, valid, "非法配置不应覆盖已保存配置")
      cases.push({ name, passed: true })
    } catch (error) {
      cases.push({ name, passed: false, detail: error instanceof Error ? error.message : String(error) })
    }
    await persist()
  }
  const current = await api(route)
  assert.deepEqual((current.data as { config?: unknown } | null)?.config, valid)
  console.log(`校验回归：${cases.filter((item) => item.passed).length} 通过，${cases.filter((item) => !item.passed).length} 失败`)
} finally {
  await deleteResourceGraph(db, "app", appId)
  await db.delete(bizApp).where(inArray(bizApp.appId, [appId]))
  await persist()
  await pool.end()
  if (cases.some((item) => !item.passed)) process.exitCode = 1
}
