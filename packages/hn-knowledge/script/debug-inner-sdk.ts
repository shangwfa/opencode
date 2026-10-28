/** 验证：OpenRouter gpt-6-luna 经 knowledge SDK 的完整抽取（structured 应一次成功） */
import { EntityExtractor } from '../src/graph/extraction/entity-extractor.js'

const extractor = new EntityExtractor() // KNOWLEDGE_DEFAULT_CHAT_MODEL=openai/gpt-6-luna
const text = 'MCP 配置用于为单独项目配置可加载的 MCP 能力。Remote 服务需要填写 Remote URL 和 Headers。Local 服务需要填写启动命令、参数和环境变量。'
const started = Date.now()
const r = await extractor.extract(text)
console.log(JSON.stringify({
  ms: Date.now() - started,
  entities: r.entities.map((e) => `${e.type}:${e.name}`),
  triplets: r.triplets.map((t) => `${t.source}-[${t.relation}]->${t.target}`),
}, null, 2))
