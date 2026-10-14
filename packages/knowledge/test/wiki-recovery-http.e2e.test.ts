/** 真实 Docker HTTP + PG 回归；不调用 LLM、不改业务 schema，需显式启用。 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { Pool } from "pg"
import { createOwnedTestSchema } from "./helpers/owned-schema.js"

const enabled = process.env.KNOWLEDGE_RECOVERY_HTTP_E2E === "1" && Boolean(process.env.KNOWLEDGE_DATABASE_URL)
const suite = enabled ? describe : describe.skip

suite("Wiki recovery failure preserves Docker HTTP process", () => {
  const schema = createOwnedTestSchema("recovery")
  const container = schema.name.replaceAll("_", "-")
  let pool: Pool | undefined
  let created = false
  let base = ""
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 30_000 })
  const request = async (path: string) => {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5_000) })
    return { status: response.status, body: await response.json() as any }
  }

  beforeAll(async () => {
    const databaseUrl = new URL(process.env.KNOWLEDGE_DATABASE_URL!)
    pool = new Pool({ connectionString: databaseUrl.toString() })
    await schema.prepare(pool, schema.name)
    if (["127.0.0.1", "localhost"].includes(databaseUrl.hostname)) databaseUrl.hostname = "host.docker.internal"
    const repo = resolve(import.meta.dir, "../../..")
    const preload = process.env.KNOWLEDGE_RECOVERY_PRELOAD_DIR
    const runtime = process.env.KNOWLEDGE_RECOVERY_RUNTIME_VOLUME
    if (!preload || !runtime) throw new Error("Requires Linux canvas preload directory and runtime volume")
    docker("run", "-d", "--name", container, "--publish", "127.0.0.1::18787",
      "--volume", `${repo}:/repo:ro`, "--volume", `${preload}:/fixtures:ro`,
      "--volume", `${runtime}:/runtime:ro`, "--workdir", "/repo/packages/knowledge",
      "--env", `KNOWLEDGE_DATABASE_URL=${databaseUrl}`, "--env", `KNOWLEDGE_DATABASE_SCHEMA=${schema.name}`,
      "--env", "KNOWLEDGE_PORT=18787", "--env", "no_proxy=host.docker.internal,localhost,127.0.0.1",
      "oven/bun:1.3.14", "bun", "run", "--preload", "/fixtures/linux-preload.mjs", "src/server.ts")
    created = true
    const port = docker("port", container, "18787/tcp").trim().split(":").pop()
    base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 20_000
    while (true) {
      try {
        if ((await request("/health")).status === 200) break
      } catch { /* 在预算内等待启动 */ }
      if (Date.now() >= deadline) throw new Error("Docker knowledge service did not become ready")
      await Bun.sleep(250)
    }
  }, 40_000)

  afterAll(async () => {
    try {
      if (created) docker("rm", "-f", container)
    } finally {
      if (pool) {
        try { await schema.cleanup(pool) } finally { await pool.end() }
      }
    }
  })

  test("missing Wiki recovery table logs failure, leaves other HTTP domains available", async () => {
    expect((await request("/api/knowledge-base")).status).toBe(200)
    const otherTable = await pool!.query(`SELECT count(*)::int AS count FROM "${schema.name}".knowledge_bases`)
    await pool!.query(`DROP TABLE "${schema.name}".wiki_compile_tasks CASCADE`)
    // 故障注入后覆盖一次完整的 15 秒恢复轮询。
    await Bun.sleep(16_500)
    expect(docker("inspect", container, "--format", "{{.State.Running}}").trim()).toBe("true")
    const result = spawnSync("docker", ["logs", container], { encoding: "utf8", timeout: 10_000 })
    expect(result.status).toBe(0)
    const logs = (result.stdout ?? "") + (result.stderr ?? "")
    expect(logs).toContain("[WikiCompiler] task recovery failed:")
    expect(logs).toContain("42P01")
    expect((await request("/health")).status).toBe(200)
    expect((await request("/api/knowledge-base")).status).toBe(200)
    const after = await pool!.query(`SELECT count(*)::int AS count FROM "${schema.name}".knowledge_bases`)
    expect(after.rows).toEqual(otherTable.rows)
  }, 30_000)
})
