/**
 * 用户可编辑 schema 服务（Karpathy 模式第三层）：编译规则按集合配置化。
 * 边界（防提示注入破坏证据链）：只开放结构化字段并严格校验；
 * 证据规则（quote 逐字、refId 绑定哈希）不在配置面。未配置时行为与默认完全一致。
 */
import { z } from 'zod'
import { db, pool, schemaName, wikiSchemas } from '../db/index.js'
import { and, desc, eq } from 'drizzle-orm'
import { WikiActivityLogService } from './wiki-activity-log.service.js'

export const DEFAULT_WIKI_SCHEMA = {
  maxConceptsPerDoc: 20,
  sourceCharLimit: 30000,
  outputLanguage: 'zh' as const,
  pageStyle: 'neutral' as const,
  tagWhitelist: [] as string[],
  pageStructure: { definition: true, summary: true } as { definition: boolean; summary: boolean },
  autoSemanticLint: false,
}

export const WikiSchemaConfigSchema = z.strictObject({
  maxConceptsPerDoc: z.number().int().min(1).max(50),
  sourceCharLimit: z.number().int().min(1000).max(200000),
  outputLanguage: z.enum(['zh', 'en']),
  pageStyle: z.enum(['neutral', 'concise', 'formal']),
  tagWhitelist: z.array(z.string().min(1).max(50)).max(50),
  // 页面结构选项：关闭的字段不生成、不兜底、不校验证据（模型输出也被剔除）。
  pageStructure: z.strictObject({
    definition: z.boolean().default(true),
    summary: z.boolean().default(true),
  }).default({ definition: true, summary: true }),
  // 编译完成后自动执行语义 lint（每次编译一次 LLM 调用；结果进 progress.lintResults，失败记 warning 不阻断）。
  autoSemanticLint: z.boolean().default(false),
})

export type WikiSchemaConfig = z.infer<typeof WikiSchemaConfigSchema>

export class WikiSchemaService {
  constructor(private activityLog: WikiActivityLogService) {}

  /** 读取生效配置：无记录返回默认（version 0 表示未配置）。 */
  async load(collectionId: string): Promise<{ config: WikiSchemaConfig; version: number }> {
    const rows = await db.select().from(wikiSchemas)
      .where(eq(wikiSchemas.collectionId, collectionId))
      .orderBy(desc(wikiSchemas.version)).limit(1)
    if (!rows.length) return { config: { ...DEFAULT_WIKI_SCHEMA }, version: 0 }
    // 旧版本记录缺新字段：与默认合并，保证运行时结构完整。
    const stored = rows[0].config as Partial<WikiSchemaConfig>
    const config: WikiSchemaConfig = {
      ...DEFAULT_WIKI_SCHEMA,
      ...stored,
      pageStructure: { ...DEFAULT_WIKI_SCHEMA.pageStructure, ...(stored.pageStructure ?? {}) },
    }
    return { config, version: rows[0].version }
  }

  /** 校验并保存新版本（追加式）；非法字段/取值拒绝。返回新版本号。 */
  async save(collectionId: string, input: unknown): Promise<{ config: WikiSchemaConfig; version: number }> {
    const parsed = WikiSchemaConfigSchema.safeParse(input)
    if (!parsed.success) {
      throw new Error(`Invalid schema config: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`)
    }
    const current = await this.load(collectionId)
    const version = current.version + 1
    await db.insert(wikiSchemas).values({
      id: `wiki_schema_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      collectionId, version, config: parsed.data, createdAt: new Date(),
    })
    await this.activityLog.append(collectionId, 'schema_updated', { version, config: parsed.data })
    return { config: parsed.data, version }
  }
}
