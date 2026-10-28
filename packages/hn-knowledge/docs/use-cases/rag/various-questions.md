# 用户视角 II：多样化问题类型（V 系列）

> 承接 [user-scenarios.md](./user-scenarios.md)（U 系列）的判定规则与验收哲学，本文件覆盖**更多问题类型**与 U 系列未测文档。
> 数据同样来自已有库 `kb_yingdao_harness_zh_cn`（36 篇影刀 Harness 文档），零写入只读验收。

## 范围与验收规则

与 U 系列一致：期望事实先从原文确定（不许倒推）；HTTP 200 + success=true + 结果不越 topK + 结果全部属于本库；**前 5 条须命中目标文档且包含关键事实、来源名称与链接一致**。每种问法在 semantic / hybrid 双模式下各验一次。

## 问句类型与期望（V01~V12）

| 编号 | 问题类型 | 用户问题 | 期望事实（来自原文） | 目标文档 ID |
|---|---|---|---|---|
| V01 | 数字/限制 | 上传的压缩包最大能多大？ | `20MB`（单文件上限） | 988627232530132992 项目迁移示例 |
| V02 | 口语同义改写 | 怎么把飞书写的内容弄进知识库？ | `授权`、`立即同步`（同步三步） | 989442526111506432 如何同步 |
| V03 | 流程步骤 | 把本地项目搬到平台上发布要经过哪几步？ | `打包`、`上传`、`验收`、`部署` | 988627232530132992 项目迁移示例 |
| V04 | 英文工具名 | 用 MCP 搜文档要启用哪个工具？ | `search_yddoc_documents` | 996621061469581312 MCP 搜索 |
| V05 | 条件选择 | 流程数据比较大，RPA 流程还原该用哪种传参方式？ | `dataUrl`（较大/按需获取） | 996970157810057216 RPA流程还原 |
| V06 | 角色权限 | 文档知识库里品牌编辑者能做什么、不能做什么？ | `品牌编辑者`、`不能新增` | 996602801509048320 使用指南 |
| V07 | 概念定义 | 数据集是个什么东西，适合放什么内容？ | `固定字段`（数据集保存有固定字段的事实） | 997029888894009344 数据集能力概览 |
| V08 | 否定/不支持 | 知识库能不能直接传 word 文档？ | `不直接解析 DOC`、`转换为 PDF` | 996621076208365568 写入知识库 |
| V09 | 版本要求 | 接入编辑器对 React 和 TipTap 版本有什么要求？ | `17 或更高版本`、`3.1.0` | 996981079968907264 编辑器快速接入 |
| V10 | API 细节 | 文档 OpenAPI 上传图片前要先调哪个接口？ | `resource-upload-sessions` | 989442713704845312 文档 OpenAPI |
| V11 | 方式选择 | 想在自己的业务系统里加搜索能力，用 API 还是 MCP？ | `检索 API`（业务系统加搜索） | 996621080524304384 能力总览 |
| V12 | 极短查询 | blockId | `一级 block`（blockId 只用于一级） | 989443225306177536 TipTap 格式 |

## 实测结果（2026-10-13，缺陷 B 修复后的服务）

**21 PASS / 4 FAIL / 0 BLOCKED**（12 类型 × semantic/hybrid 双模式 + PG 只读一致）。

| 结果 | 说明 |
|---|---|
| 全过类型 | 数字限制（V01）、口语改写（V02：飞书→同步）、流程步骤（V03）、英文工具名（V04）、条件选择（V05）、概念定义（V07）、版本要求（V09）、方式选择（V11）、**极短查询（V12：blockId）** |
| V06 两模式 | 《使用指南》协作者角色表格 chunk 未进前五（被《总览》泛化 chunk 挤占）；hybrid 命中文档但缺角色段落——排序+分块粒度 |
| V08-semantic | "word 文档"与"DOC/DOCX 不解析"的**跨表达同义**未召回（《写入知识库》没进前五）；hybrid 通过——词法信号在融合路径起了作用 |
| V10-semantic | 《文档 OpenAPI》进前五（首块）但接口表格在中段 chunk；注意：返回第 5 条《TipTap 格式》的 `create_resource_upload` 实为**同一事实链的正确证据**（见下"断言边界"） |

