import { z } from 'zod'

export const EntitySchema = z.object({
  name: z.string().describe('实体名称'),
  // 动态类型（对齐 cognee 的 EntityType 体系）：不再硬编码枚举，
  // 允许任意实体类型名，由 OntologyValidator 过滤约束。LLM 提示仍引导常用类型。
  type: z.string().describe('实体类型（常用：person/technology/concept/product/organization/feature/term/language/process，可用其他合理类型）'),
  description: z.string().optional().describe('简短描述'),
  attributes: z.array(z.object({
    name: z.string().describe('数据属性名称'),
    value: z.union([z.string(), z.number(), z.boolean()]).describe('数据属性值'),
    datatype: z.string().optional().describe('可选 RDF datatype URI'),
  })).optional().describe('实体的字面量属性'),
})

export const EntityListSchema = z.object({
  entities: z.array(EntitySchema).describe('提取的实体列表'),
})

export const TripletSchema = z.object({
  source: z.string().describe('源实体名称'),
  relation: z.string().describe('关系类型'),
  target: z.string().describe('目标实体名称'),
  confidence: z.number().min(0).max(1).describe('置信度'),
  effectiveDate: z.string().optional().describe('事实生效日期，无法确定时省略'),
})

export const TripletListSchema = z.object({
  triplets: z.array(TripletSchema).describe('提取的三元组列表'),
})

export const CombinedExtractionSchema = z.object({
  entities: z.array(EntitySchema).describe('提取的实体列表'),
  triplets: z.array(TripletSchema).describe('提取的三元组列表'),
})

export type ExtractedEntity = z.infer<typeof EntitySchema>
export type ExtractedTriplet = z.infer<typeof TripletSchema>
export type CombinedExtraction = z.infer<typeof CombinedExtractionSchema>
