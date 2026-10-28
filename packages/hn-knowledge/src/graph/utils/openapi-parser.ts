export interface OpenApiOperation {
  operationId: string
  method: string
  path: string
  summary: string
  description: string
  tags: string[]
  parameters: Array<{ name: string; location: string; required: boolean; type: string; description: string }>
  requestBody: string
  responses: string[]
  schemas: string[]
  /** 请求/响应模型的字段级展开（含一层嵌套引用），用于确定性字段实体入图 */
  schemaFields: Array<{
    schema: string
    name: string
    type: string
    required: boolean
    description: string
    direction: 'request' | 'response'
  }>
}

type AnyRecord = Record<string, any>

function refName(ref: unknown): string | undefined {
  if (typeof ref !== 'string') return undefined
  const value = ref.split('/').pop()
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function schemaType(schema: AnyRecord | undefined): string {
  if (!schema) return 'unknown'
  if (schema.type === 'array') return `${schemaType(schema.items)}[]`
  if (schema.type) return schema.type
  return refName(schema.$ref) || 'object'
}

function schemaFields(schema: AnyRecord | undefined, schemas: AnyRecord, depth = 0): string[] {
  if (!schema || depth > 2) return []
  const resolved = schema.$ref ? schemas[refName(schema.$ref) || ''] : schema
  if (!resolved || typeof resolved !== 'object') return []
  return Object.entries(resolved.properties || {}).flatMap(([name, value]) => {
    const field = value as AnyRecord
    const required = resolved.required?.includes(name) ? '，必填' : ''
    const description = field.description ? `：${String(field.description).replace(/\s+/g, ' ')}` : ''
    const line = `${name}（${schemaType(field)}${required}）${description}`
    const nested = field.$ref ? schemaFields(field, schemas, depth + 1) : []
    return [line, ...nested.map((item) => `  ${item}`)]
  })
}

function mediaSchemaText(content: AnyRecord | undefined, schemas: AnyRecord): string {
  if (!content) return ''
  const first = Object.entries(content)[0]
  if (!first) return ''
  const [mediaType, media] = first as [string, AnyRecord]
  const schema = media?.schema
  const name = refName(schema?.$ref)
  const fields = schemaFields(schema, schemas)
  return [
    `格式：${mediaType}`,
    name ? `模型：${name}` : `类型：${schemaType(schema)}`,
    fields.length > 0 ? `字段：${fields.join('；')}` : '',
  ].filter(Boolean).join('，')
}

function parseParameter(parameter: AnyRecord): OpenApiOperation['parameters'][number] {
  return {
    name: String(parameter.name || ''),
    location: String(parameter.in || 'unknown'),
    required: Boolean(parameter.required),
    type: schemaType(parameter.schema),
    description: String(parameter.description || '').replace(/\s+/g, ' '),
  }
}

function firstJsonSchema(content: AnyRecord | undefined): AnyRecord | undefined {
  const first = Object.entries(content || {})[0] as [string, AnyRecord] | undefined
  return first?.[1]?.schema
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

export function parseOpenApiSpec(spec: AnyRecord): OpenApiOperation[] {
  const schemas = spec.components?.schemas || {}
  const operations: OpenApiOperation[] = []
  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    const item = pathItem as AnyRecord
    const pathParameters = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = item[method] as AnyRecord | undefined
      if (!operation) continue
      const parameters = [...pathParameters, ...(operation.parameters || [])]
        .filter((parameter) => !parameter.$ref)
        .map(parseParameter)
        .filter((parameter) => parameter.name)
      const requestBody = mediaSchemaText(operation.requestBody?.content, schemas)
      const responses = Object.entries(operation.responses || {}).map(([code, response]) => {
        const value = response as AnyRecord
        const text = mediaSchemaText(value.content, schemas)
        return `${code}${value.description ? ` ${String(value.description).replace(/\s+/g, ' ')}` : ''}${text ? `，${text}` : ''}`
      })
      const schemaNames = new Set<string>()
      const collectRef = (value: unknown) => {
        const name = refName(value)
        if (name) schemaNames.add(name)
      }
      collectRef(operation.requestBody?.content?.['application/json']?.schema?.$ref)
      for (const response of Object.values(operation.responses || {}) as AnyRecord[]) {
        for (const media of Object.values(response?.content || {}) as AnyRecord[]) collectRef(media?.schema?.$ref)
      }
      const operationId = String(operation.operationId || `${method}_${path}`.replace(/[^\w]+/g, '_'))
      const schemaFields = [
        ...collectSchemaFields(firstJsonSchema(operation.requestBody?.content), schemas, 'request'),
        ...Object.values(operation.responses || {}).flatMap((response) =>
          collectSchemaFields(firstJsonSchema((response as AnyRecord)?.content), schemas, 'response')),
      ]
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        summary: String(operation.summary || ''),
        description: String(operation.description || '').replace(/\s+/g, ' '),
        tags: Array.isArray(operation.tags) ? operation.tags.map(String) : [],
        parameters,
        requestBody,
        responses,
        schemas: [...schemaNames],
        schemaFields,
      })
    }
  }
  return operations
}

export function operationToText(operation: OpenApiOperation): string {
  return [
    `API 接口：${operation.method} ${operation.path}`,
    `操作标识：${operation.operationId}`,
    operation.tags.length > 0 ? `分类：${operation.tags.join('、')}` : '',
    operation.summary ? `用途：${operation.summary}` : '',
    operation.description ? `说明：${operation.description}` : '',
    operation.parameters.length > 0
      ? `请求参数：${operation.parameters.map((p) => `${p.name}（${p.location}${p.required ? '，必填' : ''}，${p.type}${p.description ? `，${p.description}` : ''}）`).join('；')}`
      : '',
    operation.requestBody ? `请求体：${operation.requestBody}` : '',
    operation.responses.length > 0 ? `响应：${operation.responses.join('；')}` : '',
    operation.schemas.length > 0 ? `引用模型：${operation.schemas.join('、')}` : '',
    `知识实体提示：唯一的 api_operation 实体是“${operation.method} ${operation.path}”，operationId 只是该接口的标识属性，不要单独抽成实体；请求参数和请求体字段是 api_parameter；请求/响应模型是 api_schema。`,
  ].filter(Boolean).join('\n')
}
