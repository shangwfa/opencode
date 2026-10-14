# 用户视角 II（Wiki）：多样化问题类型（Q 系列）

> 对应 RAG 的 [V 系列](../rag/various-questions.md)，问题与期望事实沿用同一批原文，但检索对象改为 **Wiki 概念页**（`POST /llm-wiki/search`）。
> 数据来自已有库 `kb_yingdao_harness_zh_cn`（36 篇影刀 Harness 文档），只读验收，不写入文档库。

## 与 RAG 版的差异（为什么不是简单替换）

| 项 | RAG（V 系列） | Wiki（Q 系列） |
|---|---|---|
| 检索对象 | 文档分块 chunk | 已编译的概念页（概念名 + 定义 + 摘要 + 带证据的段落） |
| 检索方式 | semantic / hybrid 双模式 | 只有词法 + 图扩展，无向量，**单模式** |
| 命中判定 | 目标文档的 chunk 进入前 5 条 | 前 5 个概念中，某个**已验证**概念的内容含关键事实，且其 `sourceDocumentIds` 含目标文档 |
| 结果前提 | 原文入库即可检索 | 必须先完成编译，且概念来自 LLM 抽取；**原文中的事实若未被抽取为概念，Wiki 无法回答** |
| 来源 | `docUrl` / `docName` | 概念的 `sourceDocumentIds` 与 `citedPages.sourceDocuments` |

因此，本系列同时检验两件事：**概念覆盖**（编译是否抽取到了问题所需的概念）与**检索命中**（问句能否通过词法匹配到该概念）。两者分开记录，不混为一谈。

## 范围与验收规则

1. HTTP 200 + `success=true`；`results` 长度 ≤ 5。
2. 结果中的概念全部为 `compiled` 且 `verified`（服务端保证，脚本再次核对，不信任）。
3. 前 5 个概念中至少一个同时满足：内容（定义、摘要、段落正文、断言语句）包含全部关键事实；`sourceDocumentIds` 包含目标文档 ID。
4. 目标概念不得由其它集合引入（`results` 只来自本库集合）。
5. 期望事实先从原文确定（不许倒推）；原文事实必须能在目标文档中逐字找到。
6. 只读核对：文档表与向量表摘要编译前后一致（编译本身只写 Wiki 表，不改文档）。

## 问句类型与期望（Q01~Q12）

| 编号 | 问题类型 | 用户问题 | 期望事实（来自原文） | 目标文档 ID | 预期风险（待验证，非结论） |
|---|---|---|---|---|---|
| Q01 | 数字/限制 | 上传的压缩包最大能多大？ | `20MB` | 988627232530132992 项目迁移示例 | 概念需以"压缩包/上传"为名或含该事实 |
| Q02 | 口语同义改写 | 怎么把飞书写的内容弄进知识库？ | `授权`、`立即同步` | 989442526111506432 如何同步 | 词法检索对口语无法匹配"飞书/同步"概念名 |
| Q03 | 流程步骤 | 把本地项目搬到平台上发布要经过哪几步？ | `打包`、`上传`、`验收`、`部署` | 988627232530132992 项目迁移示例 | 步骤可能分散在多个概念中 |
| Q04 | 英文工具名 | 用 MCP 搜文档要启用哪个工具？ | `search_yddoc_documents` | 996621061469581312 MCP 搜索 | 工具名作为概念名的可能性高 |
| Q05 | 条件选择 | 流程数据比较大，RPA 流程还原该用哪种传参方式？ | `dataUrl` | 996970157810057216 RPA流程还原 | 依赖"大数据量"相关概念是否被抽取 |
| Q06 | 角色权限 | 文档知识库里品牌编辑者能做什么、不能做什么？ | `品牌编辑者`、`不能新增` | 996602801509048320 使用指南 | 角色表格在正文段落中，概念可能只有摘要 |
| Q07 | 概念定义 | 数据集是个什么东西，适合放什么内容？ | `固定字段` | 997029888894009344 数据集能力概览 | 概念名"数据集"可直接命中，**定义是否含该事实是关键** |
| Q08 | 否定/不支持 | 知识库能不能直接传 word 文档？ | `不直接解析 DOC`、`转换为 PDF` | 996621076208365568 写入知识库 | RAG 版即未召回跨表达同义，Wiki 词法检索预计更弱 |
| Q09 | 版本要求 | 接入编辑器对 React 和 TipTap 版本有什么要求？ | `17 或更高版本`、`3.1.0` | 996981079968907264 编辑器快速接入 | 版本号本身是词法强信号 |
| Q10 | API 细节 | 文档 OpenAPI 上传图片前要先调哪个接口？ | `resource-upload-sessions` | 989442713704845312 文档 OpenAPI | RAG 版即暴露"同一事实多文档"边界，见下 |
| Q11 | 方式选择 | 想在自己的业务系统里加搜索能力，用 API 还是 MCP？ | `检索 API` | 996621080524304384 能力总览 | 概念可能只覆盖"MCP"而非"检索 API" |
| Q12 | 极短查询 | blockId | `一级 block` | 989443225306177536 TipTap 格式 | 单词查询对词法检索最有利，但概念需以 blockId 命名 |

