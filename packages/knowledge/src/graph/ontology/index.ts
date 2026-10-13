import { createHash } from 'crypto'
import type { CombinedExtraction } from '../types.js'

/** 标准 UUIDv5 命名空间（对标 cognee DataPoint.id_for 使用的 NAMESPACE_OID） */
const NAMESPACE_OID = '6ba7b812-9dad-11d1-80b4-00c04fd430c8'

/**
 * 确定性实体节点 id（对标 cognee Entity.id_for：uuid5(NAMESPACE_OID, "Entity:<name>")）
 */
export function entityNodeId(knowledgeBaseId: string, name: string): string {
  const nsBytes = new Uint8Array(16)
  const hex = NAMESPACE_OID.replace(/-/g, '')
  for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  const hash = createHash('sha1').update(nsBytes).update(`Entity:${knowledgeBaseId}:${name}`, 'utf8').digest()
  const b = hash.slice(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Buffer.from(b).toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** EntityType 节点统一归属的虚拟知识库 ID */
export const ENTITY_TYPE_KB = '__entity_types__'

/**
 * EntityType 节点确定性 id
 */
export function entityTypeNodeId(typeName: string): string {
  return entityNodeId(ENTITY_TYPE_KB, `EntityType:${typeName}`)
}

/**
 * 将本体约束文本注入 LLM 提取提示（对标 cognee generate_graph_prompt_guided）
 */
export function injectOntology(prompt: string, ontologyText?: string): string {
  if (!ontologyText) return prompt
  return `${prompt}\n\n【本体约束】提取时必须遵守以下类型和关系约束，超出约束的实体和关系请忽略：\n${ontologyText}`
}

export interface OntologyNodeConfig {
  type: string
  description?: string
  /** OWL class URI（可选） */
  uri?: string
  /** 父类类型名（可选） */
  parentTypes?: string[]
  /** 等价类类型名或 URI（可选） */
  equivalentTypes?: string[]
  /** 互斥类类型名或 URI（可选） */
  disjointTypes?: string[]
  /** 允许的关系（作为 source 时） */
  allowedOutgoing?: string[]
  /** 允许的关系（作为 target 时） */
  allowedIncoming?: string[]
}

export interface OntologyEdgeConfig {
  name: string
  description?: string
  /** OWL property URI（可选） */
  uri?: string
  sourceTypes: string[]
  targetTypes: string[]
  /** 单值关系：同一 (source, relation, target) 只保留一个有效值 */
  functional?: boolean
  /** 反向属性名称（可选） */
  inverseOf?: string
  /** object property 或 datatype property */
  kind?: 'object' | 'datatype'
  /** datatype property 的 RDF datatype URI */
  datatype?: string
}

export interface OntologyConfig {
  name: string
  nodes: OntologyNodeConfig[]
  edges: OntologyEdgeConfig[]
}

export interface OntologyValidationResult {
  valid: boolean
  violations: Array<{
    kind: 'unknown_node_type' | 'unknown_relation' | 'relation_not_allowed' | 'unknown_attribute' | 'attribute_not_allowed'
    detail: string
  }>
  filtered: CombinedExtraction
}

export { parseTurtleOntology } from './turtle.js'

/**
 * 本体管理（对标 cognee modules/ontology，最小实现）
 *
 * 功能：
 * 1. 定义允许的节点类型和关系类型
 * 2. 校验 LLM 提取结果是否符合本体约束
 * 3. 过滤不符合约束的实体/三元组，提升图质量
 */
export class OntologyValidator {
  private config: OntologyConfig
  private nodeTypes: Set<string>
  private edgeMap: Map<string, OntologyEdgeConfig>
  private nodeMap: Map<string, OntologyNodeConfig>

  constructor(config: OntologyConfig) {
    this.config = config
    this.nodeTypes = new Set(config.nodes.map((n) => n.type))
    this.nodeMap = new Map(config.nodes.map((n) => [n.type, n]))
    this.edgeMap = new Map(config.edges.map((e) => [e.name, e]))
  }

  /**
   * 校验并过滤提取结果
   */
  validate(extraction: CombinedExtraction): OntologyValidationResult {
    const violations: OntologyValidationResult['violations'] = []

    // 1. 过滤未知节点类型
    const knownTypeEntities = extraction.entities.filter((e) => {
      if (this.nodeTypes.size === 0) return true
      if (this.nodeTypes.has(e.type)) return true
      violations.push({
        kind: 'unknown_node_type',
        detail: `实体 "${e.name}" 的类型 "${e.type}" 不在本体定义中`,
      })
      return false
    })
    const knownNames = new Set(knownTypeEntities.map((e) => e.name))

    // 2. 过滤引用缺失实体的三元组
    const entitiesWithAttributes = knownTypeEntities.map((entity) => ({
      ...entity,
      attributes: entity.attributes?.filter((attribute) => {
        if (this.edgeMap.size === 0) return true
        const edge = this.edgeMap.get(attribute.name)
        if (!edge || edge.kind !== 'datatype') {
          violations.push({ kind: 'unknown_attribute', detail: `属性 "${attribute.name}" 不在本体数据属性定义中（${entity.name}）` })
          return false
        }
        if (!this.isTypeCompatible(entity.type, edge.sourceTypes)) {
          violations.push({ kind: 'attribute_not_allowed', detail: `属性 "${attribute.name}" 不允许从类型 "${entity.type}" 发出（${entity.name}）` })
          return false
        }
        return true
      }),
    }))

    const completeTriplets = extraction.triplets.filter((t) => {
      if (!knownNames.has(t.source) || !knownNames.has(t.target)) return false
      return true
    })

    // 3. 过滤未知关系 / 关系端类型不匹配
    const validTriplets = completeTriplets.filter((t) => {
      if (this.edgeMap.size === 0) return true

      const sourceEntity = knownTypeEntities.find((e) => e.name === t.source)!
      const targetEntity = knownTypeEntities.find((e) => e.name === t.target)!

      if (!this.edgeMap.has(t.relation)) {
        violations.push({
          kind: 'unknown_relation',
          detail: `关系 "${t.relation}" 不在本体定义中（${t.source} → ${t.target}）`,
        })
        return false
      }

      const edgeConfig = this.edgeMap.get(t.relation)!
      if (edgeConfig.kind === 'datatype') {
        violations.push({ kind: 'relation_not_allowed', detail: `数据属性 "${t.relation}" 不能作为实体关系（${t.source} → ${t.target}）` })
        return false
      }
      if (!this.isTypeCompatible(sourceEntity.type, edgeConfig.sourceTypes)) {
        violations.push({
          kind: 'relation_not_allowed',
          detail: `关系 "${t.relation}" 不允许从类型 "${sourceEntity.type}" 发出（${t.source} → ${t.target}）`,
        })
        return false
      }
      if (!this.isTypeCompatible(targetEntity.type, edgeConfig.targetTypes)) {
        violations.push({
          kind: 'relation_not_allowed',
          detail: `关系 "${t.relation}" 不允许指向类型 "${targetEntity.type}"（${t.source} → ${t.target}）`,
        })
        return false
      }
      return true
    })

    return {
      valid: violations.length === 0,
      violations,
      filtered: { entities: entitiesWithAttributes, triplets: validTriplets },
    }
  }

  private isTypeCompatible(actual: string, allowed: string[]): boolean {
    if (allowed.length === 0) return true
    if (allowed.includes(actual)) return true
    const visited = new Set<string>()
    const visit = (type: string): boolean => {
      if (visited.has(type)) return false
      visited.add(type)
      const parents = this.nodeMap.get(type)?.parentTypes || []
      return parents.some((parent) => allowed.includes(parent) || visit(parent))
    }
    return visit(actual)
  }

  /**
   * 获取 functional 关系列表（供时间矛盾解决器使用）
   */
  getFunctionalRelations(): string[] {
    return this.config.edges.filter((e) => e.functional).map((e) => e.name)
  }

  /** 查询阶段复用 domain/range 校验，避免检索返回本体不允许的路径。 */
  isTripletAllowed(sourceType: string, relation: string, targetType: string): boolean {
    if (this.edgeMap.size === 0) return true
    const edge = this.edgeMap.get(relation)
    if (!edge || edge.kind === 'datatype') return false
    return this.isTypeCompatible(sourceType, edge.sourceTypes)
      && this.isTypeCompatible(targetType, edge.targetTypes)
  }

  /**
   * 导出为本体摘要文本（可注入 LLM 提取提示，约束提取范围）
   */
  toPromptText(): string {
    const nodes = this.config.nodes
      .map((n) => `- ${n.type}${n.description ? `: ${n.description}` : ''}${n.uri ? ` [${n.uri}]` : ''}`)
      .join('\n')
    const edges = this.config.edges
      .map((e) => `- ${e.name}: ${e.sourceTypes.join('|')} → ${e.targetTypes.join('|')}${e.kind === 'datatype' ? '（数据属性）' : ''}${e.functional ? '（单值）' : ''}${e.description ? `：${e.description}` : ''}`)
      .join('\n')
    return `允许的实体类型：\n${nodes}\n\n允许的关系（source 类型 → target 类型）：\n${edges}`
  }
}

/**
 * 影刀客服场景默认本体（示例）
 */
export const DEFAULT_ONTOLOGY: OntologyConfig = {
  name: 'yingdao-support',
  nodes: [
    { type: 'person', description: '人物' },
    { type: 'technology', description: '技术、工具、框架、库' },
    { type: 'concept', description: '概念、理论、方法论' },
    { type: 'product', description: '产品、服务、平台' },
    { type: 'organization', description: '组织、公司、团队' },
    { type: 'feature', description: '功能、特性' },
    { type: 'term', description: '术语、专有名词' },
    { type: 'language', description: '编程语言' },
    { type: 'process', description: '流程、步骤、方法' },
    { type: 'event', description: '事件' },
  ],
  edges: [
    { name: '使用', sourceTypes: ['person', 'product', 'technology'], targetTypes: ['technology', 'language', 'feature'] },
    { name: '属于', sourceTypes: ['technology', 'feature', 'person', 'product'], targetTypes: ['product', 'organization', 'concept'] },
    { name: '依赖', sourceTypes: ['technology', 'feature'], targetTypes: ['technology', 'product'] },
    { name: '包含', sourceTypes: ['product', 'process', 'concept'], targetTypes: ['feature', 'process', 'technology'] },
    { name: '用于', sourceTypes: ['technology', 'feature', 'process'], targetTypes: ['concept', 'process', 'feature'] },
    { name: '识别', sourceTypes: ['feature', 'technology', 'process'], targetTypes: ['technology', 'process', 'feature'] },
    { name: '基于', sourceTypes: ['technology', 'product'], targetTypes: ['technology', 'language'] },
    { name: '集成', sourceTypes: ['product', 'technology'], targetTypes: ['product', 'technology'] },
    { name: '导致', sourceTypes: ['event', 'process'], targetTypes: ['event', 'feature'] },
    { name: '发生在', sourceTypes: ['event'], targetTypes: ['event', 'process'], functional: false },
    { name: '版本为', sourceTypes: ['product', 'technology'], targetTypes: ['term'], functional: true },
    // 与抽取 prompt 对齐的关系词收编：prompt 引导 LLM 抽取的关系必须在白名单内，
    // 否则入库前被本体硬校验过滤（FDE 职责链"负责"关系曾被整体丢弃）。
    // 端类型留空（[]）= 不限制，兼容跨类型的职责/规则/聚合关系。
    { name: '负责', sourceTypes: [], targetTypes: [] },
    { name: '核心能力', sourceTypes: [], targetTypes: [] },
    { name: '支持', sourceTypes: ['product', 'feature', 'technology', 'process'], targetTypes: ['technology', 'feature', 'concept', 'process'] },
    { name: '分为', sourceTypes: [], targetTypes: [] },
    { name: '不负责', sourceTypes: [], targetTypes: [] },
    { name: '禁止', sourceTypes: [], targetTypes: [] },
    { name: '适合从', sourceTypes: [], targetTypes: [] },
    { name: '应基于', sourceTypes: [], targetTypes: [] },
    { name: '证据不足时交回', sourceTypes: [], targetTypes: [] },
    { name: '竞争对手', sourceTypes: ['product', 'technology'], targetTypes: ['product', 'technology'] },
    { name: '对比对象', sourceTypes: ['product', 'technology', 'concept'], targetTypes: ['product', 'technology', 'concept'] },
    { name: '转化', sourceTypes: [], targetTypes: [] },
    { name: '推动', sourceTypes: [], targetTypes: [] },
    { name: '帮助成为', sourceTypes: [], targetTypes: [] },
  ],
}
