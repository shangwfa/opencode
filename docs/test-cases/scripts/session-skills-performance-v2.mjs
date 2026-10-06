import assert from "node:assert/strict"

// 测量实际HTTP输入准备（resume:false），不是模型执行。独立保存每个样本。
export async function measureSkillLoading({ sid, api, command, db, hash, quote, save }) {
  const result = { scope: "真实Docker/PG/OpenSandbox，显式附件加载；不含模型执行", samples: [], summary: [] }
  const repeats = Number(process.env.PROBE_PERF_REPEATS ?? 30)
  assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 100)
  for (const count of [0, 5, 50]) {
    const id = `perf-resources-${count}`
    const resources = Array.from({ length: count }, (_, index) => ({
      path: `references/r${index}.txt`,
      type: "doc",
      content: `${index}:` + "x".repeat(1024),
    }))
    const info = await api("POST", `/api/session/${sid}/skills`, {
      id,
      content: "Read the provided reference resources when executing this skill.",
      resources,
    })
    const directory = `/home/sandbox/.local/share/opencode/session-skills/${sid}/${info.skill.id}/${hash(JSON.stringify({ content: info.skill.content, resources: info.resources.map(({ path, digest }) => ({ path, digest })).toSorted((a, b) => a.path.localeCompare(b.path)) }))}`
    for (const phase of ["cold-bundle", "hot-bundle"]) {
      const n = phase === "cold-bundle" ? Math.min(5, repeats) : repeats
      for (let index = 0; index < n; index++) {
        // 删除仅此内容寻址测试目录中的已知文件，不动会话其他代码。
        if (phase === "cold-bundle" && count) {
          const paths = ["SKILL.md", "resources.json", ...resources.map((r) => r.path)]
          await command(sid, `rm -f ${paths.map((p) => quote(`${directory}/${p}`)).join(" ")}`)
        }
        const started = performance.now()
        const response = await api("POST", `/api/session/${sid}/prompt`, {
          text: `benchmark ${id} ${phase} ${index}`,
          skills: [{ id }],
          resume: false,
        })
        const elapsedMs = performance.now() - started
        assert(response.data.payload.skills[0].text.includes(info.skill.content))
        result.samples.push({
          skillID: id,
          resourceCount: count,
          resourceBytes: resources.reduce((n, r) => n + Buffer.byteLength(r.content), 0),
          phase,
          index,
          elapsedMs,
          inboxID: response.data.id,
        })
        save(result)
      }
    }
    if (count)
      await command(
        sid,
        resources
          .map((r) => `test "$(wc -c < ${quote(`${directory}/${r.path}`)})" -eq ${Buffer.byteLength(r.content)}`)
          .join("; "),
      )
    const row = (await db`select resources from session_skills where session_id=${sid} and skill_id=${id}`)[0]
    assert.deepEqual(JSON.parse(row.resources), resources)
  }
  for (const count of [0, 5, 50])
    for (const phase of ["cold-bundle", "hot-bundle"]) {
      const samples = result.samples
        .filter((s) => s.resourceCount === count && s.phase === phase)
        .map((s) => s.elapsedMs)
        .sort((a, b) => a - b)
      const quantile = (p) => samples[Math.max(0, Math.ceil(p * samples.length) - 1)]
      result.summary.push({
        resourceCount: count,
        phase,
        n: samples.length,
        medianMs: quantile(0.5),
        p95Ms: quantile(0.95),
        minMs: samples[0],
        maxMs: samples.at(-1),
        p95SmallSample: samples.length < 30,
      })
    }
  result.note =
    "cold-bundle只清空资源文件，不清空发现缓存；0资源不发生物化。HTTP耗时包含扫描/PG/物化/admission，未拆分内部span。已有沙箱，未测首次建箱或恢复。"
  save(result)
  return result
}