## 执行前置条件

- 知识库编译必须**完成**（任务状态 `completed`），且目标文档至少被一个 `verified` 概念引用。编译中的数据不能用于验收。
- 检查命令：`SELECT count(*) FROM knowledge.wiki_concepts WHERE citation_status='verified' AND status='compiled'` 大于 0。
- 编译使用真实模型，结果随模型与配额变化；每次执行前记录编译任务 ID 与概念计数。

## 实测结果

**2026-10-14：13 PASS / 0 FAIL**（Q01~Q12 + Q13 只读一致）。编译模型 `azure/gpt-5.5`（影刀内网会话代理），175 个 verified 概念页，服务含分词级精确名排序修复（Q07 首轮失败的根因，见下）。

| 用例 | 结果 | 说明 |
|---|---|---|
| Q01~Q06、Q08~Q12 | PASS | 数字、口语改写、流程、英文工具名、条件、角色、否定、版本、API、方式、极短查询全部命中 |
| Q07 数据集定义 | PASS（修复后） | 首轮 FAIL：`数据集` 页含事实"固定字段"但被 `数据集API` 等长名概念挤出前五。根因是口语长句下整句精确加分（+200）永不触发、token 匹配无区分度；修复为概念名作为问句连续子串时 +120（WS13 覆盖） |
| Q13 PG 只读一致 | PASS | 检索前后文档与向量摘要不变 |

对照：同库 RAG 版 V 系列 21 PASS / 4 FAIL——Wiki 概念页聚合多文档证据，命中率更高。

| 用例 | 结果 | 命中概念 | 来源文档是否含目标 | 备注 |
|---|---|---|---|---|
| Q01~Q12 | 13 PASS | 见证据 JSON | ✓ | 证据目录：`$OUT`（默认系统临时目录 `knowledge-q-*`） |

### 断言边界

- 与 RAG 版相同：同一事实可能出现在多篇文档中（如 Q10 的上传地址同时在 OpenAPI 与 TipTap 章节）。严格断言"目标文档唯一"会把证据等价的情形记为 FAIL。执行时应把此类情形单独标注为"证据等价"，不计入 FAIL，并人工核对。
- 本系列只检验检索与来源，不评估模型生成的概念摘要是否忠实于原文；忠实度见 [maintenance.md](./maintenance.md) 的边界说明。

## 内嵌测试脚本

依赖已编译完成的知识服务（`BASE`，默认 `http://127.0.0.1:18787/api`）与 `PGC` 容器（默认 `knowledge-pg`）。

