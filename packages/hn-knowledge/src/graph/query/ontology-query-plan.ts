import type { OntologyConfig } from '../ontology/index.js'

export type QueryTerm = { variable: string } | { value: string }

export interface OntologyTriplePattern {
  subject: QueryTerm
  predicate: QueryTerm
  object: QueryTerm
}

export interface OntologyQueryPlan {
  variables: string[]
  patterns: OntologyTriplePattern[]
  filters?: Array<{ variable: string; operator: '=' | '!=' | '>' | '<'; value: string | number | boolean }>
  graph?: string
  inferred?: boolean
  limit?: number
}

/** 解析当前受控执行器生成的 SPARQL 子集，拒绝未支持的查询结构。 */
export function parseSparql(query: string): OntologyQueryPlan {
  const match = query.match(/^\s*SELECT\s+([?\w\s]+)\s+WHERE\s*\{([\s\S]*)\}\s*(?:LIMIT\s+(\d+))?\s*$/i)
  if (!match) throw new Error('仅支持 SELECT ... WHERE { triple patterns } [LIMIT n]')
  const variables = match[1].trim().split(/\s+/).map((item) => item.replace(/^\?/, ''))
  let body = match[2].trim()
  let graph: string | undefined
  const graphMatch = body.match(/^GRAPH\s+<([^>]+)>\s*\{([\s\S]*)\}$/i)
  if (graphMatch) { graph = graphMatch[1]; body = graphMatch[2].trim() }
  const patterns: OntologyTriplePattern[] = []
  const filters: OntologyQueryPlan['filters'] = []
  body = body.replace(/FILTER\s*\(\s*\?(\w+)\s*(=|!=|>|<)\s*("(?:\\.|[^"\\])*")\s*\)/gi, (_, variable: string, operator: '=' | '!=' | '>' | '<', raw: string) => {
    filters.push({ variable, operator, value: raw.slice(1, -1) })
    return ''
  })
  const tokenPattern = /<[^>]+>|"(?:\\.|[^"\\])*"|\?\w+|\ba\b|\./gi
  const tokens = [...body.matchAll(tokenPattern)].map((item) => item[0])
  for (let i = 0; i < tokens.length;) {
    if (tokens[i] === '.') { i++; continue }
    if (tokens.length - i < 4) throw new Error('SPARQL triple pattern 不完整')
    const [subject, predicate, object, end] = tokens.slice(i, i + 4)
    if (end !== '.') throw new Error('SPARQL triple pattern 必须以句点结束')
    patterns.push({ subject: parseTerm(subject), predicate: parseTerm(predicate), object: parseTerm(object) })
    i += 4
  }
  if (patterns.length === 0) throw new Error('SPARQL 至少需要一个 triple pattern')
  return { variables, patterns, filters: filters.length ? filters : undefined, graph, limit: match[3] ? Number(match[3]) : undefined }
}

export class OntologyQueryPlanner {
  constructor(private ontology?: OntologyConfig) {}

  validate(plan: OntologyQueryPlan): string[] {
    const errors: string[] = []
    if (plan.patterns.length === 0) errors.push('query plan 至少需要一个 pattern')
    const boundVariables = new Set<string>()
    for (const pattern of plan.patterns) {
      for (const term of [pattern.subject, pattern.predicate, pattern.object]) {
        if ('variable' in term) boundVariables.add(term.variable)
      }
      const predicate = pattern.predicate
      if ('value' in predicate && this.ontology) {
        const known = this.ontology.edges.some((edge) => edge.name === predicate.value || edge.uri === predicate.value)
        if (!known && predicate.value !== RDF_TYPE) errors.push(`未知 ontology property: ${predicate.value}`)
      }
    }
    for (const variable of plan.variables) {
      if (!boundVariables.has(variable)) errors.push(`SELECT 引用了未绑定变量: ${variable}`)
    }
    for (const filter of plan.filters || []) {
      if (!boundVariables.has(filter.variable)) errors.push(`FILTER 引用了未绑定变量: ${filter.variable}`)
    }
    return errors
  }

  toSparql(plan: OntologyQueryPlan): string {
    const errors = this.validate(plan)
    if (errors.length > 0) throw new Error(`ontology query 无效: ${errors.join('; ')}`)
    const variables = plan.variables.map((variable) => `?${variable}`).join(' ')
    const body = plan.patterns.map((pattern) => `${term(pattern.subject)} ${term(pattern.predicate)} ${term(pattern.object)} .`).join('\n  ')
    const filters = (plan.filters || []).map((filter) => `FILTER (?${filter.variable} ${filter.operator} ${literal(filter.value)})`).join('\n  ')
    const graphBody = `${body}${filters ? `\n  ${filters}` : ''}`
    const where = plan.graph ? `GRAPH <${escapeIri(plan.graph)}> {\n  ${graphBody}\n}` : graphBody
    return `SELECT ${variables}\nWHERE {\n  ${where}\n}${plan.inferred ? ' # includes inferred graph\n' : ''}${plan.limit ? `LIMIT ${Math.max(1, Math.floor(plan.limit))}` : ''}`
  }
}

const RDF_TYPE = 'a'

function term(term: QueryTerm): string {
  if ('value' in term && term.value === RDF_TYPE) return 'a'
  return 'variable' in term ? `?${term.variable}` : iriOrLiteral(term.value)
}

function parseTerm(value: string): QueryTerm {
  if (value.startsWith('?')) return { variable: value.slice(1) }
  if (value === 'a') return { value }
  if (value.startsWith('<') && value.endsWith('>')) return { value: value.slice(1, -1) }
  if (value.startsWith('"') && value.endsWith('"')) return { value: value.slice(1, -1) }
  return { value }
}

function iriOrLiteral(value: string): string {
  return value.startsWith('http://') || value.startsWith('https://') || value.startsWith('urn:') ? `<${escapeIri(value)}>` : literal(value)
}

function literal(value: string | number | boolean): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function escapeIri(value: string): string {
  return value.replace(/[<>"{}|\\^`]/g, '')
}
