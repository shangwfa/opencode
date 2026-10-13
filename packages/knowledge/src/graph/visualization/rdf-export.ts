import type { GraphDB } from '../interface.js'
import type { Subgraph } from '../types.js'

export interface RdfExportOptions {
  /** 本体基础 URI，默认 http://example.org/graph/ */
  baseUri?: string
  knowledgeBaseId?: string
}

/**
 * RDF/Turtle 导出（对标 cognee modules/graph/rdf/export.py）
 *
 * 零依赖实现：
 * - 属性图 → RDF 三元组
 * - 节点 type → rdf:type（映射为 :<Type> 类）
 * - 边 → 属性谓词
 * - 属性 → 字面量
 */
export class RdfExporter {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  async exportToTurtle(options?: RdfExportOptions): Promise<string> {
    const base = (options?.baseUri || 'http://example.org/graph/').replace(/\/?$/, '/')
    const data = await this.graph.getGraphData(options?.knowledgeBaseId)

    const prefixes = [
      '@prefix : <' + base + '> .',
      '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    ]

    const lines: string[] = []

    // 节点 → RDF 资源
    for (const node of data.nodes) {
      const iri = `:${sanitizeIri(node.id)}`
      lines.push(`${iri} rdf:type :${sanitizeIri(capitalize(node.type))} ;`)
      lines.push(`  rdfs:label ${turtleString(node.name)} ;`)
      for (const [key, value] of Object.entries(node.properties || {})) {
        if (value === null || value === undefined) continue
        lines.push(`  :${sanitizeIri(key)} ${turtleLiteral(value)} ;`)
      }
      // 追加结束符：替换最后一个 ' ;' 为 ' .'
      lines[lines.length - 1] = lines[lines.length - 1].replace(/ ;$/, ' .')
    }

    // 边 → RDF 谓词
    for (const edge of data.edges) {
      const s = `:${sanitizeIri(edge.sourceId)}`
      const p = `:${sanitizeIri(edge.relationshipName)}`
      const o = `:${sanitizeIri(edge.targetId)}`
      lines.push(`${s} ${p} ${o} .`)
      // 边权重作为可注释性陈述（reification 的轻量替代：主语带权）
      if (edge.weight !== 1) {
        lines.push(`[] rdf:subject ${s} ; rdf:predicate ${p} ; rdf:object ${o} ; :weight ${edge.weight} .`)
      }
    }

    return [...prefixes, '', ...lines].join('\n')
  }

  /**
   * 导出为 N-Triples（便于程序处理）
   */
  async exportToNTriples(options?: RdfExportOptions): Promise<string[]> {
    const base = (options?.baseUri || 'http://example.org/graph/').replace(/\/?$/, '/')
    const data = await this.graph.getGraphData(options?.knowledgeBaseId)
    const triples: string[] = []

    for (const node of data.nodes) {
      const iri = `<${base}${sanitizeIri(node.id)}>`
      triples.push(`${iri} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${base}${capitalize(sanitizeIri(node.type))}> .`)
      triples.push(`${iri} <http://www.w3.org/2000/01/rdf-schema#label> ${turtleString(node.name)} .`)
    }
    for (const edge of data.edges) {
      triples.push(
        `<${base}${sanitizeIri(edge.sourceId)}> <${base}${sanitizeIri(edge.relationshipName)}> <${base}${sanitizeIri(edge.targetId)}> .`
      )
    }
    return triples
  }
}

function sanitizeIri(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_')
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

function turtleString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

function turtleLiteral(value: unknown): string {
  if (typeof value === 'number') return Number.isInteger(value) ? `${value}` : `"${value}"^^xsd:decimal`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return turtleString(JSON.stringify(value))
  return turtleString(String(value))
}