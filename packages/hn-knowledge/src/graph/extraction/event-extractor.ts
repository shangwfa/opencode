import { generateObject } from 'ai'
import { getDefaultChatModel } from '../../config/env.js'
import { z } from 'zod'
import { resolveModel } from '../../utils/model-resolver.js'

export const EventEntitySchema = z.object({
  name: z.string().describe('事件名称'),
  type: z.literal('event').describe('实体类型，固定为 event'),
  description: z.string().optional().describe('事件描述'),
  occurredAt: z.string().optional().describe('事件发生时间（ISO 8601 或原文时间表述）'),
  location: z.string().optional().describe('事件发生地点'),
})

export const TemporalRelationSchema = z.object({
  source: z.string().describe('源实体名称（事件或普通实体）'),
  relation: z.enum([
    '发生在', '之前', '之后', '期间', '导致', '触发', '参与', '发生于', '持续至',
  ]).describe('时间关系类型'),
  target: z.string().describe('目标实体名称'),
  confidence: z.number().min(0).max(1).describe('置信度'),
  timeHint: z.string().optional().describe('时间线索（原文中的时间表述）'),
})

export const EventGraphSchema = z.object({
  events: z.array(EventEntitySchema).describe('提取的事件实体'),
  temporalRelations: z.array(TemporalRelationSchema).describe('事件/实体间的时间关系'),
})

export type EventGraphExtraction = z.infer<typeof EventGraphSchema>

const eventGraphPrompt = `你是事件知识图谱提取专家。从以下文本中提取事件和时间关系。

提取要求：
1. 事件：发生了什么（发布、更新、故障、迁移、会议等），尽量包含时间和地点
2. 时间关系：事件之间、事件与实体之间的先后/因果/包含关系

文本：
{text}

只提取文本中有明确依据的事件和关系，时间信息优先使用原文表述。不要编造。`

/**
 * 事件图提取器（对标 cognee extract_event_graph.py，temporal_graph_prompt）
 *
 * 与普通实体提取的区别：
 * - 产出 type='event' 的节点
 * - 关系带有时间语义（之前/之后/导致/触发等）
 * - 是 TemporalRetriever 时间感知检索的前置
 */
export class EventGraphExtractor {
  private model: any
  private maxRetries: number

  constructor(options?: { model?: string; maxRetries?: number }) {
    const modelName = options?.model || getDefaultChatModel()
    this.model = resolveModel(modelName)
    this.maxRetries = options?.maxRetries ?? 2
  }

  async extract(text: string): Promise<EventGraphExtraction> {
    if (!text || !text.trim()) {
      return { events: [], temporalRelations: [] }
    }

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await generateObject({
          model: this.model,
          schema: EventGraphSchema,
          prompt: eventGraphPrompt.replace('{text}', text),
          temperature: 0.1,
        })
        return result.object
      } catch (error: any) {
        if (attempt === this.maxRetries) {
          console.warn(`[事件图提取] 所有重试失败: ${error.message}`)
          return { events: [], temporalRelations: [] }
        }
      }
    }
    return { events: [], temporalRelations: [] }
  }
}