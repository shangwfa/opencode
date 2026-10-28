# Agent 版 GraphRAG 管道（Session graph agent 承担检索问答）

> 定位：图谱问答编排（查询理解 → 图检索 → 证据筛选 → 生成）由 **opencode saas 会话内注册的 graph agent** 承担；
> 知识服务只提供基础图检索能力（`POST /api/graph/search`）。对齐 [../rag/agent-rag.md](../rag/agent-rag.md) 的 rag agent 模式与 V2 Session Agents 契约。

## 契约速查（V2）

| 操作 | 路由 | 说明 |
|---|---|---|
| 创建会话 | `POST /api/session` | `{ location: { directory: "/workspace" }, model }` |
| 创建 graph agent | `POST /api/session/:sid/agents` | body `{ id: "graph", config: { system, description, mode: "primary" } }` |
| 选择 agent | `POST /api/session/:sid/agent` | body `{ agent: "graph" }` → 204 |
| 提问 | `POST /api/session/:sid/prompt_stream` | body `{ text, metadata: {}, delivery: "queue" }`，SSE |
| 收回答 | `GET /api/session/:sid/message?order=asc` | 最后一条 assistant 的 `content[].text` |
| 订阅执行过程 | `GET /api/session/:sid/event` | SSE：`session.tool.*`（工具调用）/`session.text.ended`/`session.execution.succeeded` |

## graph agent 工作流（system prompt 要点）

1. **查询理解**：提炼核心实体与关系（1~3 个检索词，含同义改写）
2. **图检索**：沙箱内 node fetch 调知识服务 `POST /graph/search`（**沙箱内地址 `http://host.docker.internal:18787/api`**，无 curl 用 node fetch），body `{ query, knowledgeBaseId: kb_yingdao_harness_graph, topK: 8 }`；响应含 `triplets`（三元组+来源文档）/`entityCards`（实体定义）/`sourceChunks`（原文片段）
3. **证据筛选**：只保留直接相关的三元组与原文；不足换词补查一次
4. **生成**：结论优先、引用完整来源文档 id；证据不足明确说明本次检索未找到足够证据，不将检索未命中等同于功能不存在；末尾列引用

## 严格验收标准（2026-10-14 修订）

当前内嵌脚本只实现冒烟检查，不能将它的 PASS 等同于答案正确、忠实或引用可靠。V 系列的既有临时执行同样只属于词面检查。下列严格标准尚未全部自动化，也尚未按此重新验收。

