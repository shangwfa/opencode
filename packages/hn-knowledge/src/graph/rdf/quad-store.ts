import { createHash } from 'node:crypto'

export type RdfTermKind = 'iri' | 'literal'

export interface RdfTerm {
  value: string
  kind: RdfTermKind
  datatype?: string
  language?: string
}

export interface RdfQuad {
  id: string
  subject: RdfTerm
  predicate: RdfTerm
  object: RdfTerm
  graph: string
  sourceRunId?: string
  sourceChunkId?: string
}

export interface RdfQuadPattern {
  subject?: string
  predicate?: string
  object?: string
  graph?: string
}

/** RDF named graph 的最小接口，生产实现可替换为 PostgreSQL quad store。 */
export interface RdfQuadStore {
  add(quads: RdfQuad[]): Promise<void>
  match(pattern?: RdfQuadPattern): Promise<RdfQuad[]>
  deleteBySourceChunkPrefix(prefix: string): Promise<void>
}

export class InMemoryRdfQuadStore implements RdfQuadStore {
  private quads = new Map<string, RdfQuad>()

  async add(quads: RdfQuad[]): Promise<void> {
    for (const quad of quads) this.quads.set(quad.id || quadId(quad), { ...quad, id: quad.id || quadId(quad) })
  }

  async match(pattern: RdfQuadPattern = {}): Promise<RdfQuad[]> {
    return [...this.quads.values()].filter((quad) =>
      (!pattern.subject || quad.subject.value === pattern.subject)
      && (!pattern.predicate || quad.predicate.value === pattern.predicate)
      && (!pattern.object || quad.object.value === pattern.object)
      && (!pattern.graph || quad.graph === pattern.graph)
    )
  }

  async deleteBySourceChunkPrefix(prefix: string): Promise<void> {
    for (const [id, quad] of this.quads) {
      if (quad.sourceChunkId?.startsWith(prefix)) this.quads.delete(id)
    }
  }
}

export function quadId(quad: Omit<RdfQuad, 'id'> | RdfQuad): string {
  const value = [quad.graph, termKey(quad.subject), termKey(quad.predicate), termKey(quad.object)].join('|')
  return `urn:statement:${createHash('sha256').update(value).digest('hex').slice(0, 32)}`
}

function termKey(term: RdfTerm): string {
  return `${term.kind}:${term.value}:${term.datatype || ''}:${term.language || ''}`
}
