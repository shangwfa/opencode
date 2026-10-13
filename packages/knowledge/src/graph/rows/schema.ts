import { z } from 'zod'

export type RowFieldType = 'string' | 'number' | 'boolean' | 'date'

export interface RowField {
  name: string
  type: RowFieldType
  description?: string
  /** 主键字段（对标 TrustGraph primary → row_id） */
  primary?: boolean
  required?: boolean
  /** 枚举约束（对标 enum_values） */
  enumValues?: string[]
  /** 精确过滤索引（对标 query-indexes）：可出现在结构化过滤条件中 */
  queryIndex?: boolean
  /** 语义索引（对标 vector-indexes）：参与行文本嵌入 */
  vectorIndex?: boolean
}

/**
 * 行 Schema（对标 TrustGraph RowSchema：结构化行数据的类型定义）
 *
 * 三类索引语义与 TrustGraph 对齐：
 * - primary → 行唯一标识（缺省时用自动生成 id）
 * - queryIndex → 精确过滤字段
 * - vectorIndex → 语义嵌入字段
 */
export interface RowSchema {
  name: string
  description?: string
  fields: RowField[]
}

export type RowFieldValue = string | number | boolean | null
export type RowData = Record<string, RowFieldValue>

export type RowFilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains'

export interface RowFilter {
  /** 字段名（必须在 schema.fields 中且 queryIndex 为 true——白名单防注入） */
  field: string
  op: RowFilterOp
  value: RowFieldValue | RowFieldValue[]
}

export const RowFieldSchemaZod = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date']),
  description: z.string().optional(),
  primary: z.boolean().optional(),
  required: z.boolean().optional(),
  enumValues: z.array(z.string()).optional(),
  queryIndex: z.boolean().optional(),
  vectorIndex: z.boolean().optional(),
})

export const RowSchemaZod = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(RowFieldSchemaZod).min(1),
})

/** 行文本构造（对标 TrustGraph row_embeddings：vectorIndex 字段拼为嵌入文本；缺省用全部字段） */
export function rowToText(schema: RowSchema, row: RowData): string {
  const vectorFields = schema.fields.filter((f) => f.vectorIndex)
  const fields = vectorFields.length > 0 ? vectorFields : schema.fields
  return fields
    .map((f) => {
      const v = row[f.name]
      return v === null || v === undefined ? '' : String(v)
    })
    .filter(Boolean)
    .join('；')
}

/** 行校验：required / enum / 类型检查，返回违规明细 */
export function validateRow(schema: RowSchema, row: RowData): string[] {
  const violations: string[] = []
  for (const field of schema.fields) {
    const value = row[field.name]

    if (value === null || value === undefined || value === '') {
      if (field.required) violations.push(`字段 "${field.name}" 为必填`)
      continue
    }

    if (field.type === 'number' && typeof value !== 'number' && isNaN(Number(value))) {
      violations.push(`字段 "${field.name}" 应为数字，实际: ${value}`)
    }
    if (field.type === 'boolean' && typeof value !== 'boolean') {
      violations.push(`字段 "${field.name}" 应为布尔，实际: ${value}`)
    }
    if (field.enumValues && field.enumValues.length > 0 && !field.enumValues.includes(String(value))) {
      violations.push(`字段 "${field.name}" 值 "${value}" 不在枚举 [${field.enumValues.join(', ')}] 中`)
    }
  }
  return violations
}

/** 生成给 LLM 看的 schema 描述文本（对标 schema-selection prompt 的 schema 概览输入） */
export function getRowSchemaText(schema: RowSchema, detailed = false): string {
  const header = `- ${schema.name}${schema.description ? `：${schema.description}` : ''}`
  if (!detailed) return header
  const fields = schema.fields
    .map((f) => {
      const tags: string[] = [f.type]
      if (f.primary) tags.push('主键')
      if (f.required) tags.push('必填')
      if (f.queryIndex) tags.push('可过滤')
      if (f.vectorIndex) tags.push('语义检索')
      if (f.enumValues?.length) tags.push(`枚举: ${f.enumValues.join('/')}`)
      return `  - ${f.name} (${tags.join(', ')})${f.description ? `：${f.description}` : ''}`
    })
    .join('\n')
  return `${header}\n字段：\n${fields}`
}
