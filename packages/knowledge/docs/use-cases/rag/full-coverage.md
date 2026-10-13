# 用户视角 III：全量覆盖问句（W 系列，36 篇文档全覆盖）

> 严格按「先看资料、再造问题」五步生成，并按**文档真实读者角色**造问句（上一版问句是"事实反装的考题"，视角错位，已废弃）：
> ① 枚举库（36 篇：场景案例 1 / 知识库 29 / 功能文档 6）→ ② 补齐 U/V 未锚定的 15 篇（合计 36 篇全覆盖）→ ③ 逐篇读原文 → ④ 按**读者角色 × 真实场景**造问句（操作型/集成型/借鉴型/维护型），答案锚定原文可验证事实 → ⑤ 脚本内置基准校验。
> 判定规则同 [user-scenarios.md](./user-scenarios.md)：前 5 条命中目标文档 + 关键事实可见 + 来源一致，semantic/hybrid 双模式。

## 读者角色与问句（W01~W15）

### 平台操作用户（用平台时卡住了）

| 编号 | 用户场景 | 问题 | 期望事实（原文子串） | 目标文档 |
|---|---|---|---|---|
| W01 | 刚发布的文档 AI 搜不到，着急 | 新发布的文档为什么 AI 暂时搜不到？ | `先确认文档已经发布并启用`（同步需要时间） | 总览 996610332495945728 |
| W14 | 给项目配好了 Agent，不知道去哪用 | 配好的 Agent 要在哪儿选用它干活？ | `自由模式`（需求中心新建需求选自由模式） | Agent配置 987902821792448512 |
| W15 | 写 Tool 想装个 npm 包 | Tool 源码里能引 npm 包吗？ | `不支持引入三方包` | Tool配置 987903086409252864 |

### 接入开发者（集成影刀能力时遇到具体问题）

| 编号 | 用户场景 | 问题 | 期望事实（原文子串） | 目标文档 |
|---|---|---|---|---|
| W06 | 工具栏没有想要的按钮，排障 | 编辑器工具栏按钮没显示出来，要先检查什么？ | `先注册扩展，再展示菜单` | 功能与菜单配置 996981073845035008 |
| W07 | 用 MCP 删文档，怕误删其它语言版本 | MCP 删除文档会把其它语言版本一起删掉吗？ | `所有语言版本`（delete_document 永久删除） | 文档 MCP 989442877925531648 |
| W12 | React 项目要最快加上 Agent 对话 | 前端项目想最快接入 Agent 对话，用哪种方式？ | `前端接入成本最低`（React SDK） | 接入 Agent 996319787742793728 |
| W13 | 起 Agent Code 想用中文名 | Agent Code 可以用中文吗？有什么限制？ | `字母、数字、中划线和下划线` | 创建 Agent 996231932009361408 |

### 方案借鉴者（想做类似的东西，来找参考）

| 编号 | 用户场景 | 问题 | 期望事实（原文子串） | 目标文档 |
|---|---|---|---|---|
| W08 | 想在自己帮助中心加 AI 问答 | 想在帮助中心页面加个 AI 问答入口，有现成做法吗？ | `右下角`（页面右下角轻量入口） | 文档 AI 助手 997025686102622208 |
| W09 | 客户都在飞书群，想做群内答疑 | 客户都在飞书群里，想做群内 AI 答疑有什么参考？ | `飞书客户群`（接入飞书客户群） | 飞书群 AI 助手 996760435356803072 |
| W10 | 担心 AI 答错后知识不更新 | AI 答不好的问题，怎么变成知识积累下来？ | `复用的知识`（没答好的问题转化为可复用知识） | RPA 答疑助手 998063150522691584 |
| W11 | 怕 AI 客服把指令名叫错 | 怎么防止 AI 把指令名称说错？ | `官方指令名`（结构化候选校准） | 工单 AI 客服 996603748499005440 |

### 运营维护人员（维护知识库和数据）

| 编号 | 用户场景 | 问题 | 期望事实（原文子串） | 目标文档 |
|---|---|---|---|---|
| W02 | 清理旧知识库，怕影响线上 | 删掉不用的知识库之前要确认什么？ | `删除知识库前确认`、`MCP 客户端` | 知识库管理 996621072135696384 |
| W03 | 要大批量清理数据表数据 | 大批量删数据表的数据之前，应该先做什么？ | `导出备份`（批量操作前先导出） | 数据维护与检索方法 997029875383468032 |
| W04 | 准备把 Excel 导入数据集 | 数据集导入支持 Excel 吗？要什么格式？ | `.xlsx`、`.xls` | 快速创建和使用数据集 997029883788853248 |
| W05 | 让 AI 帮写文档，怕它编内容 | 让 AI 写文档，怎么保证它不编造内容？ | `待确认`（缺失内容写待确认） | 用 AI 写文档 989443036708196352 |

## 实测结果（2026-10-13，读者角色版问句）

**17 PASS / 14 FAIL**（15 问 × 双模式 + PG 只读一致）。问句为真实口语场景（与原文词汇重合度低），**难度显著高于 V 系列**（V：21/24，词汇重合高）——通过率差即真实差距。

### 失败归因（全部为质量观察，无逻辑缺陷）

**模式一：目标文档进前五，但事实所在段落不在返回 chunk（W05/W06/W07/W08，共 8 例）**

