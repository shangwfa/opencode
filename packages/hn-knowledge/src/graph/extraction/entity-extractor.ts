import { generateObject } from 'ai'
import { getDefaultChatModel } from '../../config/env.js'
import { resolveModel } from '../../utils/model-resolver.js'
import { EntityListSchema, TripletListSchema, CombinedExtractionSchema, type CombinedExtraction } from './schemas.js'
import { entityExtractionPrompt, combinedExtractionPrompt } from './prompts.js'
import { injectOntology } from '../ontology/index.js'
import { normalizeExtraction } from './normalizer.js'

export interface ExtractionOptions {
  model?: string
  useCascade?: boolean
  maxRetries?: number
  /** 本体约束文本（由 OntologyValidator.toPromptText() 生成），注入提示以约束提取范围 */
  ontologyText?: string
  /** 由文档摄取层控制的 chunk 超时信号 */
  signal?: AbortSignal
}

export class EntityExtractor {
  private defaultModel: string
  private maxRetries: number

  constructor(options?: ExtractionOptions) {
    this.defaultModel = options?.model || getDefaultChatModel()
    this.maxRetries = options?.maxRetries ?? 2
  }

  async extract(text: string, options?: ExtractionOptions): Promise<CombinedExtraction> {
    try {
      const opts = { ...options }
      const useCascade = opts.useCascade ?? false
      if (useCascade) {
        return normalizeExtraction(await this.cascadeExtract(text, opts))
      }
      return normalizeExtraction(await this.combinedExtract(text, opts))
    } catch (error: any) {
      // 模型解析失败等致命错误：降级为空结果，不中断调用方主流程
      console.warn(`[实体提取] 致命错误（降级为空结果）: ${error.message}`)
      return { entities: [], triplets: [] }
    }
  }

  private async combinedExtract(text: string, options?: ExtractionOptions): Promise<CombinedExtraction> {
    const modelName = options?.model || this.defaultModel
    const model = resolveModel(modelName)

    const prompt = injectOntology(combinedExtractionPrompt.replace('{text}', text), options?.ontologyText)

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        let object: CombinedExtraction
        // 渠道分流：deepseek 系只支持官方 json_object（不认 json_schema 协议），
        // 直接走文本指令 + JSON 剥壳路径，避免每次必败的 structured 调用
        const textOnlyChannel = modelName.startsWith('deepseek/')
        if (textOnlyChannel) {
          object = await this.extractViaText(model, prompt, options?.signal)
        } else {
          try {
            const result = await generateObject({
              model,
              schema: CombinedExtractionSchema,
              prompt,
              temperature: 0,
              abortSignal: options?.signal,
            })
            object = result.object
          } catch (structuredErr: any) {
            // 其他渠道 structured 失败时同样降级（运行时探测）
            console.warn(`[实体提取] structured output 不可用（${structuredErr.message.slice(0, 80)}），降级文本解析`)
            object = await this.extractViaText(model, prompt, options?.signal)
          }
        }

        // 空抽取视为低质量结果，触发重试（对标质量门禁）
        if (object.entities.length === 0 && attempt < this.maxRetries) {
          console.warn(`[实体提取] 第 ${attempt + 1} 次抽取为空，重试`)
          continue
        }
        return object
      } catch (error: any) {
        if (attempt === this.maxRetries) {
          console.warn(`[实体提取] 所有重试失败: ${error.message}`)
          return { entities: [], triplets: [] }
        }
        console.warn(`[实体提取] 第 ${attempt + 1} 次失败，重试: ${error.message}`)
      }
    }

    return { entities: [], triplets: [] }
  }

  /**
   * 文本指令式抽取（structured output 不可用时的渠道兼容路径）：
   * generateText + JSON 剥壳（容忍 ```json 围栏与前后缀文本）
   */
  private async extractViaText(model: any, prompt: string, signal?: AbortSignal): Promise<CombinedExtraction> {
    const { generateText } = await import('ai')
    const result = await generateText({
      model,
      prompt: `${prompt}\n\n输出要求：只输出一个 JSON 对象，结构为 {"entities": [{"name","type","description","attributes":[{"name","value","datatype"}]}], "triplets": [{"source","relation","target","confidence"}]}，不要输出任何解释或代码块标记。`,
      temperature: 0,
      maxOutputTokens: 2048,
      abortSignal: signal,
    })
    const json = extractJsonBlock(result.text)
    if (!json) throw new Error('响应中未找到 JSON')
    const parsed = JSON.parse(json)
    return normalizeExtraction(parsed as CombinedExtraction)
  }

  private async cascadeExtract(text: string, options?: ExtractionOptions): Promise<CombinedExtraction> {
    const modelName = options?.model || this.defaultModel
    const model = resolveModel(modelName)

    const entities = await this.extractEntities(text, model, options?.ontologyText, options?.signal)
    if (entities.length === 0) {
      return { entities: [], triplets: [] }
    }

    const entityNames = entities.map((e) => e.name)
    const triplets = await this.extractTriplets(text, entityNames, model, options?.ontologyText, options?.signal)

    return { entities, triplets }
  }

  private async extractEntities(text: string, model: any, ontologyText?: string, signal?: AbortSignal): Promise<CombinedExtraction['entities']> {
    const prompt = injectOntology(entityExtractionPrompt.replace('{text}', text), ontologyText)

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await generateObject({
          model,
          schema: EntityListSchema,
          prompt,
          temperature: 0,
          abortSignal: signal,
        })
        return result.object.entities
      } catch (error: any) {
        if (attempt === this.maxRetries) {
          console.warn(`[实体提取] 实体提取失败: ${error.message}`)
          return []
        }
      }
    }
    return []
  }

  private async extractTriplets(
    text: string,
    entityNames: string[],
    model: any,
    ontologyText?: string,
    signal?: AbortSignal
  ): Promise<CombinedExtraction['triplets']> {
    const prompt = injectOntology(`基于以下文本和实体列表，提取实体之间的三元组关系。

文本：
${text}

实体列表：
${entityNames.join(', ')}

请提取所有有明确文本依据的三元组关系。关系名称优先使用：包含、支持平台、不支持、依赖、属于、基于、集成、用于、竞争对手、对比对象、版本为。
只提取文本中有明确依据的关系，不要编造。`, ontologyText)

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await generateObject({
          model,
          schema: TripletListSchema,
          prompt,
          temperature: 0,
          abortSignal: signal,
        })
        return result.object.triplets
      } catch (error: any) {
        if (attempt === this.maxRetries) {
          console.warn(`[三元组提取] 提取失败: ${error.message}`)
          return []
        }
      }
    }
    return []
  }
}

/** 从 LLM 文本响应中剥出 JSON 块（容忍 ```json 围栏与前后缀文本） */
function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return candidate.slice(start, end + 1)
}
