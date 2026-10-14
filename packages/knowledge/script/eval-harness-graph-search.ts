/**
 * 图检索四层评估（升级版，对齐 RAG evaluation-rubric）：
 *   L1 机制：源 RAG 库只读 hash、图库只读一致、KB 隔离
 *   L2 召回：hit@K + 原文子串 fact-coverage + 位置 MRR + 结构边（包含）排除对照
 *   L2.5 图特有：全库三元组 grounding 率（实体名回溯原文）、结构边占比、孤立节点率
 *   L4 无害：检索来源文档零越库（全部 ∈ 源库 36 篇）
 *   L3 可答（LLM 判官）：本脚本不执行，标注待跑
 *
 * 事实锚点全部先于检索从 RAG 原文固定（期望先行），出处见 script/anchor-u-facts.ts 输出。
 */
import { writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import { getDatabaseSchema } from '../src/config/env.js'
import { getGraphAdapter } from '../src/graph/pg-adapter/index.js'
import { graphSearch } from '../src/graph/pipeline/search.js'
import { defaultEmbedFn } from '../src/graph/extraction/index.js'

const SOURCE_KB = 'kb_yingdao_harness_zh_cn'
const GRAPH_KB = 'kb_yingdao_harness_graph'
const topK = Number(process.argv[2] ?? 8)

/** U 系列：锚定原文子串（先于检索从原文固定；NOT-FOUND 项按原文实际用词修正） */
const CASES = [
  { id: 'U01', q: '原来的需求做完了，我想接着做优化但单独验收，复制会话应该选哪种分支？', doc: '994499662063226880', facts: ['独立分支', '方便单独验收'] },
  { id: 'U02', q: '复制会话是不是把原来的所有聊天消息都复制过去？', doc: '994499662063226880', facts: ['上下文摘要', '不是逐字复制'] },
  { id: 'U03', q: '我复制会话时提示先提交代码，如果取消提交会怎样？', doc: '994499662063226880', facts: ['取消提交，复制会话也会取消'] },
  { id: 'U04', q: '我把项目里的 Skill 解绑了，是不是技能资源也被删掉了？', doc: '987902908331687936', facts: ['解绑', '当前项目', '添加弹窗'] },
  { id: 'U05', q: '我要接一个远程 MCP 服务，需要填哪些信息？和本地服务有什么区别？', doc: '987903017838411776', facts: ['RemoteURL', 'Headers', '启动命令', '启动参数和环境变量'] },
  { id: 'U06', q: '我切到 design 了，为什么右边没有自动切到设计产物？', doc: '989008792326234112', facts: ['不会自动切换右侧看板', '手动点击右侧tab'] },
  { id: 'U07', q: '知识库批量同步有几篇失败了，我要全部重新同步吗？', doc: '996621057543712768', facts: ['失败原因', '失败文档是否允许重试'] },
  { id: 'U08', q: '文档平台刚返回任务 ID，现在就能认为所有文档都搜到了吗？', doc: '996621067853312000', facts: ['任务已创建不代表全部文档已经处理完成', '确认任务状态和失败数量'] },
  { id: 'U09', q: '我有经常变化的接口清单，又有申请流程说明，应该都放进数据表吗？', doc: '997029879951753216', facts: ['查事实、查清单、找记录', '既要找到具体记录，又要解释操作步骤'] },
  { id: 'U10', q: '想让 Agent 查询数据集，最少配什么？General Agent 能直接用吗？', doc: '997029870480326656', facts: ['填写datasetId', 'GeneralAgent不支持'] },
  { id: 'U11', q: 'Agent 查到的资料是对的，但最后回答错了，应该从哪里排查？', doc: '998053780952412160', facts: ['输入、输出、耗时和关联信息'] },
  { id: 'U12', q: '我要把知识搜索接到客服后台，通常选哪种搜索，还需要展示什么？', doc: '996621064644669440', facts: ['正文片段、文档名称和原文链接'] },
]

const schemaName = getDatabaseSchema()
const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL })
const adapter = getGraphAdapter(schemaName)
const embedFn = await defaultEmbedFn()
const norm = (s: string) => s.replace(/\s+/g, '').replace(/[*`]/g, '').toLowerCase()

// ── L1 前置快照：源库 content hash + 图库统计 ──
const sourceSnapshot = await pool.query<{ id: string; h: string }>(
  `SELECT id, md5(content) AS h FROM ${schemaName}.documents WHERE knowledge_base_id=$1 ORDER BY id`, [SOURCE_KB])
const sourceDocIds = new Set(sourceSnapshot.rows.map((r) => r.id))
const docTexts = new Map<string, string>()
{
  const { rows } = await pool.query<{ id: string; content: string }>(
    `SELECT id, content FROM ${schemaName}.documents WHERE knowledge_base_id=$1`, [SOURCE_KB])
  const tiptapText = (v: unknown): string => {
    if (Array.isArray(v)) return v.map(tiptapText).join('')
    if (!v || typeof v !== 'object') return ''
    const n = v as Record<string, unknown>
    return n.type === 'text' && typeof n.text === 'string' ? n.text : Object.values(n).map(tiptapText).join('')
  }
  for (const r of rows) docTexts.set(r.id, norm(tiptapText(JSON.parse(r.content))))
}

// ── L2：逐问检索（全部关系 vs 排除"包含"结构边）──
const evidence: unknown[] = []
let hit = 0, hitNoStruct = 0, factOk = 0, factOkNoStruct = 0, leakCases = 0
const mrrs: number[] = [], mrrsNoStruct: number[] = []

for (const c of CASES) {
  const run = async (exclude?: string[]) => graphSearch(adapter, {
    query: c.q, topK, neighborDepth: 2, knowledgeBaseId: GRAPH_KB, embedFn,
    excludeRelationTypes: exclude,
  })
  const [rAll, rNoStruct] = await Promise.all([run(), run(['包含'])])
  const evalRun = (r: typeof rAll) => {
    const triplets = r.triplets.map((t) => ({
      s: t.source.name, rel: t.relation, tgt: t.target.name,
      docs: [...new Set([
        ...(t.source.properties?.sourceDocumentIds as string[] | undefined ?? []),
        ...(t.target.properties?.sourceDocumentIds as string[] | undefined ?? []),
      ])],
    }))
    const firstRank = triplets.findIndex((t) => t.docs.includes(c.doc))
    const text = norm(r.context + JSON.stringify(r.entityCards ?? []) + JSON.stringify(triplets))
    return {
      triplets,
      hit: firstRank >= 0,
      mrr: firstRank >= 0 ? 1 / (firstRank + 1) : 0,
      factsVisible: c.facts.filter((f) => text.includes(norm(f))),
      // L4：来源文档越库检查
      leakedDocs: [...new Set(triplets.flatMap((t) => t.docs))].filter((d) => !sourceDocIds.has(d)),
    }
  }
  const a = evalRun(rAll), b = evalRun(rNoStruct)
  if (a.hit) hit++
  if (b.hit) hitNoStruct++
  if (a.factsVisible.length === c.facts.length) factOk++
  if (b.factsVisible.length === c.facts.length) factOkNoStruct++
  if (a.leakedDocs.length > 0) leakCases++
  mrrs.push(a.mrr); mrrsNoStruct.push(b.mrr)
  evidence.push({ id: c.id, q: c.q, anchorDoc: c.doc, all: a, noStruct: b,
    entityCards: rAll.entityCards ?? [] })
  console.log(`${a.hit ? 'HIT ' : 'MISS'} ${c.id} facts=${a.factsVisible.length}/${c.facts.length} mrr=${a.mrr.toFixed(2)} | noStruct: ${b.hit ? 'HIT' : 'MISS'} facts=${b.factsVisible.length}/${c.facts.length} mrr=${b.mrr.toFixed(2)}${a.leakedDocs.length ? ' LEAK!' : ''}`)
}

// ── L2.5 图特有：全库 grounding 率 + 结构占比 ──
const graphStats = await pool.query<{
  nodes: string; edges: string; isolated: string; struct_edges: string
}>(`
  SELECT
    (SELECT count(*) FROM ${schemaName}.graph_nodes WHERE knowledge_base_id=$1) AS nodes,
    (SELECT count(*) FROM ${schemaName}.graph_edges WHERE knowledge_base_id=$1) AS edges,
    (SELECT count(*) FROM ${schemaName}.graph_nodes n WHERE n.knowledge_base_id=$1 AND NOT EXISTS(
       SELECT 1 FROM ${schemaName}.graph_edges e WHERE (e.source_id=n.id OR e.target_id=n.id) AND e.knowledge_base_id=$1)) AS isolated,
    (SELECT count(*) FROM ${schemaName}.graph_edges WHERE knowledge_base_id=$1 AND relationship_name='包含') AS struct_edges`,
  [GRAPH_KB])
const edges = await pool.query<{ sname: string; tname: string; docs: string[] }>(`
  SELECT s.name AS sname, t.name AS tname,
         e.properties->'sourceDocumentIds' AS docs
  FROM ${schemaName}.graph_edges e
  JOIN ${schemaName}.graph_nodes s ON s.id=e.source_id
  JOIN ${schemaName}.graph_nodes t ON t.id=e.target_id
  WHERE e.knowledge_base_id=$1`, [GRAPH_KB])
let grounded = 0, checked = 0
const ungroundedSamples: string[] = []
for (const e of edges.rows) {
  const docs = (e.docs ?? []).filter((d) => docTexts.has(d))
  if (docs.length === 0) continue
  checked++
  const ok = docs.some((d) => docTexts.get(d)!.includes(norm(e.sname)) && docTexts.get(d)!.includes(norm(e.tname)))
  if (ok) grounded++
  else if (ungroundedSamples.length < 15) ungroundedSamples.push(`${e.sname} × ${e.tname}`)
}

// ── L1 后置校验：源库 hash 不变 + 图库只读一致 ──
const after = await pool.query<{ id: string; h: string }>(
  `SELECT id, md5(content) AS h FROM ${schemaName}.documents WHERE knowledge_base_id=$1 ORDER BY id`, [SOURCE_KB])
const graphAfter = await pool.query(`SELECT
  (SELECT count(*) FROM ${schemaName}.graph_nodes WHERE knowledge_base_id=$1) AS nodes,
  (SELECT count(*) FROM ${schemaName}.graph_edges WHERE knowledge_base_id=$1) AS edges`, [GRAPH_KB])
const sourceUnchanged = JSON.stringify(after.rows) === JSON.stringify(sourceSnapshot.rows)
const graphUnchanged = graphAfter.rows[0].nodes === graphStats.rows[0].nodes
  && graphAfter.rows[0].edges === graphStats.rows[0].edges

const n = CASES.length
const avg = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1)
const summary = {
  kb: GRAPH_KB, topK, total: n,
  L1: { sourceUnchanged, graphUnchanged },
  L2: {
    hitAtK: `${hit}/${n}`, hitRate: +(hit / n).toFixed(3),
    hitNoStruct: `${hitNoStruct}/${n}`,
    factCoverage: `${factOk}/${n}`, factNoStruct: `${factOkNoStruct}/${n}`,
    MRR: +avg(mrrs).toFixed(3), MRRNoStruct: +avg(mrrsNoStruct).toFixed(3),
  },
  L25: {
    groundingRate: `${grounded}/${checked}`,
    groundingPct: +(grounded / (checked || 1)).toFixed(3),
    structEdgePct: +(Number(graphStats.rows[0].struct_edges) / (Number(graphStats.rows[0].edges) || 1)).toFixed(3),
    isolatedPct: +(Number(graphStats.rows[0].isolated) / (Number(graphStats.rows[0].nodes) || 1)).toFixed(3),
    ungroundedSamples,
  },
  L4: { leakCases, verdict: leakCases === 0 ? 'PASS' : 'FAIL' },
  L3: '待跑（LLM 判官，需 saas 判官协议）',
}
console.log('\n=== 四层评估汇总 ===')
console.log(JSON.stringify(summary, null, 2))
writeFileSync(
  new URL('./.harness-graph-eval-evidence.json', import.meta.url).pathname,
  JSON.stringify({ summary, evidence }, null, 2))
await pool.end()
