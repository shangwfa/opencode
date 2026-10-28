import type { OntologyConfig, OntologyEdgeConfig, OntologyNodeConfig } from './index.js'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment'
const RDFS_SUBCLASS = 'http://www.w3.org/2000/01/rdf-schema#subClassOf'
const OWL_EQUIVALENT = 'http://www.w3.org/2002/07/owl#equivalentClass'
const OWL_DISJOINT = 'http://www.w3.org/2002/07/owl#disjointWith'
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain'
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range'
const OWL = 'http://www.w3.org/2002/07/owl#'

type Triple = [string, string, string]

/**
 * 将常见 OWL/Turtle 本体转换为运行时 OntologyConfig。
 * 支持 prefix、class、object/datatype property、label/comment、继承、domain/range、inverse。
 * 复杂 OWL 推理语义仍由调用方处理，不在解析阶段静默模拟。
 */
export function parseTurtleOntology(turtle: string, name = 'imported-ontology'): OntologyConfig {
  const triples = parseTriples(turtle)
  const values = new Map<string, Map<string, string[]>>()
  const add = (s: string, p: string, o: string) => {
    if (!values.has(s)) values.set(s, new Map())
    const predicates = values.get(s)!
    const list = predicates.get(p) || []
    list.push(o)
    predicates.set(p, list)
  }
  for (const [s, p, o] of triples) add(s, p, o)

  const classes = new Set<string>()
  const objectProperties = new Set<string>()
  const datatypeProperties = new Set<string>()
  for (const [s, p, o] of triples) {
    if (p !== RDF_TYPE) continue
    if (o === `${OWL}Class` || o === 'http://www.w3.org/2000/01/rdf-schema#Class') classes.add(s)
    if (o === `${OWL}ObjectProperty`) objectProperties.add(s)
    if (o === `${OWL}DatatypeProperty`) datatypeProperties.add(s)
  }
  for (const [s, p, o] of triples) {
    if (p === RDFS_DOMAIN || p === RDFS_SUBCLASS) classes.add(o)
    if (p === RDFS_SUBCLASS) classes.add(s)
    if (p === RDFS_RANGE && objectProperties.has(s)) classes.add(o)
  }

  const className = (uri: string) => literal(values.get(uri)?.get(RDFS_LABEL)?.[0]) || localName(uri)
  const classByUri = new Map([...classes].map((uri) => [uri, className(uri)]))
  const nodes: OntologyNodeConfig[] = [...classes].map((uri) => ({
    type: classByUri.get(uri)!,
    uri,
    description: literal(values.get(uri)?.get(RDFS_COMMENT)?.[0]),
    parentTypes: values.get(uri)?.get(RDFS_SUBCLASS)?.map((parent) => classByUri.get(parent) || localName(parent)),
    equivalentTypes: values.get(uri)?.get(OWL_EQUIVALENT)?.map((item) => classByUri.get(item) || localName(item)),
    disjointTypes: values.get(uri)?.get(OWL_DISJOINT)?.map((item) => classByUri.get(item) || localName(item)),
  }))

  const propertyUris = new Set([...objectProperties, ...datatypeProperties])
  const edges: OntologyEdgeConfig[] = [...propertyUris].map((uri) => {
    const props = values.get(uri)
    const kind = datatypeProperties.has(uri) ? 'datatype' : 'object'
    const ranges = props?.get(RDFS_RANGE) || []
    return {
      name: literal(props?.get(RDFS_LABEL)?.[0]) || localName(uri),
      uri,
      description: literal(props?.get(RDFS_COMMENT)?.[0]),
      sourceTypes: (props?.get(RDFS_DOMAIN) || []).map((domain) => classByUri.get(domain) || localName(domain)),
      targetTypes: kind === 'datatype'
        ? ranges.map((range) => range)
        : ranges.map((range) => classByUri.get(range) || localName(range)),
      kind,
      datatype: kind === 'datatype' ? ranges[0] : undefined,
      inverseOf: props?.get(`${OWL}inverseOf`)?.[0]
        ? (literal(values.get(props.get(`${OWL}inverseOf`)![0])?.get(RDFS_LABEL)?.[0]) || localName(props.get(`${OWL}inverseOf`)![0]))
        : undefined,
      functional: (values.get(uri)?.get(RDF_TYPE) || []).includes(`${OWL}FunctionalProperty`),
    }
  })

  return { name, nodes, edges }
}

function literal(value?: string): string | undefined {
  if (!value || !value.startsWith('"')) return undefined
  return value.replace(/^"|"(?:@[a-zA-Z-]+|\^\^.*)?$/g, '')
}

function localName(uri: string): string {
  const value = uri.split(/[\/#]/).pop() || uri
  return value.replace(/[-_]+/g, ' ')
}

function parseTriples(input: string): Triple[] {
  const prefixes = new Map<string, string>()
  const body = stripComments(input)
  const prefixPattern = /(?:@prefix|PREFIX)\s+([\w-]+):\s*<([^>]+)>\s*\.?/gi
  let withoutPrefixes = body.replace(prefixPattern, (_, prefix: string, uri: string) => {
    prefixes.set(prefix, uri)
    return ' '
  })
  const tokens = tokenize(withoutPrefixes)
  const triples: Triple[] = []
  let i = 0
  while (i < tokens.length) {
    const subject = expand(tokens[i++], prefixes)
    if (!subject || subject === '.' || subject === ';' || subject === ',') continue
    let predicate: string | undefined
    while (i < tokens.length) {
      const token = tokens[i++]
      if (token === '.') break
      if (token === ';') { predicate = undefined; continue }
      if (token === ',') continue
      if (!predicate) {
        predicate = expand(token, prefixes)
        continue
      }
      const object = expand(token, prefixes)
      if (object) triples.push([subject, predicate, object])
    }
  }
  return triples
}

function stripComments(input: string): string {
  let output = ''
  let quoted = false
  let iri = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '"' && !iri && input[i - 1] !== '\\') quoted = !quoted
    if (char === '<' && !quoted) iri = true
    if (char === '>' && iri) iri = false
    if (char === '#' && !quoted && !iri) {
      while (i < input.length && input[i] !== '\n' && input[i] !== '\r') i++
      output += ' '
      continue
    }
    output += char
  }
  return output
}

function tokenize(input: string): string[] {
  const tokens: string[] = []
  const pattern = /<[^>]*>|"(?:\\.|[^"\\])*"(?:@[\w-]+|\^\^<[^>]+>|\^\^[\w:.-]+)?|\b(?:a)\b|[;,\.]|[^\s;,\.]+/g
  for (const match of input.matchAll(pattern)) tokens.push(match[0])
  return tokens
}

function expand(token: string, prefixes: Map<string, string>): string {
  if (token === 'a') return RDF_TYPE
  if (token.startsWith('<') && token.endsWith('>')) return token.slice(1, -1)
  if (token.startsWith('"')) return token
  const colon = token.indexOf(':')
  if (colon > 0) {
    const prefix = prefixes.get(token.slice(0, colon))
    if (prefix) return prefix + token.slice(colon + 1)
  }
  return token
}
