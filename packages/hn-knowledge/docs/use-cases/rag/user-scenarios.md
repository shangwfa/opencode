# 用户视角：使用已有影刀 Harness 文档解决实际问题

## 范围与验收规则

- 使用已有库 `kb_yingdao_harness_zh_cn`，不创建、同步、更新或删除任何知识库及文档。
- 问题按用户表达编写；期望事实先从已有原文确定，不能根据搜索结果倒推或降低标准。
- 固定 topK=5，分别验证 semantic 和 hybrid。只有 HTTP 200、success=true、目标文档入围、关键事实齐全、原文链接正确才记 PASS。
- 事实只从目标文档的命中片段验证，不用详情接口补全搜索缺失的证据。不要求五条都是目标文档，但每条必须属于选定知识库。
- U13/U14 是用户选择知识库和分类范围的隔离检查；U15 是范围外问题的观察项，不把“有结果”或“空结果”当成 Agent 已正确拒答。
- 本轮是检索证据验收，不是 Agent 最终答案验收。未创建 SaaS 会话，未验证 Code Mode、SSE、工具调用或最终回答，不能宣称这些能力通过。
- PG 只读核对文档归属，并对测试前后文档及向量做摘要比较。并发外部写入会使摘要变化，需人工核查，不能直接归因本脚本。

## 用户场景与期望

| 编号 | 用户问题 | 期望事实（来自原文） | 原文 ID |
|---|---|---|---|
| U01 | 原来的需求做完了，我想接着做优化但单独验收，复制会话应该选哪种分支？ | 不确定时建议创建分支；独立分支方便单独验收 | 994499662063226880 |
| U02 | 复制会话是不是把原来的所有聊天消息都复制过去？ | 继承上下文摘要；不是逐字复制所有消息 | 994499662063226880 |
| U03 | 我复制会话时提示先提交代码，如果取消提交会怎样？ | 取消提交也会取消复制会话 | 994499662063226880 |
| U04 | 我把项目里的 Skill 解绑了，是不是技能资源也被删掉了？ | 解绑只影响当前项目；资源仍能在添加弹窗找到 | 987902908331687936 |
| U05 | 我要接一个远程 MCP 服务，需要填哪些信息？和本地服务有什么区别？ | Remote URL/Headers；Local 启动命令/参数/环境变量 | 987903017838411776 |
| U06 | 我切到 design 了，为什么右边没有自动切到设计产物？ | 进入页面后切换不自动切右侧 tab；手动点击设计 | 989008792326234112 |
| U07 | 知识库批量同步有几篇失败了，我要全部重新同步吗？ | 先检查原因和源文档；修复后只重试失败文档 | 996621057543712768 |
| U08 | 文档平台刚返回任务 ID，现在就能认为所有文档都搜到了吗？ | 创建不等于处理完成；确认任务状态和失败数量 | 996621067853312000 |
| U09 | 我有经常变化的接口清单，又有申请流程说明，应该都放进数据表吗？ | 数据集管事实；知识库补解释；不要强行全部表格化 | 997029879951753216 |
| U10 | 想让 Agent 查询数据集，最少配什么？General Agent 能直接用吗？ | datasetId 必需；General Agent 不支持该检索配置 | 997029870480326656 |
| U11 | Agent 查到的资料是对的，但最后回答错了，应该从哪里排查？ | 对比 Tool Result 与最终输出；模型理解/选择/组织问题 | 998053780952412160 |
| U12 | 我要把知识搜索接到客服后台，通常选哪种搜索，还需要展示什么？ | 优先混合搜索；正文片段、文档名称、原文链接 | 996621064644669440 |

这些是产品文档使用场景，不模拟资料中不存在的员工政策或退款规则。

## 实测结果（2026-10-13，真实库 36 篇影刀 Harness 文档）

首轮 13 PASS / 14 FAIL / 1 OBSERVE；修复缺陷 A 后 14 PASS / 13 FAIL；修复缺陷 B（分数语义分层）后复测 **18 PASS / 9 FAIL / 1 OBSERVE**（U01~U03、U08 的 hybrid 全部转绿）。

- PASS：U01~U06、U08-hybrid、U11 全部或部分模式；U13（缺陷 A 修复后）；U14 分类过滤；U16 PG 只读一致。
- 9 FAIL 全部为**排序/分块质量观察**（非逻辑缺陷，见下）：
  - U07/U09/U10 两种模式的"证据不完整"——目标文档进前五，但答案所在段落不在 topK=5 返回的 chunk（分块粒度与返回条数的固有权衡，Agent 侧可增大 topK 或多轮检索缓解）；
  - U08-semantic / U12 两种模式——目标文档嵌入相似度低于泛化文档（`API 搜索` 排 20/30，`文档平台同步` 未进前 30），需从内容运营或嵌入模型层面改善。
