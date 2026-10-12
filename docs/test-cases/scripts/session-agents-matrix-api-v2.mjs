import { assert, authenticate, api, raw, pg, quote, fresh, agents, put, shell, write, check, blocked, close, save, results, container, exec } from "./session-agents-matrix-lib.mjs"

let root
try {
  await authenticate()
  const inspection = JSON.parse((await exec("docker", ["inspect", container])).stdout)[0]
  save("environment", { image: inspection.Config.Image, imageID: inspection.Image, sandbox: inspection.Config.Env.filter(x => /^(OPENCODE_SANDBOX_(ENABLED|DOMAIN|IMAGE)|OPENCODE_CODEMODE_EXECUTOR)=/.test(x)) })
  root = await fresh("api")
  const other = await fresh("isolation")
  await check(31, "内置 Agent ID/mode 与无 scout", async () => {
    const list = await agents(root)
    for (const [id, mode] of [["build", "primary"], ["plan", "primary"], ["general", "subagent"], ["explore", "subagent"]]) assert.equal(list.find(x => x.agent.id === id)?.agent.mode, mode)
    assert(!list.some(x => x.agent.id === "scout"))
    return list.map(x => ({ id: x.agent.id, mode: x.agent.mode, hidden: x.agent.hidden }))
  })
  await check(34, "omitted/primary/subagent/all 字段与 PG", async () => {
    for (const mode of [undefined, "primary", "subagent", "all"]) {
      const id = `matrix-mode-${mode ?? "default"}`
      const r = await put(root, id, mode ? { mode } : {})
      assert.equal(r.agent.mode, mode ?? "primary")
      assert.equal(await pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(root)} AND agent_id=${quote(id)}`), "1")
    }
  })
  await check(35, "disabled 生效/恢复与 hidden 原始列表", async () => {
    await put(root, "matrix-disabled", { mode: "all", hidden: true, system: "HIDDEN_MARK" })
    assert.equal((await agents(root)).find(x => x.agent.id === "matrix-disabled")?.agent.hidden, true)
    await put(root, "matrix-disabled", { disabled: true })
    assert(!(await agents(root)).some(x => x.agent.id === "matrix-disabled"))
    await put(root, "matrix-disabled", { mode: "all", disabled: false })
    assert((await agents(root)).some(x => x.agent.id === "matrix-disabled"))
    return { hiddenIncludedInRawAPI: true }
  })
  await check(36, "Session→sandbox 逐字段合并及删除回退", async () => {
    await put(root, "matrix-merge", { mode: "subagent", system: "SESSION_SYSTEM", description: "session-description", request: { headers: { "x-session": "S" }, body: { session: "S" } }, permissions: [{ action: "read", resource: "src/**", effect: "deny" }] })
    await write(root, "/workspace/.opencode/agents/matrix-merge.md", "---\nmode: all\ndescription: sandbox-description\nrequest:\n  headers:\n    x-sandbox: B\n  body:\n    sandbox: B\npermissions:\n  - action: read\n    resource: src/allowed\n    effect: allow\n---\nSANDBOX_SYSTEM\n")
    const list = (await api(`/api/session/${root}/agents/refresh`, "POST", {})).data
    const found = list.find(x => x.agent.id === "matrix-merge")
    assert.equal(found.source, "sandbox")
    assert.equal(found.agent.mode, "all")
    assert.equal(found.agent.system, "SANDBOX_SYSTEM")
    assert.equal(found.agent.description, "sandbox-description")
    assert.equal(found.agent.request.headers["x-session"], "S")
    assert.equal(found.agent.request.headers["x-sandbox"], "B")
    assert(found.agent.permissions.findIndex(x => x.resource === "src/allowed") > found.agent.permissions.findIndex(x => x.resource === "src/**"))
    await shell(root, "rm -f /workspace/.opencode/agents/matrix-merge.md")
    await api(`/api/session/${root}/agents/refresh`, "POST", {})
    assert.equal((await agents(root)).find(x => x.agent.id === "matrix-merge")?.agent.system, "SESSION_SYSTEM")
  })
  await check(37, "嵌套 ID、兼容目录、损坏 YAML", async () => {
    await write(root, "/workspace/.opencode/agents/team/reviewer.md", "---\nmode: subagent\ndescription: Nested reviewer\n---\nNESTED_SYSTEM\n")
    await write(root, "/workspace/.opencode/agent/legacy-path.md", "---\nmode: all\n---\nLEGACY_PATH\n")
    await write(root, "/workspace/.opencode/agents/matrix-bad.md", "---\nmode: [ broken\n---\nBAD_SYSTEM\n")
    const list = (await api(`/api/session/${root}/agents/refresh`, "POST", {})).data
    assert.equal(list.find(x => x.agent.id === "team/reviewer")?.sourcePath, "team/reviewer.md")
    assert.equal(list.find(x => x.agent.id === "legacy-path")?.agent.system, "LEGACY_PATH")
    const malformed = list.find(x => x.agent.id === "matrix-bad")
    return { malformedAccepted: Boolean(malformed), malformedDefinition: malformed, interpretation: "损坏 YAML 的跳过/正文回退属容错契约，记录实际行为，不预设必须跳过" }
  })
  await check(38, "沙箱新增/修改/删除后强制刷新", async () => {
    const path = "/workspace/.opencode/agents/matrix-cache.md"
    await write(root, path, "---\nmode: subagent\n---\nCACHE_A\n")
    assert.equal((await api(`/api/session/${root}/agents/refresh`, "POST", {})).data.find(x => x.agent.id === "matrix-cache")?.agent.system, "CACHE_A")
    await write(root, path, "---\nmode: all\n---\nCACHE_B_LONGER\n")
    assert.equal((await api(`/api/session/${root}/agents/refresh`, "POST", {})).data.find(x => x.agent.id === "matrix-cache")?.agent.system, "CACHE_B_LONGER")
    await shell(root, `rm -f ${quote(path)}`)
    assert(!(await api(`/api/session/${root}/agents/refresh`, "POST", {})).data.some(x => x.agent.id === "matrix-cache"))
  })
  await check(40, "root/child/grandchild 双向 CRUD、fork 与独立根隔离", async () => {
    const child = await fresh("child", { parentID: root })
    const grandchild = await fresh("grandchild", { parentID: child })
    await put(grandchild, "matrix-owner", { system: "OWNER_ONE" })
    assert.equal((await agents(root)).find(x => x.agent.id === "matrix-owner")?.agent.system, "OWNER_ONE")
    assert.equal(await pg(`SELECT session_id FROM session_agents WHERE agent_id='matrix-owner' AND session_id IN (${[root, child, grandchild].map(quote).join(",")})`), root)
    await put(child, "matrix-owner", { system: "OWNER_TWO" })
    assert.equal((await agents(grandchild)).find(x => x.agent.id === "matrix-owner")?.agent.system, "OWNER_TWO")
    assert(!(await agents(other)).some(x => x.agent.id === "matrix-owner"))
    const fork = (await api(`/api/session/${root}/fork`, "POST", {})).data.id
    assert(!(await agents(fork)).some(x => x.agent.id === "matrix-owner"))
    await api(`/api/session/${fork}`, "DELETE")
    await api(`/api/session/${child}`, "DELETE")
    assert.equal((await agents(root)).find(x => x.agent.id === "matrix-owner")?.agent.system, "OWNER_TWO")
    await api(`/api/session/${root}/agents/matrix-owner`, "DELETE")
    assert.equal(await pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(root)} AND agent_id='matrix-owner'`), "0")
    return { root, child, grandchild, fork }
  })
  await check(42, "Schema 拒绝矩阵与无 PG 副作用", async () => {
    const invalid = [{ steps: 0 }, { steps: -1 }, { steps: 1.5 }, { color: "red" }, { color: "#123" }, { mode: "wrong" }, { model: 12 }, { request: "wrong" }, { permissions: [{ action: "shell", resource: "*", effect: "wrong" }] }]
    for (const [i, config] of invalid.entries()) {
      const r = await raw(`/api/session/${root}/agents`, "POST", { id: `matrix-invalid-${i}`, config })
      assert.equal(r.status, 400, JSON.stringify({ config, r }))
    }
    assert.equal(await pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(root)} AND agent_id LIKE 'matrix-invalid-%'`), "0")
    await put(root, "matrix-schema-valid", { steps: 1, color: "#aAbB09" })
    const unknown = await raw(`/api/session/${root}/agents`, "POST", { id: "matrix-unknown", config: { temperature: 0.1, prompt: "legacy" } })
    return { invalidCount: invalid.length, unknownFieldResult: unknown }
  })
  await check(43, "256KiB 精确 UTF-8 容量边界", async () => {
    const limit = 256 * 1024
    const marks = []
    for (const unit of ["x", "汉🙂", "\"\n\\"]) for (const delta of [-1, 0, 1]) {
      const overhead = Buffer.byteLength(JSON.stringify({ system: "" }))
      const per = Buffer.byteLength(JSON.stringify(unit)) - 2
      const n = Math.floor((limit + delta - overhead) / per)
      const config = { system: unit.repeat(n) + "x".repeat(limit + delta - overhead - n * per) }
      assert.equal(Buffer.byteLength(JSON.stringify(config)), limit + delta)
      const r = await raw(`/api/session/${root}/agents`, "POST", { id: "matrix-boundary", config })
      assert.equal(r.status, delta > 0 ? 413 : 200, `unit=${JSON.stringify(unit)} delta=${delta}`)
      if (delta > 0) assert.equal(r.data.actualBytes, limit + 1)
      marks.push({ unit, delta, status: r.status })
    }
    await api(`/api/session/${root}/agents/matrix-boundary`, "DELETE")
    return marks
  })
  await check(44, "同 ID 并发 upsert 唯一行及时间戳", async () => {
    await put(root, "matrix-race", { description: "initial" })
    const before = Number(await pg(`SELECT time_updated FROM session_agents WHERE session_id=${quote(root)} AND agent_id='matrix-race'`))
    await Promise.all(Array.from({ length: 8 }, (_, i) => put(root, "matrix-race", { description: `race-${i}`, system: `race-${i}` })))
    const row = JSON.parse(await pg(`SELECT row_to_json(s)::text FROM session_agents s WHERE session_id=${quote(root)} AND agent_id='matrix-race'`))
    const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config
    assert.equal(await pg(`SELECT count(*) FROM session_agents WHERE session_id=${quote(root)} AND agent_id='matrix-race'`), "1")
    assert.equal(config.description, config.system)
    assert(Number(row.time_updated) >= before + 8)
    assert.match(config.description, /^race-[0-7]$/)
    return { before, after: row.time_updated, config }
  })
  await check(47, "request 保存与沙箱合并（非模型发送覆盖）", async () => {
    const config = { request: { headers: { "x-matrix": "one" }, body: { test_marker: "one" } } }
    await put(root, "matrix-request", config)
    assert.equal((await agents(root)).find(x => x.agent.id === "matrix-request")?.agent.request.headers["x-matrix"], "one")
    const stored = JSON.parse(await pg(`SELECT config::jsonb FROM session_agents WHERE session_id=${quote(root)} AND agent_id='matrix-request'`))
    assert.equal(stored.request.body.test_marker, "one")
    return { runtimeTransmission: "未使用模型请求捕获探针，不记发送行为通过" }
  })
  await check(68, "鉴权、不存在 Session、根间定义隔离", async () => {
    for (const [path, method, body] of [[`/api/session/${root}/agents`, "GET"], [`/api/session/${root}/agents`, "POST", { id: "bad-auth", config: {} }], [`/api/session/${root}/agents/refresh`, "POST", {}]]) assert.equal((await raw(path, method, body, false)).status, 401)
    for (const [method, body] of [["GET"], ["POST", { id: "missing", config: {} }], ["DELETE"]]) assert.equal((await raw("/api/session/ses_matrix_missing/agents", method, body)).status, 404)
    assert(!(await agents(other)).some(x => x.agent.id === "matrix-request"))
    assert.equal(await pg(`SELECT count(*) FROM session_agents WHERE agent_id='bad-auth' AND session_id=${quote(root)}`), "0")
  })
  await check(70, "沙箱项目 JSONC Agent/default_agent 通道探测", async () => {
    await write(root, "/workspace/.opencode/opencode.json", JSON.stringify({ agents: { "matrix-json-only": { mode: "primary", system: "JSON_ONLY" } }, default_agent: "matrix-json-only" }))
    const list = (await api(`/api/session/${root}/agents/refresh`, "POST", {})).data
    const visible = list.some(x => x.agent.id === "matrix-json-only")
    return { jsonAgentVisible: visible, status: visible ? "配置通道可见，运行语义另验" : "已复现：沙箱项目 JSONC 不进入 Agent 配置发现；不能标为完整支持" }
  })
  blocked(32, "default_agent 服务端配置矩阵需变更全局配置；沿用现有服务，暂不修改")
  blocked(39, "断连/超时故障代理尚未接入现有 OpenSandbox 控制面，避免影响其他会话")
  blocked(69, "全局 Agent 文件/配置热更新需改服务端 operator 配置，暂不修改")
} catch (e) {
  results.push({ status: "failed", error: String(e), stack: e.stack })
} finally {
  await close(results.every(r => r.status !== "failed"))
}
process.exitCode = results.some(r => r.status === "failed") ? 1 : 0