| 用例 | 命中的 chunk | 事实所在位置 |
|---|---|---|
| W05 | 《用 AI 写文档》首 chunk（指南介绍） | Prompt 要求第 7 条（中后段） |
| W06 | 《功能与菜单配置》中段（菜单组件表） | 开头"配置原则"引用块 |
| W07 | 《文档 MCP》首 chunk（介绍） | 工具速查（中段） |
| W08 | 《文档 AI 助手》首 chunk（介绍） | 流程节"右下角"（中段） |

分块粒度与 topK=5 的固有权衡：文档命中但答案段落不可见。**改善方向**：chunk 富化（把文档标题+小节标题注入 chunk 元素引）、或 Agent 层增大 topK。

**模式二：目标文档未进前五（W02/W03-hybrid/W10/W13-semantic，共 4 例）**

| 用例 | 挤占者 | 根因 |
|---|---|---|
| W02（删知识库确认什么） | 总览 FAQ / Agent 排查等泛化 chunk | "删掉知识库"与《知识库管理》"删除前确认"语义距离大 |
| W10（答错变知识积累） | 工单 AI 客服 / 总览 | "知识积累"与原文"知识缺口/复用知识"词汇差距大 |
| W13-semantic（Code 命名） | 《接入 Agent》（"Agent"字面强命中） | semantic 被"Agent"泛词带偏；hybrid 靠 keyword 纠正通过 |
| W03-hybrid（批量删数据备份） | 数据集能力概览 / 快速创建 | **反向案例**：semantic 通过，hybrid 被 keyword 路的"数据/删"字面命中挤掉目标 |

**核心结论**：通过率与问句-原文词汇重合度强相关；semantic 对"换说法"的鲁棒性有限；hybrid 的词法信号是双刃剑（W13 纠偏、W03 干扰）。**Agent 层应对**：增大 topK / 多轮检索 / 查询改写（把口语转为文档术语）；**内容侧应对**：文档标题直接写用户会问的问题（总览文档自身的建议）。

证据：`results.md` / `evidence.json`（含每问完整响应）。

## 内嵌测试脚本

从本文件提取 javascript 代码块执行（依赖已在运行的 `BASE` 服务与 `PGC` 容器，同 U/V 系列）：

```javascript
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const base = process.env.BASE || 'http://127.0.0.1:18787/api'
const kb = 'kb_yingdao_harness_zh_cn'
const schema = process.env.SCH || 'knowledge'
const out = process.env.OUT || join(tmpdir(), `knowledge-w-${Date.now()}`)
const cases = [
  ['W01', '新发布的文档为什么 AI 暂时搜不到？', '996610332495945728', ['先确认文档已经发布并启用']],
  ['W02', '删掉不用的知识库之前要确认什么？', '996621072135696384', ['删除知识库前确认', 'MCP 客户端']],
  ['W03', '大批量删数据表的数据之前，应该先做什么？', '997029875383468032', ['导出备份']],
  ['W04', '数据集导入支持 Excel 吗？要什么格式？', '997029883788853248', ['.xlsx', '.xls']],
  ['W05', '让 AI 写文档，怎么保证它不编造内容？', '989443036708196352', ['待确认']],
  ['W06', '编辑器工具栏按钮没显示出来，要先检查什么？', '996981073845035008', ['先注册扩展，再展示菜单']],
  ['W07', 'MCP 删除文档会把其它语言版本一起删掉吗？', '989442877925531648', ['所有语言版本']],
  ['W08', '想在帮助中心页面加个 AI 问答入口，有现成做法吗？', '997025686102622208', ['右下角']],
  ['W09', '客户都在飞书群里，想做群内 AI 答疑有什么参考？', '996760435356803072', ['飞书客户群']],
  ['W10', 'AI 答不好的问题，怎么变成知识积累下来？', '998063150522691584', ['复用的知识']],
  ['W11', '怎么防止 AI 把指令名称说错？', '996603748499005440', ['官方指令名']],
  ['W12', '前端项目想最快接入 Agent 对话，用哪种方式？', '996319787742793728', ['前端接入成本最低']],
  ['W13', 'Agent Code 可以用中文吗？有什么限制？', '996231932009361408', ['字母、数字、中划线和下划线']],
  ['W14', '配好的 Agent 要在哪儿选用它干活？', '987902821792448512', ['自由模式']],
  ['W15', 'Tool 源码里能引 npm 包吗？', '987903086409252864', ['不支持引入三方包']],
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
  await test('W16-PG只读一致性', async () => assert(before === snapshot(), '文档或向量摘要变化，需核查外部写入'))
  const counts = rows.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {})
  writeFileSync(join(out, 'evidence.json'), JSON.stringify({ time: new Date().toISOString(), base, kb, documentCount: owned.size, counts, rows }, null, 2))
  writeFileSync(join(out, 'results.md'), '# W 系列（全量覆盖·读者角色版）实测\n\n' + `服务：${base}；知识库：${kb}。\n\n| 用例 | 结果 | 原因 |\n|---|---|---|\n` + rows.map(r => `| ${r.id} | ${r.status} | ${(r.error || '符合预设事实与来源要求').replace(/\|/g, '/')} |`).join('\n') + '\n\n汇总：' + JSON.stringify(counts) + '\n')
  console.log(`汇总 ${JSON.stringify(counts)}；证据 ${out}`)
  process.exitCode = counts.FAIL ? 1 : 0
} catch (e) {
  console.error(`BLOCKED ${String(e?.message || e)}；未完成验收，不计通过`)
  process.exitCode = 2
}
```
