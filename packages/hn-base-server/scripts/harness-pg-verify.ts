import { readFile, writeFile } from "node:fs/promises"
import assert from "node:assert/strict"
import { Pool } from "pg"
import { eq, inArray } from "drizzle-orm"
import { db, pool } from "../src/db/index.js"
import { bizApp, requirement, requirementSession } from "../src/db/schema.js"
import { deleteResourceGraph } from "../src/authz/index.js"
import { env } from "../src/config/env.js"
import { saasFetch } from "../src/lib/saas.js"

const output = process.env.HARNESS_VERIFY_OUTPUT!
const fixture = JSON.parse(await readFile(`${output}/fixture.json`, "utf8"))
const result = JSON.parse(await readFile(`${output}/result.json`, "utf8"))
const url = new URL(env.databaseUrl)
url.pathname = process.env.HARNESS_VERIFY_SAAS_DATABASE ?? "/opencode_shell_test"
const saas = new Pool({ connectionString: url.toString() })
const evidence: Record<string, unknown> = {}
try {
  const sid = result.sessions[0]
  const counts: Record<string, number> = {}
  for (const table of ["session_agents", "session_skills", "session_mcps", "session_commands"]) {
    const response = await saas.query(`select count(*)::int as count from ${table} where session_id=$1`, [sid])
    counts[table] = response.rows[0].count
    assert(counts[table] > 0, `${table} 定义丢失`)
  }
  evidence.counts = counts
  const session = (await saas.query("select agent,idle_outcome from session_v2 where id=$1", [sid])).rows[0]
  assert.equal(session.agent, "harness_verifier")
  assert.equal(session.idle_outcome, "succeeded")
  evidence.session = session
  const skill = (await saas.query("select skill_id,jsonb_array_length(resources::jsonb) as resource_count from session_skills where session_id=$1", [sid])).rows
  assert.equal(skill[0].resource_count, 2)
  evidence.skill = skill
  const messages = (await saas.query("select data from session_message where session_id=$1 and type='assistant' order by seq desc limit 1", [sid])).rows
  const serialized = JSON.stringify(messages[0]?.data)
  evidence.assistantMarkers = { command: serialized?.includes("HARNESS_COMMAND_OK"), agent: serialized?.includes("HARNESS_AGENT_OK") }
  assert(serialized?.includes("HARNESS_COMMAND_OK") && serialized.includes("HARNESS_AGENT_OK"))
  evidence.passed = true
} catch (error) { evidence.passed = false; evidence.error = error instanceof Error ? error.message : String(error); process.exitCode = 1 }
finally {
  await writeFile(`${output}/pg-evidence.json`, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence))
  await saas.end()
  try {
    for (const sid of result.sessions) { const response = await saasFetch(`/api/session/${sid}`, { method: "DELETE" }); assert(response.ok || response.status === 404, `清理会话 ${sid} HTTP ${response.status}`) }
    for (const rid of result.requirements) { await deleteResourceGraph(db, "requirement", rid); await db.delete(requirementSession).where(eq(requirementSession.requirementId, rid)); await db.delete(requirement).where(eq(requirement.id, rid)) }
    for (const id of [fixture.appID, fixture.deniedID]) await deleteResourceGraph(db, "app", id)
    await db.delete(bizApp).where(inArray(bizApp.appId, [fixture.appID, fixture.deniedID]))
    const remaining = await db.select({ id: bizApp.appId }).from(bizApp).where(inArray(bizApp.appId, [fixture.appID, fixture.deniedID]))
    assert.equal(remaining.length, 0)
    await writeFile(`${output}/cleanup.json`, JSON.stringify({ passed: true, appsRemoved: 2, sessionsRemoved: result.sessions.length, requirementsRemoved: result.requirements.length }))
    console.log("临时会话、应用及需求已清理；审计记录保留")
  } finally { await pool.end() }
}