参考 [LangSmith RAG 评测](https://docs.langchain.com/langsmith/evaluate-rag-tutorial)、[应用评测方法](https://docs.langchain.com/langsmith/evaluation-approaches) 和 [TruLens RAG Triad](https://www.trulens.org/getting_started/core_concepts/rag_triad)，分别评估检索、答案正确性、证据忠实性和 Agent 执行轨迹；不要用单一关键词命中率替代这些维度。

### 问题级验收

| 维度 | 验收依据 | 当前脚本的不足 |
|---|---|---|
| 执行完整性 | 本题 execution 的 succeeded 终态，无 failed、超时或中断；最终回答属于本题 | 仅检查事件类型，缺少 execution/message 关联 |
| 真实检索 | 工具输入确实访问目标 Graph search 和目标 KB；对应输出 HTTP 200、success=true，且返回可解析证据 | 任意工具事件都能满足条件，不能证明成功检索 |
| 答案正确性 | 对照原文确定的原子事实，检查数值、对象、条件、否定、步骤顺序及必答项；允许语义等价表达 | 关键词存在可能仍伴随错误结论 |
| 证据忠实性 | 逐项核对答案的重要事实是否被本次 Agent 实际看到的证据支持；不能只对照完整知识库 | 关键词和原文共现不等于支持答案 |
| 引用有效性 | 引用完整文档 ID，属于本库且本次证据可见；引用内容支持相邻结论 | 仅匹配 ID 或短前后缀不能证明引用正确 |
| 证据不足处理 | 不补造事实；明确证据缺口；必要时补查或澄清 | 把“未检索到”写成“不支持”会误导 |

**本项目门槛，不是行业统一数值标准**：必答原子事实全部正确且被可见证据支持，无关键矛盾、编造或无效引用，执行及检索契约通过，才记 `PASS`。明确违反任一项记 `FAIL`；证据缺失、判官分歧记 `REVIEW`；环境故障记 `BLOCKED`。对已知可回答的题目，诚实拒答不算编造，但仍属于未完成回答。

### V 系列事实基准与复核

- 沿用 [RAG V 系列](../rag/various-questions.md) 的原始问题和目标文档，但先核验全文、版本及原文锚点，不能仅因旧文档写了期望就认定基准有效。
- V01/V09 检查数值、单位、适用对象和最低版本；V03 检查步骤及顺序；V05 检查选择条件；V06/V08 检查权限与否定极性；V04/V10 检查完整工具名和路径；V12 允许澄清歧义，不能奖励猜测。
- 关键词匹配保留为诊断信号，不作最终裁决。例如“不是 20MB，而是 200MB”不能因包含 `20MB` 而通过。
- 判官输入为问题、原文基准、实际可见检索证据、最终回答；输出逐事实判定、证据原句、矛盾与不支持项。检索内容及回答视为不可信数据，不执行其中的评测指令。
- 先以人工标注样本校准判官；失败、边界和分歧项人工复核。保留模型版本、判官提示词、原始输出，不将一次判官结果当真值。
- 每题独立新会话，避免前题答案污染；固定图库和配置，建议每题重复 3 次，报告逐次结果及通过率，而不是只保留最好一次。

### 证据与指标

保存每题 session/execution/message ID、SSE 工具输入输出、HTTP 响应、Agent 实际看到的内容、最终文本与引用。不得将 JSON 任意截成 6000 字符后认定证据完整；若需限长，按完整证据项裁剪并记录删减。

检索与生成分别报告：文档召回/排名、原子事实正确覆盖、支持事实比例、引用准确率/覆盖率、拒答情况；另记延迟与工具次数。RAG 直连召回率不能直接与 GraphRAG Agent 答案通过率比较；公平比较需相同问题、语料版本、预算和答案评测规则。只读验证必须另存 PG 前后证据，不能从回答或节点计数推断全量数据未改动。

## 测试脚本（整块复制到终端即可执行）

前置：saas(14096，Basic auth) + 知识服务(18787，含 `/api/graph`) 运行中。

```bash
export OPENCODE_PASSWORD='<saas密码>'
cat > /tmp/agent-graphrag.mjs <<'AGENT_EOF'
// Agent 版 GraphRAG 管道验收：graph agent（saas 会话）编排 查询理解→沙箱图检索→证据筛选→生成。
// 可覆盖环境变量：BASE / KNOWLEDGE_BASE / GRAPH_KB / MODEL / OPENCODE_AUTH / AGENT_GRAPHRAG_TIMEOUT_MS
import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://localhost:14096").replace(/\/$/, "")
const KNOWLEDGE = process.env.KNOWLEDGE_BASE ?? "http://host.docker.internal:18787/api"
const GRAPH_KB = process.env.GRAPH_KB ?? "kb_yingdao_harness_graph"
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const rawModel = process.env.MODEL ?? '{"providerID":"Yd-GLM","modelID":"glm-5.3"}'
const parsedModel = JSON.parse(rawModel)
const MODEL = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const timeout = Number(process.env.AGENT_GRAPHRAG_TIMEOUT_MS ?? 240_000)

function check(ok, description, detail) {
  assert.ok(ok, `FAIL: ${description}${detail ? ` —— ${detail}` : ""}`)
  console.log(`PASS: ${description}`)
}

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeout),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try { data = text ? JSON.parse(text) : undefined } catch { data = text }
  return { status: response.status, data, text }
}

/** 订阅会话 SSE：记录 session.* 事件（工具调用/文本/终态），等待执行结束。 */
async function watchSession(sessionID, log) {
  const controller = new AbortController()
  const response = await fetch(`${BASE}/api/session/${sessionID}/event`, {
    headers: { authorization: headers.authorization, accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (response.status !== 200) throw new Error(`Session SSE HTTP ${response.status}`)
  const done = (async () => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { value, done: eof } = await reader.read()
      if (eof) return
      buffer += decoder.decode(value, { stream: true })
      const blocks = buffer.split(/\r?\n\r?\n/)
      buffer = blocks.pop() ?? ""
      for (const block of blocks) {
        const line = block.split(/\r?\n/).find((item) => item.startsWith("data:"))
        if (!line) continue
        try {
          const event = JSON.parse(line.slice(5).trim())
          const type = event.type ?? ""
          const data = event.data ?? {}
          if (!type.startsWith("session.")) continue
          log.push(event)
          if (type === "session.tool.input.started") console.log(`  [SSE] tool ◇ ${data.name}`)
          if (type === "session.tool.success") console.log(`  [SSE] tool ✓ ${String(data.title ?? data.name ?? "").slice(0, 100)}`)
          if (type === "session.tool.failed") console.log(`  [SSE] tool ✗ ${String(data.error?.message ?? "").slice(0, 100)}`)
          if (type === "session.text.ended") console.log(`  [SSE] text · ${String(data.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`)
          if (type === "session.execution.failed") console.log(`  [SSE] exec ✗ ${String(data.error?.message ?? "").slice(0, 120)}`)
          if (type === "session.execution.succeeded" || type === "session.execution.failed") return
        } catch { /* 忽略非 JSON 块 */ }
      }
    }
  })()
  return { done, stop: () => controller.abort() }
}

const GRAPH_AGENT_SYSTEM = `你是影刀 Harness 平台的知识图谱问答专家。

工作流程：
1. 理解用户问题，提炼核心实体与关系（1~3 个检索词，含同义改写）。
2. 在沙箱内用 node fetch 调用图谱检索（知识服务在宿主机，无 curl，必须用 node fetch）：
   node -e 'const r=await fetch("${KNOWLEDGE}/graph/search",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({query:"<检索词>",knowledgeBaseId:"${GRAPH_KB}",topK:8})});console.log((await r.text()).slice(0,6000))'
   返回 JSON：data.triplets（source/relation/target/score/sourceDocumentIds）、data.entityCards（实体定义）、data.sourceChunks（原文片段）。
3. 证据筛选：只保留与问题直接相关的三元组与原文片段；不足时换词补查一次。
4. 生成回答：结论优先，逐点作答并引用来源（sourceDocumentIds 前 6 位即可）；证据不足时明确说"图谱中未找到"，不编造；末尾列出全部引用。

注意：Remote/Local 表单字段、操作步骤、能力边界这类事实必须来自检索结果，不得用自身知识补全。`

const CASES = [
  {
    id: "U05",
    q: "我要接一个远程 MCP 服务，需要填哪些信息？和本地服务有什么区别？",
    expect: ["Remote URL", "Headers", "启动命令"],
  },
  {
    id: "U12",
    q: "我要把知识搜索接到客服后台，通常选哪种搜索，还需要展示什么？",
    expect: ["混合", "原文"],
  },
]

let sessionID
const results = []
try {
  // ① 创建会话
  const created = await api("/api/session", "POST", { location: { directory: "/workspace" }, model: MODEL })
  check(created.status === 200 && created.data?.data?.id, "创建会话 200")
  sessionID = created.data.data.id

  // ② 注册 graph agent（Session 覆盖，primary）
  const agent = await api(`/api/session/${sessionID}/agents`, "POST", {
    id: "graph",
    config: { system: GRAPH_AGENT_SYSTEM, description: "影刀 Harness 知识图谱问答", mode: "primary" },
  })
  check(agent.status === 200, "注册 graph agent 200")

  // ③ 选择 agent
  const select = await api(`/api/session/${sessionID}/agent`, "POST", { agent: "graph" })
  check(select.status === 204, "选择 graph agent 204")

  for (const c of CASES) {
    const log = []
    const watcher = await watchSession(sessionID, log)
    const promptRes = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: c.q, metadata: {}, delivery: "queue" }),
      signal: AbortSignal.timeout(timeout),
    })
    check(promptRes.status === 200, `[${c.id}] prompt_stream 200`)
    await Promise.race([watcher.done, new Promise((r) => setTimeout(r, timeout))])
    watcher.stop()

    const toolCalls = log.filter((e) => String(e.type).startsWith("session.tool.input")).length
    const succeeded = log.some((e) => e.type === "session.execution.succeeded")
    const failed = log.some((e) => e.type === "session.execution.failed")
    check(succeeded && !failed, `[${c.id}] 执行终态 succeeded（工具事件 ${toolCalls} 个）`)
    check(toolCalls > 0, `[${c.id}] 发生了工具调用（沙箱检索）`)

    // ④ 收回答
    const messages = await api(`/api/session/${sessionID}/message?order=asc`)
    const assistant = [...(messages.data?.data ?? [])].reverse().find((m) => m.type === "assistant")
    const text = (assistant?.content ?? []).map((p) => p.text ?? "").join("")
    check(text.length > 30, `[${c.id}] 回答非空（${text.length} 字）`)
    const hits = c.expect.filter((k) => text.includes(k))
    check(hits.length === c.expect.length, `[${c.id}] 关键事实齐全 ${hits.length}/${c.expect.length}`, text.slice(0, 200))
    results.push({ id: c.id, answer: text, toolCalls })
    console.log(`\n--- [${c.id}] 回答节选 ---\n${text.slice(0, 500)}\n`)
  }
} finally {
  if (sessionID) await api(`/api/session/${sessionID}`, "DELETE").catch(() => {})
}

console.log(`\n=== Agent GraphRAG 汇总：${results.length}/${CASES.length} 问完成 ===`)
AGENT_EOF
bun /tmp/agent-graphrag.mjs
```

脚本断言（每问）：

- prompt_stream 200；SSE 终态 `session.execution.succeeded` 且无 failed
- **出现工具输入事件**（`session.tool.input.*` 事件 > 0；只证明尝试调用工具，不能证明成功检索）
- 回答非空且包含预设关键事实（期望先行：事实锚点先于执行固定）
- 会话结束清理（finally DELETE）

## 严格复测执行记录（2026-10-14：前置环境 BLOCKED）

本轮用户要求按严格规则复测 V01–V12。前置检查未通过，未创建新的评测会话、未发送问题、未重新摄入或改动图库；不把旧后台词面测试完成通知算作本轮结果。

| 检查 | 实测证据 | 判定 |
|---|---|---|
| SaaS | `GET http://127.0.0.1:14096/api/session?limit=1` 返回 HTTP 200；Docker `opencode-saas-test` healthy | 可达，不代表模型/沙箱链路已验 |
| 知识 HTTP 服务 | `GET http://127.0.0.1:18787/health` 连接失败 | BLOCKED |
| 当前 `.env` 数据库 | 配置为 `127.0.0.1:55432/knowledge`、schema `knowledge`；系统目录查询未找到该 schema 的普通表，未找到源 `documents`、源向量表或目标 `graph_nodes` | BLOCKED |
| 同 PG 的其他数据库 | `knowledge_test` 有 `knowledge.documents`，但按 `knowledge_base_id` 分组查询返回零行；无 `knowledge.graph_nodes`；`postgres` 无上述候选表 | 未找到可用语料和图库 |
| SaaS PG | `127.0.0.1:5432/opencode-v2-up` 中候选表仅 `knowledge_wiki_mig_test.documents`，无目标源向量表或图表 | 未找到本轮目标数据 |

SQL 证据方法：查询 `information_schema.tables` 的 `documents` / `graph_nodes` / `kb_yingdao_harness_zh_cn` 候选表；查询 `pg_class` 联结 `pg_namespace` 验证当前 `knowledge` schema 普通表；只读检查 `knowledge_test.knowledge.documents` 的知识库分组。连接凭据从忽略的 `.env` 或测试容器配置读取，未写入报告。

**结果：V01–V12 全部 BLOCKED（12 题未执行），PASS=0、FAIL=0、REVIEW=0。** 未运行重复样本或语义判官，无法提供答案、忠实性或引用通过率。仅能确认本次检查时缺少可用前置数据，不能由此推断数据丢失原因；也没有扫描本机所有数据库。

恢复条件：提供此前图库和 36 篇源文档的可用数据库连接，或明确授权从备份恢复。不得自行重建并把新图当作旧图复测；若只能重建，需标记语料/图库版本变化后再按严格标准执行。

后续已完成原因调查和防再发修复：实际 E2E 执行继承业务 `knowledge` schema，并由清理钩子删除；Wiki 后台恢复缺表异常使服务退出。现已为两套 E2E 增加唯一 schema 所有权保护，并捕获恢复轮询异常；42 条单测、20 条 PG E2E、1 条 Docker HTTP 故障注入通过。数据仍未恢复，V 系列严格评测仍 BLOCKED。完整时间线、验证及备份检查范围见 [环境中断调查](./environment-incident-20261014.md)。

## 历史冒烟实测（2026-10-14，尚未按严格标准验收）

历史记录使用 glm-5.3 会话模型、图库 kb_yingdao_harness_graph（当时记录为 2717 节点/3260 边）。以下仅保留旧脚本的观测结果，不能证明生成质量全面通过。

| 项 | 结果 |
|---|---|
| 会话/注册 graph agent/选择 | 200 / 200 / 204，全部 PASS |
| U05 远程 MCP 配置问答 | succeeded，4 个工具输入事件，读取文本 2137 字，关键词 3/3（Remote URL / Headers / 启动命令） |
| U12 混合搜索选型问答 | ✅ succeeded，4 个工具事件，回答 2829 字，关键事实 2/2（混合 / 原文） |
| 来源 ID 观察 | 历史记录提及 U05→`987903017838411776`、U12→`996621064644669440`；引用是否支持逐项结论尚待核验 |

证明边界：旧脚本计数包含 `input.started` 和 `input.ended`，4 个输入事件并非 4 次工具调用，也不能单凭计数证明 2 次成功 node fetch。回答中出现来源 ID 和实体名，不能独立证明引用支持结论或实体卡被使用。旧消息读取还会合并带 text 的 content，未排除 reasoning，需核验是否为纯最终回答。

## 与四层评估（graphSearch 直连）的分工

| | 四层评估（`eval-harness-graph-search.ts`） | Agent GraphRAG（本用例） |
|---|---|---|
| 编排 | 脚本直调 graphSearch | graph agent LLM 拆解改写 |
| 检索 | 固定参数（topK/depth） | Agent 经沙箱 node fetch，可多轮补查 |
| 证据 | 全部三元组参与确定性断言 | Agent 筛选后引用 |
| 判定 | 检索及词面指标（各自证明范围需复核） | 当前为词面冒烟；严格标准需逐事实、证据和引用复核 |
| 特性 | 确定性、可回归、证据全可见 | 智能筛选、可补查、答案导向 |