- U15 范围外问题返回 5 条泛化结果——人工核对无报销额度证据；提示消费方**不得把相关度分数当作事实存在与否的依据**，拒答约束须由 Agent 层实现。

证据：`results.md` / `evidence.json`（含每问完整响应）。

## 实测发现的问题

### 缺陷 A（已修复）：文档列表跨库泄漏

- **现象**：`GET /knowledge-base/kb_yingdao_harness_zh_cn/documents` 返回 52 篇，其中 16 篇属于 `uc_base` / `kb_uc_platform_zh_cn`（U13，实测两次复现）。
- **根因**：`knowledge-base.service.ts` 的 `listDocuments` 对 drizzle 查询链式调用 `.where()`——drizzle 的 `.where()` 是**覆盖**而非叠加，`knowledgeBaseId` 条件被 `status` 条件顶掉，count 查询还存在 `.where()` 返回值未赋值的问题，最终两个查询都只剩全库 `completed` 过滤。
- **修复**：全部过滤条件用 `and()` 组合后单次传入，主查询与 count 查询复用同一 `whereClause`；先补单测 `listDocuments 跨库隔离（where 条件不得被链式覆盖）`（红）再修复（绿）。
- **影响面**：只影响列表接口（检索/详情/删除均按各自实现不受影响）。

### 缺陷 B（已修复）：hybrid 中文口语长句必返回空

- **现象**：任何 keyword 分支无命中的查询（中文口语长句典型，如 U01~U03/U07/U08/U12 的 hybrid）`total=0` 并带 `No results found` 警告；同一问句 semantic 正常返回。
- **根因链（实验证据完整）**：
  1. keyword 分支对长句整句 trigram 匹配 0 命中（实测 keyword 长句 total=0、短词 `会话复制` 正常）；
  2. RRF 融合分 = 1/(60+rank+1)，单路命中最高 ≈0.016（实验 D：关 rerank + `minScore=0` 时实测分数 0.016）；
  3. 默认 `enableRerank=true` 把分数改写为 simpleRerank 分——短词可到 0.44（>阈值，幸存），长句只有 0.08~0.109（实验 C）；
  4. `filterLowScoreResults` 默认 `MIN_HYBRID_SCORE=0.15`（为相似度分设计的量级）→ 长句全部被过滤 → 空结果。
- **定性**：RRF 排名分与相似度阈值的**单位不匹配**，属全局 score 语义体系问题。
- **修复（分数语义分层，2026-10-13 实施）**——原则：**排名分只定序不外泄，质量阈值只对绝对语义分数生效**：
  1. 融合层（`hybrid-search.service`）：双路融合后 `restoreAbsoluteScores` 把 score 恢复为两路原生绝对分（取 max），RRF 分只用于定序；任一路为空时单路降级直接返回另一路原生分；
  2. rerank 层（`rerank.service`）：新增 `model='llm'`（LLMRelevanceScorer，绝对语义 1.0/0.5/0.0）并成为默认（`DEFAULT_RERANK_MODEL='llm'`，zod 枚举同步）；simple 保持改分公式（输入恒为绝对分故输出仍具绝对语义，词法成分弥补短查询子串命中场景）；
  3. 阈值层（`search-helper`）：三种 searchType 统一 `MIN_RELEVANCE_SCORE=0.2`（显式 `minScore` 语义=质量分阈值）。
- **验证**：先补失败测试（hybrid 分数语义 2 例、rerank 'llm'/simple 3 例、统一阈值 3 例）再实施；全量 1239 pass（仅剩 2 个既有 graph 探针）；真实库用户场景 14→**18 PASS**（U01~U03/U08 hybrid 全部转绿），search.md 39 PASS、base.md 49 PASS 无回归；e2e 的 ai mock 同步升级为有区分度的伪相关性打分（恒 0.9 会使 LLM 路径排序退化）。
- **遗留语义**：`MIN_SEMANTIC_SCORE/MIN_KEYWORD_SCORE/MIN_HYBRID_SCORE` 常量保留但默认阈值不再引用（仅 `pgVector` 扫描仍用相似度语义的 `MIN_SEMANTIC_SCORE`）。

### 质量观察（非缺陷，不改代码）

- **排序**：U08（任务 ID 是否等于全部入库）目标文档 `文档平台同步` 在 topK=30 内未召回、U12 目标 `API 搜索` 排 20/30——文档内容与问句的嵌入相似度低于更泛化的文档（`总览`、`让 Agent 使用数据集`），属嵌入排序质量，需从内容运营或嵌入模型层面改善。
- **证据完整性**：U07/U09/U10 semantic 命中目标文档，但返回 chunk 恰好不含答案所在段落（topK=5 被其它 chunk 占位）——分块粒度与返回条数的固有权衡，Agent 侧可通过增大 topK 或多轮检索缓解。

