import { generateObject } from 'ai'
import { getDefaultChatModel } from '../../config/env.js'
import { z } from 'zod'
import { resolveModel } from '../../utils/model-resolver.js'
import type { RowSchema, RowFilter, RowFilterOp } from './schema.js'
import { getRowSchemaText } from './schema.js'
import type { PgRowStore, RowRecord } from './pg-row-store.js'

export interface NlRowQueryOptions {
  /** llm 模型名 */
  model?: string
  /** 语义检索嵌入函数：Phase2 产出 semanticQuery 时使用 */
  embedFn?: (texts: string[]) => Promise<number[][]>
  /** 结果条数上限，默认 10 */
  limit?: number
}

export interface NlRowQueryResult {
  /** 选中的 schema */
  schema: RowSchema
  /** 结构化过滤条件（LLM 生成，字段白名单已校验） */
  filters: RowFilter[]
  /** 语义检索子查询（可空） */
  semanticQuery: string | null
  /** 命中记录 */
  records: RowRecord[]
  /** LLM 置信度（0-1） */
  confidence: number
}

const SchemaSelectionSchema = z.object({
  schemas: z.array(z.string().min(1)).min(1),
})

const QueryPlanSchema = z.object({
  filters: z
    .array(
      z.object({
        field: z.string().min(1),
        op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']),
        value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number(), z.boolean()]))]),
      })
    )
    .max(5),
  semanticQuery: z.string().nullable(),
  confidence: z.number().min(0).max(1),
})

/**
 * 自然语言行查询（对标 TrustGraph nlp-query 的两阶段编排，NL2Filter 而非 NL2SQL）
 *
 * Phase 1（schema-selection）：把所有 schema 概览给 LLM，选出相关的 schema
 *   —— 控制上下文规模，与 TrustGraph "只带选中 schema 详情"的思路一致
 * Phase 2（query planning）：只带选中 schema 的字段详情，让 LLM 产出
 *   { 结构化过滤条件, 语义子查询, 置信度 }
 *
 * 安全语义对齐 TrustGraph 动态 GraphQL 的"schema 约束查询面"：
 * 不生成 SQL/GraphQL 文本，而是结构化过滤条件 JSON（zod 校验），
 * 字段在执行时再过一遍白名单（PgRowStore.buildFilterClause），无注入面。
 */
export class NaturalLanguageRowQuery {
  private store: PgRowStore
  private options: NlRowQueryOptions

  constructor(store: PgRowStore, options?: NlRowQueryOptions) {
    this.store = store
    this.options = options || {}
  }

  async query(question: string): Promise<NlRowQueryResult> {
    const schemas = this.store.listSchemas()
    if (schemas.length === 0) {
      throw new Error('行存储中未注册任何 schema')
    }

    // === Phase 1: schema-selection ===
    const selected = await this.selectSchemas(question, schemas)

    // === Phase 2: query planning（只带选中 schema 详情） ===
    const plan = await this.planQuery(question, selected)

    // === 执行 ===
    const schema = selected[0]
    let records: RowRecord[] = await this.store.queryRows(schema, plan.filters, {
      limit: this.options.limit ?? 10,
    })

    // 语义通道：结构化结果不足且 LLM 给出语义子查询时叠加
    if (plan.semanticQuery && this.options.embedFn && records.length < (this.options.limit ?? 10)) {
      try {
        const [vector] = await this.options.embedFn([plan.semanticQuery])
        if (vector) {
          const semantic = await this.store.searchSemantic(
            schema,
            vector,
            plan.filters.length > 0 ? plan.filters : undefined,
            this.options.limit ?? 10
          )
          const seen = new Set(records.map((r) => r.id))
          for (const hit of semantic) {
            if (!seen.has(hit.record.id)) records.push(hit.record)
          }
        }
      } catch (err: any) {
        console.warn(`[NL行查询] 语义通道失败（仅返回结构化结果）: ${err.message}`)
      }
    }

    return {
      schema,
      filters: plan.filters,
      semanticQuery: plan.semanticQuery,
      records,
      confidence: plan.confidence,
    }
  }

  private async selectSchemas(question: string, schemas: RowSchema[]): Promise<RowSchema[]> {
    if (schemas.length === 1) return schemas

    const overview = schemas.map((s) => getRowSchemaText(s)).join('\n')
    const model = resolveModel(this.options.model || getDefaultChatModel())

    try {
      const { object } = await generateObject({
        model,
        schema: SchemaSelectionSchema,
        prompt: `给定用户问题和可用数据表概览，选出回答该问题最相关的数据表（1-2 个）。

用户问题：${question}

可用数据表：
${overview}

只输出相关 schema 的 name 列表。`,
        temperature: 0,
      })
      const byName = new Map(schemas.map((s) => [s.name, s]))
      const picked = object.schemas.map((n) => byName.get(n)).filter((s): s is RowSchema => Boolean(s))
      if (picked.length > 0) return picked
    } catch (err: any) {
      console.warn(`[NL行查询] schema 选择失败（使用全部 schema）: ${err.message}`)
    }
    return schemas
  }

  private async planQuery(
    question: string,
    schemas: RowSchema[]
  ): Promise<{ filters: RowFilter[]; semanticQuery: string | null; confidence: number }> {
    const details = schemas.map((s) => getRowSchemaText(s, true)).join('\n\n')
    const model = resolveModel(this.options.model || getDefaultChatModel())

    const { object } = await generateObject({
      model,
      schema: QueryPlanSchema,
      prompt: `给定用户问题和数据表结构，生成查询计划。

规则：
- 只使用表中标注"可过滤"的字段生成 filters，操作符限于 eq/ne/gt/gte/lt/lte/in/contains
- 模糊/语义类需求（如"关于XX的"）放进 semanticQuery，不要硬造 filters
- 无法确定条件时留空 filters，confidence 给低分

用户问题：${question}

数据表结构：
${details}`,
      temperature: 0,
    })

    return {
      filters: object.filters.map((f) => ({
        field: f.field,
        op: f.op as RowFilterOp,
        value: f.value as RowFilter['value'],
      })),
      semanticQuery: object.semanticQuery || null,
      confidence: object.confidence,
    }
  }
}
