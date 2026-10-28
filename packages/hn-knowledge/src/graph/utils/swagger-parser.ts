import type { OpenApiOperation } from './openapi-parser.js'

type AnyRecord = Record<string, any>

function refName(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined
  const value = ref.split('/').pop()
  if (!value) return undefined
  try { return decodeURIComponent(value) } catch { return value }
}

function schemaType(schema: AnyRecord | undefined): string {
  if (!schema) return 'unknown'
  if (schema.type === 'array') return `${schemaType(schema.items)}[]`
  return String(schema.type || refName(schema.$ref) || 'object')
}

function schemaFields(schema: AnyRecord | undefined, schemas: AnyRecord, depth = 0): string[] {
  if (!schema || depth > 2) return []
  const resolved = schema.$ref ? schemas[refName(schema.$ref) || ''] : schema
  if (!resolved || typeof resolved !== 'object') return []
  return Object.entries(resolved.properties || {}).flatMap(([name, value]) => {
    const field = value as AnyRecord
    const required = resolved.required?.includes(name) ? '，必填' : ''
    const description = field.description ? `：${String(field.description).replace(/\s+/g, ' ')}` : ''
    return [`${name}（${schemaType(field)}${required}）${description}`, ...schemaFields(field, schemas, depth + 1).map((item) => `  ${item}`)]
  })
}

function schemaText(schema: AnyRecord | undefined, schemas: AnyRecord, mediaType?: string): string {
  if (!schema) return ''
  const name = refName(schema.$ref)
  const fields = schemaFields(schema, schemas)
  return [
    mediaType ? `格式：${mediaType}` : '',
    name ? `模型：${name}` : `类型：${schemaType(schema)}`,
    fields.length > 0 ? `字段：${fields.join('；')}` : '',
  ].filter(Boolean).join('，')
}

function collectSchemaFields(
  schema: AnyRecord | undefined,
  schemas: AnyRecord,
  direction: 'request' | 'response',
  depth = 0
): OpenApiOperation['schemaFields'] {
  const name = refName(schema?.$ref)
  if (!name || depth > 2) return []
  const resolved = schemas[name]
  if (!resolved || typeof resolved !== 'object') return []
  return Object.entries(resolved.properties || {}).flatMap(([fieldName, raw]) => {
    const field = raw as AnyRecord
    const own: OpenApiOperation['schemaFields'][number] = {
      schema: name,
      name: fieldName,
      type: schemaType(field),
      required: Boolean((resolved.required as string[] | undefined)?.includes(fieldName)),
      description: String(field.description || '').replace(/\s+/g, ' '),
      direction,
    }
    const child = field.$ref ? field : field.type === 'array' ? field.items : undefined
    return [own, ...collectSchemaFields(child, schemas, direction, depth + 1)]
  })
}

export function parseSwaggerSpec(spec: AnyRecord): OpenApiOperation[] {
  const schemas = spec.definitions || {}
  const operations: OpenApiOperation[] = []
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    const item = pathItem as AnyRecord
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = item[method] as AnyRecord | undefined
      if (!operation) continue
      const parameters = (operation.parameters || []).filter((p: AnyRecord) => !p.$ref).map((p: AnyRecord) => ({
        name: String(p.name || ''),
        location: String(p.in || 'unknown'),
        required: Boolean(p.required),
        type: schemaType(p.schema || p),
        description: String(p.description || '').replace(/\s+/g, ' '),
      })).filter((p: OpenApiOperation['parameters'][number]) => p.name)
      const body = (operation.parameters || []).find((p: AnyRecord) => p.in === 'body')
      const requestBody = body?.schema ? schemaText(body.schema, schemas, (spec.consumes || [])[0]) : ''
      const responses = Object.entries(operation.responses || {}).map(([code, response]) => {
        const value = response as AnyRecord
        const text = schemaText(value.schema, schemas, (spec.produces || [])[0])
        return `${code}${value.description ? ` ${String(value.description).replace(/\s+/g, ' ')}` : ''}${text ? `，${text}` : ''}`
      })
      const schemaNames = new Set<string>()
      const collect = (value: unknown) => { const name = refName(value); if (name) schemaNames.add(name) }
      collect(body?.schema?.$ref)
      for (const response of Object.values(operation.responses || {}) as AnyRecord[]) collect(response?.schema?.$ref)
      const operationId = String(operation.operationId || `${method}_${path}`.replace(/[^\w]+/g, '_'))
      const operationSchemaFields = [
        ...collectSchemaFields(body?.schema, schemas, 'request'),
        ...Object.values(operation.responses || {}).flatMap((response) =>
          collectSchemaFields((response as AnyRecord)?.schema, schemas, 'response')),
      ]
      operations.push({
        operationId, method: method.toUpperCase(), path,
        summary: String(operation.summary || ''),
        description: String(operation.description || '').replace(/\s+/g, ' '),
        tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
        parameters, requestBody, responses, schemas: [...schemaNames],
        schemaFields: operationSchemaFields,
      })
    }
  }
  return operations
}