```javascript
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.env.BASE || 'http://127.0.0.1:18787/api'
const kb = 'kb_yingdao_harness_zh_cn'
const schema = process.env.SCH || 'knowledge'
const out = process.env.OUT || join(tmpdir(), `knowledge-q-${Date.now()}`)
const cases = [
  ['Q01', '上传的压缩包最大能多大？', '988627232530132992', ['20MB']],
  ['Q02', '怎么把飞书写的内容弄进知识库？', '989442526111506432', ['授权', '立即同步']],
  ['Q03', '把本地项目搬到平台上发布要经过哪几步？', '988627232530132992', ['打包', '上传', '验收', '部署']],
  ['Q04', '用 MCP 搜文档要启用哪个工具？', '996621061469581312', ['search_yddoc_documents']],
  ['Q05', '流程数据比较大，RPA 流程还原该用哪种传参方式？', '996970157810057216', ['dataUrl']],
  ['Q06', '文档知识库里品牌编辑者能做什么、不能做什么？', '996602801509048320', ['品牌编辑者', '不能新增']],
  ['Q07', '数据集是个什么东西，适合放什么内容？', '997029888894009344', ['固定字段']],
  ['Q08', '知识库能不能直接传 word 文档？', '996621076208365568', ['不直接解析 DOC', '转换为 PDF']],
  ['Q09', '接入编辑器对 React 和 TipTap 版本有什么要求？', '996981079968907264', ['17 或更高版本', '3.1.0']],
  ['Q10', '文档 OpenAPI 上传图片前要先调哪个接口？', '989442713704845312', ['resource-upload-sessions']],
  ['Q11', '想在自己的业务系统里加搜索能力，用 API 还是 MCP？', '996621080524304384', ['检索 API']],
  ['Q12', 'blockId', '989443225306177536', ['一级 block']],
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
function conceptText(concept) {
  const c = concept.content || {}
  const sections = (c.sections || []).flatMap(s => [s.content || '', ...(s.claims || []).map(k => k.statement || '')])
  return [concept.definition || '', concept.summary || '', ...sections].join('\n')
}
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
  const verified = Number(sql(`SELECT count(*) FROM ${schema}.wiki_concepts c JOIN ${schema}.wiki_collections w ON w.id=c.collection_id WHERE w.knowledge_base_id='${kb}' AND c.status='compiled' AND c.citation_status='verified'`))
  assert(verified > 0, `无 verified 概念，编译未完成或未产出，不能验收（verified=${verified}）`)
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
    await test(id, async row => {
      row.query = query
      row.expected = { documentId: expected, facts }
      const data = await request('/llm-wiki/search', { knowledgeBaseId: kb, query, topK: 5, includeRelated: false })
      row.response = data
      assert(Array.isArray(data.results), '响应缺少 results 数组')
      assert(data.results.length <= 5, '返回超过 topK')
      const hits = data.results.filter(r => (r.sourceDocumentIds || []).includes(expected))
      assert(hits.length > 0, '前五个概念的来源中没有目标文档')
      const best = hits.find(r => facts.every(f => normalize(conceptText(r.concept)).includes(normalize(f))))
      assert(best, `命中概念的内容缺少关键事实: ${facts.join(' / ')}`)
      row.concept = best.concept.conceptName
    })
  }
  await test('Q13-PG只读一致性', async () => assert(before === snapshot(), '文档或向量摘要变化，需核查外部写入'))
  const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {})
  writeFileSync(join(out, 'evidence.json'), JSON.stringify({ time: new Date().toISOString(), base, kb, verified, counts, rows }, null, 2))
  writeFileSync(join(out, 'results.md'), '# Q 系列（Wiki 多样化问题）实测\n\n' + `服务：${base}；知识库：${kb}；verified 概念：${verified}。\n\n| 用例 | 结果 | 命中概念 | 原因 |\n|---|---|---|---|\n` + rows.map(r => `| ${r.id} | ${r.status} | ${r.concept || ''} | ${(r.error || '符合预设事实与来源要求').replace(/\|/g, '/')} |`).join('\n') + '\n\n汇总：' + JSON.stringify(counts) + '\n')
  console.log(`汇总 ${JSON.stringify(counts)}；证据 ${out}`)
  process.exitCode = counts.FAIL ? 1 : 0
} catch (e) {
  console.error(`BLOCKED ${String(e?.message || e)}；未完成验收，不计通过`)
  process.exitCode = 2
}
```
