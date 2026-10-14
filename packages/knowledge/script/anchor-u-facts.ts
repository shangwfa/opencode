/** 期望先行：从 RAG 原文锚定 U01-U12 的事实子串（只读） */
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'

const POOL = new Pool({ connectionString: 'postgresql://postgres:ab123456@127.0.0.1:55432/knowledge' })
const CASES = [
  { id: 'U01', doc: '994499662063226880', keys: ['分支', '单独验收'] },
  { id: 'U02', doc: '994499662063226880', keys: ['继承', '摘要', '逐字'] },
  { id: 'U03', doc: '994499662063226880', keys: ['取消提交', '取消复制'] },
  { id: 'U04', doc: '987902908331687936', keys: ['解绑', '添加弹窗', '当前项目'] },
  { id: 'U05', doc: '987903017838411776', keys: ['Remote URL', 'Headers', '启动命令', '环境变量'] },
  { id: 'U06', doc: '989008792326234112', keys: ['自动', '设计', '手动'] },
  { id: 'U07', doc: '996621057543712768', keys: ['失败', '重试', '原因'] },
  { id: 'U08', doc: '996621067853312000', keys: ['任务', '完成', '状态'] },
  { id: 'U09', doc: '997029879951753216', keys: ['数据表', '知识库', '事实'] },
  { id: 'U10', doc: '997029870480326656', keys: ['datasetId', 'General'] },
  { id: 'U11', doc: '998053780952412160', keys: ['Tool Result', '输出'] },
  { id: 'U12', doc: '996621064644669440', keys: ['混合', '原文', '链接'] },
]

function tiptapText(value: unknown): string {
  if (Array.isArray(value)) return value.map(tiptapText).join(' ')
  if (!value || typeof value !== 'object') return ''
  const node = value as Record<string, unknown>
  if (node.type === 'text' && typeof node.text === 'string') return node.text
  return Object.values(node).map(tiptapText).join(' ')
}

const { rows } = await POOL.query<{ id: string; content: string }>(
  `SELECT id, content FROM knowledge.documents WHERE knowledge_base_id='kb_yingdao_harness_zh_cn' AND id = ANY($1::varchar[])`,
  [CASES.map((c) => c.doc)]
)
const texts = new Map(rows.map((r) => [r.id, tiptapText(JSON.parse(r.content)).replace(/\s+/g, '')]))

for (const c of CASES) {
  const text = texts.get(c.doc)!
  console.log(`\n== ${c.id} (${c.doc})`)
  for (const key of c.keys) {
    const idx = text.indexOf(key)
    console.log(idx >= 0 ? `  [${key}] …${text.slice(Math.max(0, idx - 25), idx + key.length + 25)}…` : `  [${key}] NOT-FOUND`)
  }
}
await POOL.end()
