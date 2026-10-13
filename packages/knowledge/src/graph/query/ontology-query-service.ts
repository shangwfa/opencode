import type { OntologyConfig } from '../ontology/index.js'
import type { RdfQuadStore } from '../rdf/quad-store.js'
import { OntologyQueryExecutor, type OntologyQueryResult } from './ontology-query-executor.js'
import { OntologyQueryPlanner, parseSparql, type OntologyQueryPlan } from './ontology-query-plan.js'

interface NativeQueryStore extends RdfQuadStore {
  executePlan(plan: OntologyQueryPlan): Promise<OntologyQueryResult>
}

/** 对外查询门面：统一校验、执行和返回可用于 Evidence 的 statement provenance。 */
export class OntologyQueryService {
  private planner: OntologyQueryPlanner
  private executor: OntologyQueryExecutor
  private store: RdfQuadStore

  constructor(store: RdfQuadStore, ontology?: OntologyConfig) {
    this.store = store
    this.planner = new OntologyQueryPlanner(ontology)
    this.executor = new OntologyQueryExecutor(store, ontology)
  }

  async query(plan: OntologyQueryPlan): Promise<OntologyQueryResult> {
    const nativeStore = this.store as Partial<NativeQueryStore>
    if (typeof nativeStore.executePlan === 'function') return nativeStore.executePlan(plan)
    return this.executor.execute(plan)
  }

  async querySparql(sparql: string): Promise<OntologyQueryResult> {
    return this.query(parseSparql(sparql))
  }

  explain(plan: OntologyQueryPlan): { sparql: string; errors: string[] } {
    const errors = this.planner.validate(plan)
    return { sparql: errors.length === 0 ? this.planner.toSparql(plan) : '', errors }
  }
}
