/** 探测：inner chat 抽取 + inner embedding 是否可用（只读，不写库） */
import { EntityExtractor } from '../src/graph/extraction/entity-extractor.js'
import { defaultEmbedFn } from '../src/graph/extraction/index.js'

const text = 'MCP 配置用于为单独项目配置可加载的 MCP 能力。Remote 服务需要填写 Remote URL 和 Headers。Local 服务需要填写启动命令、参数和环境变量。'

const extractor = new EntityExtractor({ maxRetries: 0 })
const started = Date.now()
try {
  const r = await extractor.extract(text)
  console.log(JSON.stringify({
    chat: 'ok',
    ms: Date.now() - started,
    entities: r.entities.map((e) => `${e.type}:${e.name}`),
    triplets: r.triplets.map((t) => `${t.source}-[${t.relation}]->${t.target}`),
  }, null, 2))
} catch (e) {
  console.log(JSON.stringify({ chat: 'fail', ms: Date.now() - started, error: String(e) }, null, 2))
}

try {
  const emb = await defaultEmbedFn()
  const [v] = await emb(['连接测试'])
  console.log(JSON.stringify({ embedding: 'ok', dim: v?.length }))
} catch (e) {
  console.log(JSON.stringify({ embedding: 'fail', error: String(e) }))
}