## 内嵌测试脚本

从仓库根目录提取下方 javascript 代码块为临时 `.mjs` 文件，再用 `bun` 执行。配置：`BASE` 默认已有服务 `http://127.0.0.1:18787/api`；`PGC/PGDB/SCH` 默认 `knowledge-pg/knowledge/knowledge`；`OUT` 指定证据目录（默认系统临时目录）。
仅有的 POST 是 `/search`；脚本无数据写入接口。失败退出 1，环境阻塞退出 2；逐场景输出，完整响应存入 JSON，汇总存入 Markdown。

```javascript
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.env.BASE || 'http://127.0.0.1:18787/api'
const kb = 'kb_yingdao_harness_zh_cn'
const schema = process.env.SCH || 'knowledge'
const out = process.env.OUT || join(tmpdir(), `knowledge-user-${Date.now()}`)
const cases = [
  ['U01', '原来的需求做完了，我想接着做优化但单独验收，复制会话应该选哪种分支？', '994499662063226880', ['创建分支', '单独验收']],
  ['U02', '复制会话是不是把原来的所有聊天消息都复制过去？', '994499662063226880', ['上下文摘要', '不是逐字复制']],
  ['U03', '我复制会话时提示先提交代码，如果取消提交会怎样？', '994499662063226880', ['取消提交', '复制会话也会取消']],
  ['U04', '我把项目里的 Skill 解绑了，是不是技能资源也被删掉了？', '987902908331687936', ['解绑只影响当前项目', '资源仍']],
  ['U05', '我要接一个远程 MCP 服务，需要填哪些信息？和本地服务有什么区别？', '987903017838411776', ['Remote URL', 'Headers', '启动命令', '环境变量']],
  ['U06', '我切到 design 了，为什么右边没有自动切到设计产物？', '989008792326234112', ['不会自动切换右侧', '手动点击']],
  ['U07', '知识库批量同步有几篇失败了，我要全部重新同步吗？', '996621057543712768', ['查看原因', '源文档', '只重试失败文档']],
  ['U08', '文档平台刚返回任务 ID，现在就能认为所有文档都搜到了吗？', '996621067853312000', ['不代表全部文档', '任务状态', '失败数量']],
  ['U09', '我有经常变化的接口清单，又有申请流程说明，应该都放进数据表吗？', '997029879951753216', ['事实', '解释', '强行改造成表格']],
  ['U10', '想让 Agent 查询数据集，最少配什么？General Agent 能直接用吗？', '997029870480326656', ['datasetId', '必需项', 'General Agent 不支持']],
  ['U11', 'Agent 查到的资料是对的，但最后回答错了，应该从哪里排查？', '998053780952412160', ['Tool Result', '最终输出']],
  ['U12', '我要把知识搜索接到客服后台，通常选哪种搜索，还需要展示什么？', '996621064644669440', ['混合搜索', '正文片段', '文档名称', '原文链接']],
]
const rows = []
function assert(ok, message) { if (!ok) throw new Error(message) }
function sql(query) {
  return execFileSync('docker', ['exec', process.env.PGC || 'knowledge-pg', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', process.env.PGDB || 'knowledge', '-Atc', query], { encoding: 'utf8', timeout: 30000 }).trim()
}
function snapshot() {
  return sql(`SELECT md5(coalesce(string_agg(row_to_json(d)::text,'|' ORDER BY id),'')) FROM ${schema}.documents d WHERE knowledge_base_id='${kb}'; SELECT md5(coalesce(string_agg(row_to_json(v)::text,'|' ORDER BY row_to_json(v)::text),'')) FROM ${schema}.${kb} v;`)
}
async function request(path, body) {
  const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120000) })
  const data = await r.json()
  assert(r.status === 200 && data.success === true, `HTTP=${r.status}, success=${data.success}, message=${data.message}`)
  return data.data
}
function plain(value) {
  if (!value || typeof value !== 'object') return ''
  return [value.text || '', ...(Array.isArray(value.content) ? value.content.map(plain) : [])].join(' ')
}
function normalize(text) { return String(text || '').replace(/[\s*`]/g, '').toLowerCase() }
function textOf(x) { return x.text || x.metadata?.text || '' }
function docId(x) { return x.documentId || x.metadata?.documentId }
async function test(id, action) {
  const row = { id, status: 'PASS' }
  try { await action(row) } catch (e) { row.status = 'FAIL'; row.error = String(e?.message || e) }
  rows.push(row)
  console.log(`${row.status} ${id}${row.error ? ' ' + row.error : ''}`)
}
try {
  assert(/^[a-z_][a-z0-9_]*$/.test(schema), '非法 schema')
  mkdirSync(out, { recursive: true })
  const before = snapshot()
  const owned = new Set(sql(`SELECT id FROM ${schema}.documents WHERE knowledge_base_id='${kb}'`).split('\n').filter(Boolean))
  assert(owned.size > 0, '已有知识库为空，不能验收')
  const truth = new Map()
  for (const [, , id, facts] of cases) {
    if (!truth.has(id)) {
      const d = await request(`/knowledge-base/${kb}/documents/${id}`)
      assert(owned.has(d.id) && d.knowledgeBaseId === kb, '原文不属于指定知识库')
      let text
      try { text = plain(JSON.parse(d.content)) } catch { text = d.content }
      truth.set(id, { text, metadata: d.metadata })
    }
    for (const fact of facts) assert(normalize(truth.get(id).text).includes(normalize(fact)), `基准原文缺少事实 ${id}: ${fact}`)
  }
  for (const [id, query, expected, facts] of cases) {
    for (const searchType of ['semantic', 'hybrid']) {
      await test(`${id}-${searchType}`, async row => {
        row.query = query
        row.expected = { documentId: expected, facts }
        const data = await request(`/knowledge-base/${kb}/search`, { query, topK: 5, searchType })
        row.response = data
        assert(Array.isArray(data.results), '响应缺少 results 数组')
        assert(data.results.length <= 5, '返回超过 topK')
        for (const x of data.results) assert(owned.has(docId(x)), `跨库来源 ${docId(x)}`)
        const hits = data.results.filter(x => docId(x) === expected)
        assert(hits.length > 0, '前五条没有目标文档')
        const text = normalize(hits.map(textOf).join('\n'))
        const missing = facts.filter(f => !text.includes(normalize(f)))
        assert(missing.length === 0, `证据不完整: ${missing.join(' / ')}`)
        for (const x of hits) assert(x.metadata?.docUrl === truth.get(expected).metadata.docUrl && x.metadata?.docName === truth.get(expected).metadata.docName, '来源名称或链接不符')
      })
    }
  }
  await test('U13-所选知识库文档列表隔离', async row => {
    const data = await request(`/knowledge-base/${kb}/documents?pageSize=100`)
    row.foreignIds = (data.items || []).filter(x => !owned.has(x.id)).map(x => x.id)
    assert(Array.isArray(data.items) && data.items.length > 0, '列表为空或缺失')
    assert(row.foreignIds.length === 0, `返回 ${row.foreignIds.length} 篇其他库文档`)
  })
  await test('U14-只搜索项目配置文档', async row => {
    const data = await request(`/knowledge-base/${kb}/search`, { query: 'MCP配置', searchType: 'hybrid', topK: 5, filter: { parentPath: '功能文档/项目级基础配置' } })
    row.response = data
    assert(Array.isArray(data.results) && data.results.length > 0, '范围内应有结果')
    assert(data.results.some(x => docId(x) === '987903017838411776'), '缺少 MCP 配置原文')
    assert(data.results.every(x => owned.has(docId(x)) && x.metadata?.parentPath === '功能文档/项目级基础配置'), '越过选择范围')
  })
  try {
    const query = '公司今年春节报销额度是多少元？'
    const data = await request(`/knowledge-base/${kb}/search`, { query, searchType: 'semantic', topK: 5 })
    rows.push({ id: 'U15-范围外问题', status: 'OBSERVE', query, response: data, note: '人工判断是否有报销额度证据；未验证 Agent 拒答。相关度不能作为事实存在的证明。' })
    console.log(`OBSERVE U15 返回 ${data.results?.length ?? '未知'} 条；需人工检查，不计通过`)
  } catch (e) { rows.push({ id: 'U15-范围外问题', status: 'FAIL', error: String(e) }) }
  await test('U16-PG只读一致性', async () => assert(before === snapshot(), '文档或向量摘要变化，需核查外部写入'))
  const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {})
  writeFileSync(join(out, 'evidence.json'), JSON.stringify({ time: new Date().toISOString(), base, kb, documentCount: owned.size, counts, rows }, null, 2))
  writeFileSync(join(out, 'results.md'), '# 已有知识库用户场景实测\n\n' + `服务：${base}；知识库：${kb}；文档数：${owned.size}。\n\n` + '仅检索证据验收，非 Agent 答案验收。\n\n| 用例 | 结果 | 原因 |\n|---|---|---|\n' + rows.map(r => `| ${r.id} | ${r.status} | ${(r.error || r.note || '符合预设事实与来源要求').replace(/\|/g, '/')} |`).join('\n') + '\n\n汇总：' + JSON.stringify(counts) + '\n')
  console.log(`汇总 ${JSON.stringify(counts)}；证据 ${out}`)
  process.exitCode = counts.FAIL ? 1 : 0
} catch (e) {
  console.error(`BLOCKED ${String(e?.message || e)}；未完成验收，不计通过`)
  process.exitCode = 2
}
```
