import { createHash } from 'node:crypto'

/**
 * 动态表名不能直接由外部 ID 拼接。使用哈希既规避 SQL 注入，也避免规范化和截断造成重名。
 */
export function getBaseKnowledgeIndexName(knowledgeBaseId: string): string {
  const digest = createHash('sha256').update(knowledgeBaseId).digest('hex').slice(0, 32)
  return `bk_${digest}`
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJson(item)])
    )
  }
  return value
}

export function serializeContent(content: string | Record<string, unknown>): string {
  return typeof content === 'string' ? content : JSON.stringify(sortJson(content))
}

export function hashDocumentContent(content: string, type: string): string {
  return createHash('sha256').update(type).update('\0').update(content).digest('hex')
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)]
}

