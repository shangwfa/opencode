import type { GraphDB } from '../interface.js'
import type { CombinedExtraction } from '../types.js'
import type { EntityChunkTracker } from '../extraction/entity-chunk-tracker.js'
import { DocumentIngestPipeline, type DocumentIngestResult } from './document-pipeline.js'
import { DEFAULT_ONTOLOGY, type OntologyConfig } from '../ontology/index.js'
import { parseOpenApiSpec, operationToText, type OpenApiOperation } from '../utils/openapi-parser.js'
import { parseSwaggerSpec } from '../utils/swagger-parser.js'

export type ApiSpecFormat = 'openapi' | 'swagger'

export interface ApiSpecIngestOptions {
  knowledgeBaseId: string
  documentId?: string
  schema?: string
  prefix?: string
  limit?: number
  tracker?: EntityChunkTracker
  ontology?: OntologyConfig
  model?: string
  concurrency?: number
  extractTimeoutMs?: number
  onProgress?: (operation: OpenApiOperation, result: DocumentIngestResult) => void
}

export interface ApiSpecIngestResult {
  format: ApiSpecFormat
  operationCount: number
  succeeded: number
  results: DocumentIngestResult[]
}

export const API_SPEC_ONTOLOGY: OntologyConfig = {
  name: 'api-spec',
  nodes: [
    ...DEFAULT_ONTOLOGY.nodes,
    { type: 'api', description: 'API 服务' },
    { type: 'api_operation', description: 'API 操作' },
    { type: 'api_parameter', description: 'API 参数或字段' },
    { type: 'api_schema', description: '请求或响应模型' },
  ],
  edges: [
    ...DEFAULT_ONTOLOGY.edges,
    { name: '提供', sourceTypes: ['api'], targetTypes: ['api_operation'] },
    { name: '接受', sourceTypes: ['api_operation'], targetTypes: ['api_parameter', 'api_schema'] },
    { name: '返回', sourceTypes: ['api_operation'], targetTypes: ['api_schema', 'api_parameter'] },
    { name: '引用', sourceTypes: ['api_operation', 'api_schema'], targetTypes: ['api_schema'] },
    { name: '包含', sourceTypes: ['api_schema'], targetTypes: ['api_parameter'] },
  ],
}

/** schema 字段级确定性抽取：字段实体 + 模型包含字段 + 接口接受/返回字段（不依赖 LLM 随机性） */
function schemaFieldExtraction(operation: OpenApiOperation): CombinedExtraction {
  const operationName = `${operation.method} ${operation.path}`
  const entities: CombinedExtraction['entities'] = []
  const triplets: CombinedExtraction['triplets'] = []
  const seen = new Set<string>()
  const addEntity = (name: string, type: string, description: string) => {
    const key = `${name}|${type}`
    if (!seen.has(key)) {
      seen.add(key)
      entities.push({ name, type, description })
    }
  }
  for (const parameter of operation.parameters) {
    addEntity(parameter.name, 'api_parameter', `${parameter.location} 参数，${parameter.type}${parameter.required ? '，必填' : ''}`)
    triplets.push({ source: operationName, relation: '接受', target: parameter.name, confidence: 1 })
  }
  for (const field of operation.schemaFields) {
    // description 缺失时用接口中文 summary 兜底：让字段实体嵌入文本携带中文语义（跨语言查询召回）
    const semantic = field.description || `${operation.summary || operation.path}接口的${field.direction === 'request' ? '请求' : '响应'}字段`
    addEntity(field.name, 'api_parameter', `${field.schema} 字段：${semantic}${field.required ? '，必填' : ''}（${field.type}）`)
    triplets.push({ source: field.schema, relation: '包含', target: field.name, confidence: 1 })
    triplets.push({ source: operationName, relation: field.direction === 'request' ? '接受' : '返回', target: field.name, confidence: 1 })
  }
  return { entities, triplets }
}

function fallbackExtraction(operation: OpenApiOperation): CombinedExtraction {
  const operationName = `${operation.method} ${operation.path}`
  const entities = [
    { name: operationName, type: 'api_operation', description: operation.summary || operation.description },
    ...operation.parameters.map((p) => ({ name: p.name, type: 'api_parameter', description: `${p.location} 参数，${p.type}${p.required ? '，必填' : ''}` })),
    ...operation.schemas.map((name) => ({ name, type: 'api_schema', description: 'API 请求或响应模型' })),
  ]
  const schemaNames = new Set(operation.schemas)
  for (const text of [operation.requestBody, ...operation.responses]) {
    const match = text.match(/模型：([^，]+)/)
    if (match) schemaNames.add(match[1])
  }
  for (const name of schemaNames) {
    if (!entities.some((entity) => entity.name === name)) entities.push({ name, type: 'api_schema', description: 'API 请求或响应模型' })
  }
  return {
    entities,
    triplets: [
      ...operation.parameters.map((p) => ({ source: operationName, relation: '接受', target: p.name, confidence: 1 })),
      ...[...schemaNames].map((name) => ({ source: operationName, relation: operation.requestBody.includes(name) ? '接受' : '返回', target: name, confidence: 1 })),
    ],
  }
}

export class ApiSpecIngestPipeline {
  constructor(private readonly graph: GraphDB, private readonly defaults: Pick<ApiSpecIngestOptions, 'tracker' | 'model' | 'concurrency' | 'extractTimeoutMs'> = {}) {}

  async ingest(spec: Record<string, any>, options: ApiSpecIngestOptions): Promise<ApiSpecIngestResult> {
    const isSwagger = typeof spec.swagger === 'string'
    const format: ApiSpecFormat = isSwagger ? 'swagger' : 'openapi'
    if (!isSwagger && typeof spec.openapi !== 'string') throw new Error('仅支持 OpenAPI 3.x 或 Swagger 2.0')
    const all = isSwagger ? parseSwaggerSpec(spec) : parseOpenApiSpec(spec)
    const operations = all.filter((operation) => !options.prefix || operation.path.startsWith(options.prefix))
    const selected = options.limit && options.limit > 0 ? operations.slice(0, options.limit) : operations
    const pipeline = new DocumentIngestPipeline(this.graph)
    const results: DocumentIngestResult[] = []
    for (const operation of selected) {
      const result = await pipeline.ingest(operationToText(operation), {
        knowledgeBaseId: options.knowledgeBaseId,
        documentId: `${options.documentId || 'api-spec'}:${operation.method}:${operation.path}`,
        type: 'text',
        ontology: options.ontology || API_SPEC_ONTOLOGY,
        fallbackExtractor: () => fallbackExtraction(operation),
        augmentExtraction: () => schemaFieldExtraction(operation),
        tracker: options.tracker || this.defaults.tracker,
        model: options.model || this.defaults.model,
        concurrency: options.concurrency || this.defaults.concurrency,
        extractTimeoutMs: options.extractTimeoutMs || this.defaults.extractTimeoutMs,
        chunkConfig: { maxSize: 16_000, overlap: 0, separators: ['\n\n'] },
      })
      results.push(result)
      options.onProgress?.(operation, result)
    }
    return { format, operationCount: selected.length, succeeded: results.length, results }
  }
}
