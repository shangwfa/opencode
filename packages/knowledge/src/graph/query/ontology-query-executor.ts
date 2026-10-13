import type { RdfQuad, RdfQuadStore, RdfTerm } from '../rdf/quad-store.js'
import type { OntologyQueryPlan, QueryTerm } from './ontology-query-plan.js'
import { OntologyQueryPlanner } from './ontology-query-plan.js'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

export interface OntologyQueryBinding {
  values: Record<string, RdfTerm>
  statementIds: string[]
  sourceChunkIds: string[]
  sourceRunIds: string[]
}

export interface OntologyQueryResult {
  bindings: OntologyQueryBinding[]
  scannedQuads: number
}

/**
 * 在 RDF quad store 上执行受控 ontology query plan。
 * 这是可移植的基线执行器；大数据量生产场景可替换为 PostgreSQL join compiler。
 */
export class OntologyQueryExecutor {
  private planner: OntologyQueryPlanner

  constructor(private store: RdfQuadStore, ontology?: ConstructorParameters<typeof OntologyQueryPlanner>[0]) {
    this.planner = new OntologyQueryPlanner(ontology)
  }

  async execute(plan: OntologyQueryPlan): Promise<OntologyQueryResult> {
    const errors = this.planner.validate(plan)
    if (errors.length > 0) throw new Error(`ontology query 无效: ${errors.join('; ')}`)
    let bindings: OntologyQueryBinding[] = [{ values: {}, statementIds: [], sourceChunkIds: [], sourceRunIds: [] }]
    let scannedQuads = 0
    for (const pattern of plan.patterns) {
      const next: OntologyQueryBinding[] = []
      for (const binding of bindings) {
        const quads = await this.loadCandidates(pattern, binding, plan)
        scannedQuads += quads.length
        for (const quad of quads) {
          const values = { ...binding.values }
          if (!matchTerm(pattern.subject, quad.subject, values)) continue
          if (!matchTerm(pattern.predicate, quad.predicate, values, true)) continue
          if (!matchTerm(pattern.object, quad.object, values)) continue
          next.push({
            values,
            statementIds: unique([...binding.statementIds, quad.id]),
            sourceChunkIds: unique([...binding.sourceChunkIds, ...(quad.sourceChunkId ? [quad.sourceChunkId] : [])]),
            sourceRunIds: unique([...binding.sourceRunIds, ...(quad.sourceRunId ? [quad.sourceRunId] : [])]),
          })
        }
      }
      bindings = next
      if (bindings.length === 0) break
    }

    if (plan.filters?.length) {
      bindings = bindings.filter((binding) => plan.filters!.every((filter) => {
        const term = binding.values[filter.variable]
        if (!term) return false
        const left = coerce(term.value)
        const right = coerce(String(filter.value))
        switch (filter.operator) {
          case '=': return left === right
          case '!=': return left !== right
          case '>': return left > right
          case '<': return left < right
        }
      }))
    }

    return { bindings: plan.limit ? bindings.slice(0, Math.max(1, Math.floor(plan.limit))) : bindings, scannedQuads }
  }

  private async loadCandidates(
    pattern: OntologyQueryPlan['patterns'][number],
    binding: OntologyQueryBinding,
    plan: OntologyQueryPlan
  ): Promise<RdfQuad[]> {
    const values = [pattern.subject, pattern.predicate, pattern.object].map((term) => {
      if ('value' in term) return term.value === 'a' ? 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' : term.value
      return binding.values[term.variable]?.value
    })
    const graphs = plan.graph
      ? (plan.inferred ? [plan.graph, inferredGraph(plan.graph)] : [plan.graph])
      : [undefined]
    const result: RdfQuad[] = []
    for (const graph of graphs) {
      result.push(...await this.store.match({ subject: values[0], predicate: values[1], object: values[2], graph }))
    }
    return result
  }
}

function matchTerm(pattern: QueryTerm, actual: RdfTerm, values: Record<string, RdfTerm>, predicate = false): boolean {
  if ('variable' in pattern) {
    const bound = values[pattern.variable]
    if (bound) return sameTerm(bound, actual)
    values[pattern.variable] = actual
    return true
  }
  if (predicate && pattern.value === 'a') return actual.value === RDF_TYPE
  return pattern.value === actual.value
}

function sameTerm(left: RdfTerm, right: RdfTerm): boolean {
  return left.kind === right.kind && left.value === right.value && left.datatype === right.datatype && left.language === right.language
}

function inferredGraph(graph: string): string {
  return graph.replace(/^urn:graph:knowledge:/, 'urn:graph:inferred:')
}

function coerce(value: string): string | number {
  const number = Number(value)
  return value.trim() !== '' && Number.isFinite(number) ? number : value
}

function unique(items: string[]): string[] {
  return [...new Set(items)]
}
