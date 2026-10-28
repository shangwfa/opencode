import type { OntologyConfig } from '../ontology/index.js'
import type { RdfQuad, RdfTerm } from './quad-store.js'
import { quadId } from './quad-store.js'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'

export interface ReasoningConflict {
  kind: 'disjoint_class' | 'functional_property'
  subject: string
  predicate?: string
  objects?: string[]
  detail: string
}

export interface ReasoningResult {
  inferred: RdfQuad[]
  conflicts: ReasoningConflict[]
}

/** 基础 OWL-RL 推理：继承、等价类、domain/range、inverse、functional 和 disjoint 检测。 */
export function inferOntologyFacts(
  facts: RdfQuad[],
  ontology: OntologyConfig,
  graph = 'urn:graph:inferred'
): ReasoningResult {
  const inferred: RdfQuad[] = []
  const seen = new Set(facts.map((fact) => quadId(fact)))
  const add = (subject: RdfTerm, predicate: string, object: RdfTerm, source: RdfQuad) => {
    const quad = { subject, predicate: iri(predicate), object, graph, sourceRunId: source.sourceRunId, sourceChunkId: source.sourceChunkId } as Omit<RdfQuad, 'id'>
    const id = quadId(quad)
    if (!seen.has(id)) {
      seen.add(id)
      inferred.push({ ...quad, id })
    }
  }

  const classUris = new Map(ontology.nodes.filter((node) => node.uri).map((node) => [node.type, node.uri!]))
  const parentByUri = new Map<string, string[]>()
  for (const node of ontology.nodes) {
    if (!node.uri) continue
    parentByUri.set(node.uri, (node.parentTypes || []).map((parent) => classUris.get(parent) || parent))
  }
  const propertyByName = new Map(ontology.edges.filter((edge) => edge.uri).map((edge) => [edge.name, edge]))
  const propertyUris = new Map(ontology.edges.filter((edge) => edge.uri).map((edge) => [edge.uri!, edge]))

  for (const fact of facts) {
    if (fact.predicate.value === RDF_TYPE) {
      const parents = closure(parentByUri, fact.object.value)
      for (const parent of parents) add(fact.subject, RDF_TYPE, iri(parent), fact)
      const current = ontology.nodes.find((node) => node.uri === fact.object.value)
      for (const equivalent of current?.equivalentTypes || []) {
        const uri = classUris.get(equivalent) || equivalent
        add(fact.subject, RDF_TYPE, iri(uri), fact)
      }
    }
    const property = propertyUris.get(fact.predicate.value)
    if (!property) continue
    for (const type of ontology.nodes) {
      if (type.uri && property.sourceTypes.includes(type.type)) add(fact.subject, RDF_TYPE, iri(type.uri), fact)
      if (type.uri && property.targetTypes.includes(type.type) && fact.object.kind === 'iri') add(fact.object, RDF_TYPE, iri(type.uri), fact)
    }
    if (property.inverseOf) {
      const inverse = propertyByName.get(property.inverseOf)?.uri || property.inverseOf
      add(fact.object, inverse, fact.subject, fact)
    }
  }

  const allFacts = [...facts, ...inferred]
  const conflicts: ReasoningConflict[] = []
  for (const node of ontology.nodes) {
    if (!node.uri) continue
    const disjoint = (node.disjointTypes || []).map((type) => classUris.get(type) || type)
    for (const fact of allFacts.filter((item) => item.predicate.value === RDF_TYPE && item.object.value === node.uri)) {
      const incompatible = allFacts.find((item) => item.subject.value === fact.subject.value && item.predicate.value === RDF_TYPE && disjoint.includes(item.object.value))
      if (incompatible) conflicts.push({ kind: 'disjoint_class', subject: fact.subject.value, objects: [node.uri, incompatible.object.value], detail: `${fact.subject.value} 同时属于互斥类型` })
    }
  }
  for (const edge of ontology.edges.filter((item) => item.functional && item.uri)) {
    const bySubject = new Map<string, Set<string>>()
    for (const fact of allFacts.filter((item) => item.predicate.value === edge.uri)) {
      const objects = bySubject.get(fact.subject.value) || new Set<string>()
      objects.add(fact.object.value)
      bySubject.set(fact.subject.value, objects)
    }
    for (const [subject, objects] of bySubject) {
      if (objects.size > 1) conflicts.push({ kind: 'functional_property', subject, predicate: edge.uri, objects: [...objects], detail: `functional property ${edge.name} 存在多个值` })
    }
  }

  return { inferred, conflicts }
}

function closure(parents: Map<string, string[]>, start: string): string[] {
  const result: string[] = []
  const queue = [...(parents.get(start) || [])]
  const visited = new Set<string>()
  while (queue.length) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    result.push(current)
    queue.push(...(parents.get(current) || []))
  }
  return result
}

function iri(value: string): RdfTerm {
  return { value, kind: 'iri' }
}
