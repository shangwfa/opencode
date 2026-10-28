import type { OntologyQueryPlan, QueryTerm } from './ontology-query-plan.js'

export interface CompiledOntologySql {
  text: string
  params: unknown[]
  variables: string[]
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

/** 将受控 query plan 编译为参数化 PostgreSQL SQL，避免拼接用户输入。 */
export function compileOntologyQuerySql(plan: OntologyQueryPlan, schemaName: string): CompiledOntologySql {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)) throw new Error('非法 PostgreSQL schema 名称')
  if (plan.patterns.length === 0) throw new Error('query plan 至少需要一个 pattern')
  const params: unknown[] = []
  const aliases = plan.patterns.map((_, index) => `q${index}`)
  const joins = plan.patterns.map((_, index) => `${schemaName}.rdf_quads ${aliases[index]}`)
  const conditions: string[] = []
  const variableColumns = new Map<string, string>()

  plan.patterns.forEach((pattern, index) => {
    const alias = aliases[index]
    addTermCondition(pattern.subject, `${alias}.subject`, conditions, params, variableColumns)
    addTermCondition(pattern.predicate, `${alias}.predicate`, conditions, params, variableColumns, true)
    addTermCondition(pattern.object, `${alias}.object`, conditions, params, variableColumns)
  })

  if (plan.graph) {
    const graphs = plan.inferred ? [plan.graph, inferredGraph(plan.graph)] : [plan.graph]
    conditions.push(`${aliases.map((alias) => `${alias}.graph_name = ANY($${push(params, graphs)}::text[])`).join(' AND ')}`)
  }
  for (const filter of plan.filters || []) {
    const column = variableColumns.get(filter.variable)
    if (!column) throw new Error(`FILTER 引用了未绑定变量: ${filter.variable}`)
    const value = push(params, filter.value)
    conditions.push(`${column} ${filter.operator} $${value}`)
  }

  const selected = plan.variables.map((variable) => {
    const column = variableColumns.get(variable)
    if (!column) throw new Error(`SELECT 引用了未绑定变量: ${variable}`)
    return `${column} AS "${variable.replace(/"/g, '""')}"`
  })
  const provenance = [
    aggregateProvenance(aliases, 'id', 'statementIds'),
    aggregateProvenance(aliases, 'source_chunk_id', 'sourceChunkIds'),
    aggregateProvenance(aliases, 'source_run_id', 'sourceRunIds'),
  ]
  const text = [
    `SELECT DISTINCT ${selected.join(', ')}, ${provenance.join(', ')}`,
    `FROM ${joins.join(', ')}`,
    `WHERE ${conditions.join(' AND ') || 'TRUE'}`,
    `GROUP BY ${selected.map((item) => item.split(' AS ')[0]).join(', ')}`,
    plan.limit ? `LIMIT ${Math.max(1, Math.floor(plan.limit))}` : '',
  ].filter(Boolean).join('\n')
  return { text, params, variables: plan.variables }
}

function addTermCondition(
  term: QueryTerm,
  column: string,
  conditions: string[],
  params: unknown[],
  variableColumns: Map<string, string>,
  predicate = false
): void {
  if ('variable' in term) {
    const existing = variableColumns.get(term.variable)
    if (existing) conditions.push(`${column} = ${existing}`)
    else variableColumns.set(term.variable, column)
    return
  }
  const value = term.value === 'a' && predicate ? RDF_TYPE : term.value
  conditions.push(`${column} = $${push(params, value)}`)
}

function push(params: unknown[], value: unknown): number {
  params.push(value)
  return params.length
}

function aggregateProvenance(aliases: string[], column: string, output: string): string {
  const arrays = aliases.map((alias) =>
    `COALESCE(array_agg(DISTINCT ${alias}.${column}) FILTER (WHERE ${alias}.${column} IS NOT NULL), '{}')`,
  )
  return `ARRAY(SELECT DISTINCT value FROM unnest(${arrays.join(' || ')}) AS provenance(value)) AS "${output}"`
}

function inferredGraph(graph: string): string {
  return graph.replace(/^urn:graph:knowledge:/, 'urn:graph:inferred:')
}