### 断言边界（诚实记录）

本系列沿用"目标文档唯一"断言，但 V10 暴露其局限：**同一事实可能存在于多篇文档**（申请上传地址既在 OpenAPI 接口表也在 TipTap 资源章节）。检索实际找到了可用证据，断言却记 FAIL。U/V 系列保持严格口径（可复现、不掺主观判断），但定性为质量观察时需人工核对这类"证据等价"情形——V10 第 5 条即属此类，用户实际能拿到正确答案。

证据：`results.md` / `evidence.json`（含每问完整响应）。

## 内嵌测试脚本

从本文件提取 javascript 代码块执行（依赖已在运行的 `BASE` 服务与 `PGC` 容器，同 U 系列）：

```javascript
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.env.BASE || 'http://127.0.0.1:18787/api'
const kb = 'kb_yingdao_harness_zh_cn'
const schema = process.env.SCH || 'knowledge'
const out = process.env.OUT || join(tmpdir(), `knowledge-v-${Date.now()}`)
const cases = [
  ['V01', '上传的压缩包最大能多大？', '988627232530132992', ['20MB']],
  ['V02', '怎么把飞书写的内容弄进知识库？', '989442526111506432', ['授权', '立即同步']],
  ['V03', '把本地项目搬到平台上发布要经过哪几步？', '988627232530132992', ['打包', '上传', '验收', '部署']],
  ['V04', '用 MCP 搜文档要启用哪个工具？', '996621061469581312', ['search_yddoc_documents']],
  ['V05', '流程数据比较大，RPA 流程还原该用哪种传参方式？', '996970157810057216', ['dataUrl']],
  ['V06', '文档知识库里品牌编辑者能做什么、不能做什么？', '996602801509048320', ['品牌编辑者', '不能新增']],
  ['V07', '数据集是个什么东西，适合放什么内容？', '997029888894009344', ['固定字段']],
  ['V08', '知识库能不能直接传 word 文档？', '996621076208365568', ['不直接解析 DOC', '转换为 PDF']],
  ['V09', '接入编辑器对 React 和 TipTap 版本有什么要求？', '996981079968907264', ['17 或更高版本', '3.1.0']],
  ['V10', '文档 OpenAPI 上传图片前要先调哪个接口？', '989442713704845312', ['resource-upload-sessions']],
  ['V11', '想在自己的业务系统里加搜索能力，用 API 还是 MCP？', '996621080524304384', ['检索 API']],
  ['V12', 'blockId', '989443225306177536', ['一级 block']],
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
  await test('V13-PG只读一致性', async () => assert(before === snapshot(), '文档或向量摘要变化，需核查外部写入'))
  const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {})
  writeFileSync(join(out, 'evidence.json'), JSON.stringify({ time: new Date().toISOString(), base, kb, documentCount: owned.size, counts, rows }, null, 2))
  writeFileSync(join(out, 'results.md'), '# V 系列（多样化问题）实测\n\n' + `服务：${base}；知识库：${kb}。\n\n| 用例 | 结果 | 原因 |\n|---|---|---|\n` + rows.map(r => `| ${r.id} | ${r.status} | ${(r.error || '符合预设事实与来源要求').replace(/\|/g, '/')} |`).join('\n') + '\n\n汇总：' + JSON.stringify(counts) + '\n')
  console.log(`汇总 ${JSON.stringify(counts)}；证据 ${out}`)
  process.exitCode = counts.FAIL ? 1 : 0
} catch (e) {
  console.error(`BLOCKED ${String(e?.message || e)}；未完成验收，不计通过`)
  process.exitCode = 2
}
```
