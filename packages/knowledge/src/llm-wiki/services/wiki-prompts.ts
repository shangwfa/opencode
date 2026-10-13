import { z } from 'zod'

// 单个提取概念的 Schema
export const ExtractedConceptSchema = z.object({
  concept: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
  definition: z.string().optional(),
  is_new: z.boolean(),
  tags: z.array(z.string()).optional().default([]),
  aliases: z.array(z.string()).optional().default([]),
  related_concepts: z.array(z.union([
    z.string(),
    z.object({
      name: z.string(),
      type: z.enum(['prerequisite', 'parent-child', 'related']).optional().default('related'),
    }),
  ])).optional().default([]),
})

export type ExtractedConcept = z.infer<typeof ExtractedConceptSchema>

// 概念提取结果 Schema（LLM 返回的完整 JSON）
export const ExtractionResultSchema = z.object({
  concepts: z.array(ExtractedConceptSchema).max(20)  // 最多 20 个概念
})

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>

// Wiki 页面章节 Schema
export const WikiSectionSchema = z.object({
  heading: z.string(),
  content: z.string(),
  sourceRefs: z.array(z.string()).optional().default([])  // 来源文档引用
})

// Wiki 页面内容 Schema（LLM 生成的页面结构）
export const WikiPageContentSchema = z.object({
  sections: z.array(WikiSectionSchema).min(1),
  relatedConcepts: z.array(z.string()).optional().default([])  // [[wikilink]] 格式的相关概念
})

export type WikiPageContent = z.infer<typeof WikiPageContentSchema>

/**
 * 构建概念提取的 System Prompt
 * 参考 llm-wiki-compiler 的 buildExtractionPrompt
 */
export function buildExtractionPrompt(
  sourceContent: string,
  existingConcepts: string[] = [],
  docName?: string
): string {
  const existingSection = existingConcepts.length > 0
    ? `\n\n已有概念（避免重复提取，如语义相同请合并）：\n${existingConcepts.join('、')}`
    : '\n\n当前 Wiki 中还没有概念。'

  return [
    '你是一个知识提取引擎。分析以下文档，识别 3-8 个值得作为独立 Wiki 页面记录的概念。',
    '',
    '【概念粒度标准】每个概念应具有维基百科词条级别的独立性：有清晰的定义边界、用户可能单独搜索它。',
    '✅ 好的概念示例：网页自动化、选择器定位、异常处理、Excel操作、For循环',
    '❌ 不要提取：最佳实践、注意事项、常见问题、核心功能、应用场景、总结、概述（这些是泛化节点，不是独立概念）',
    '❌ 不要提取：章节标题本身（如"高级功能"、"核心操作"），除非该标题代表一个可独立定义的技术概念',
    '',
    '以 JSON 格式返回结果：',
    '{ "concepts": [{ "concept": "概念名", "summary": "一句话描述（≤50字）", "definition": "详细定义（可选）", "is_new": true, "tags": ["标签1"], "aliases": ["别名/缩写"] }]}',
    '',
    '注意：related_concepts 不需要在此阶段填写，留空数组即可，关系将在第二阶段专门推断。',
    'aliases：该概念的别名或英文缩写，如"机器学习"的别名"ML"',
    existingSection,
    docName ? `\n\n文档名称：${docName}` : '',
    '\n\n--- 文档内容 ---\n\n',
    sourceContent
  ].join('\n')
}

export type ConceptRelation = {
  source: string
  target: string
  type: 'prerequisite' | 'parent-child' | 'related'
  reason: string
}

export const ConceptRelationSchema = z.object({
  source: z.string(),
  target: z.string(),
  type: z.enum(['prerequisite', 'parent-child', 'related']),
  reason: z.string().optional().default(''),
})

export const RelationExtractionResultSchema = z.object({
  relations: z.array(ConceptRelationSchema).max(50),
})

export type RelationExtractionResult = z.infer<typeof RelationExtractionResultSchema>

export function buildRelationExtractionPrompt(
  newConceptNames: string[],
  allConceptNames: string[],
  sourceContent: string,
): string {
  const newList = newConceptNames.join('、')
  const allList = allConceptNames.join('、')

  return [
    '你是一个知识图谱构建专家。根据以下文档内容和概念列表，推断概念间的关系。',
    '',
    '【本次新提取的概念】（必须为这些概念推断关系）：',
    newList,
    '',
    '【Wiki 中的所有概念】（可以作为关系目标）：',
    allList,
    '',
    '【关系类型定义】请严格按定义判断，不要随意使用 related：',
    '- prerequisite：学习/使用 source 概念，必须先理解 target 概念。例："For循环" prerequisite "流程控制"',
    '- parent-child：source 是 target 的一个具体子概念/实例。例："选择器定位" parent-child "网页自动化"',
    '- related：二者在同一场景下经常配合使用，但无明确依赖或归属。仅在前两种不适用时才使用。',
    '',
    '【要求】：',
    '1. 只为新概念建立关系，target 可以是任意 Wiki 概念',
    '2. 每对概念最多建立 1 条关系，选择最准确的类型',
    '3. 没有明确关系时不要强行建立，宁缺毋滥',
    '4. 每条关系附上简短 reason 说明判断依据',
    '',
    '以 JSON 格式返回：',
    '{ "relations": [{ "source": "概念A", "target": "概念B", "type": "prerequisite", "reason": "判断依据" }] }',
    '',
    '--- 文档内容（用于理解语义上下文）---',
    '',
    sourceContent.slice(0, 8000),
  ].join('\n')
}

export function parseAndValidateRelations(rawOutput: string): ConceptRelation[] {
  try {
    const parsed = extractJsonObject(rawOutput)
    if (!parsed) return []
    const result = RelationExtractionResultSchema.safeParse(parsed)
    if (!result.success) {
      console.warn('[WikiPrompts] 关系提取结果校验失败:', result.error.message)
      return []
    }
    return result.data.relations
  } catch (error) {
    console.warn('[WikiPrompts] 关系提取结果解析失败:', error)
    return []
  }
}

/**
 * 构建 Wiki 页面生成的 System Prompt
 * 参考 llm-wiki-compiler 的 buildPagePrompt
 */
export function buildPagePrompt(
  conceptName: string,
  sourceContent: string,
  existingPage?: string,
  relatedConcepts?: string[]
): string {
  const existingSection = existingPage
    ? `\n\n现有页面内容（请在此基础上更新）：\n\n${existingPage}`
    : ''

  const relatedSection = relatedConcepts && relatedConcepts.length > 0
    ? `\n\n相关概念（可用 [[概念名]] 格式引用）：${relatedConcepts.join('、')}`
    : ''

  return [
    `你是一个 Wiki 作者。为"${conceptName}"编写一个清晰、结构良好的 Markdown 页面。`,
    '只使用提供的源材料中的事实。',
    '在适当的地方使用 [[概念名]] 格式引用相关概念。',
    '以中立、信息性的语气写作，简洁但全面。',
    '以 JSON 格式返回结果：',
    '{ "sections": [{ "heading": "章节标题", "content": "章节内容", "sourceRefs": ["来源文档名"] }], "relatedConcepts": ["[[相关概念]]"] }',
    existingSection,
    relatedSection,
    '\n\n--- 源材料 ---\n\n',
    sourceContent
  ].join('\n')
}

/**
 * 解析并校验概念提取结果
 * 失败时返回空数组，不抛出异常
 */
export function parseAndValidateExtraction(rawOutput: string): ExtractedConcept[] {
  try {
    const parsed = extractJsonObject(rawOutput)
    if (!parsed) return []

    const result = ExtractionResultSchema.safeParse(parsed)

    if (!result.success) {
      console.warn('[WikiPrompts] 概念提取结果校验失败:', result.error.message)
      return []
    }

    return result.data.concepts
  } catch (error) {
    console.warn('[WikiPrompts] 概念提取结果解析失败:', error)
    return []
  }
}

/**
 * 解析并校验 Wiki 页面内容
 * 失败时返回 null，不抛出异常
 */
export function parseAndValidatePageContent(rawOutput: string): WikiPageContent | null {
  try {
    const parsed = extractJsonObject(rawOutput)
    if (!parsed) return null

    const result = WikiPageContentSchema.safeParse(parsed)

    if (!result.success) {
      console.warn('[WikiPrompts] 页面内容校验失败:', result.error.message)
      return null
    }

    return result.data
  } catch (error) {
    console.warn('[WikiPrompts] 页面内容解析失败:', error)
    return null
  }
}

/**
 * 将概念名转换为 URL 友好的 slug
 */
export function conceptToSlug(conceptName: string): string {
  if (conceptName === '_index') return '_index'

  return conceptName
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '-')
    .replace(/[<>:"\/\\|?*#%&{}^~[\]`]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'concept'
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  if (start === -1) return null

  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') depth--
    if (depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

const LINT_BLOCK_REGEX =
  /---LINT:\s*([^\n|]+?)\s*\|\s*([^\n|]+?)\s*\|\s*([^\n-]+?)\s*---\n([\s\S]*?)---END LINT---/g

export function buildLintPrompt(conceptSummaries: string): string {
  return [
    '你是一个 Wiki 质量分析师。审查以下 Wiki 页面摘要，识别问题。',
    '',
    '对于每个问题，严格使用以下格式输出：',
    '',
    '---LINT: type | severity | Short title---',
    '问题描述。',
    'PAGES: page1, page2',
    '---END LINT---',
    '',
    'Types:',
    '- contradiction: 两个或多个页面有冲突断言',
    '- stale: 信息看起来过时或已被取代',
    '- missing-page: 一个重要概念被大量引用但没有专属页面',
    '- suggestion: 值得添加到 Wiki 的问题或来源',
    '',
    'Severities:',
    '- warning: 应该处理',
    '- info: 建议改进',
    '',
    '只报告真正的问题。不要编造问题。只输出 ---LINT--- 块，不要其他文字。',
    '',
    '## Wiki 页面摘要',
    '',
    conceptSummaries,
  ].join('\n')
}

export function parseLintResults(rawOutput: string): Array<{
  type: string
  severity: string
  title: string
  detail: string
  affectedPages?: string[]
}> {
  const results: Array<{
    type: string
    severity: string
    title: string
    detail: string
    affectedPages?: string[]
  }> = []

  const matches = rawOutput.matchAll(LINT_BLOCK_REGEX)
  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const severity = match[2].trim().toLowerCase()
    const title = match[3].trim()
    const body = match[4].trim()

    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(',').map((p) => p.trim())
      : undefined

    const detail = body.replace(/^PAGES:.*$/m, '').trim()

    results.push({
      type: rawType,
      severity: severity === 'warning' ? 'warning' : 'info',
      title,
      detail: `[${rawType}] ${detail}`,
      affectedPages,
    })
  }

  return results
}

export function buildIndexPagePrompt(
  conceptSummaries: Array<{ conceptName: string; summary: string; tags: string[] }>,
  relationshipCount: number,
  conceptCount: number
): string {
  const summaries = conceptSummaries
    .map(c => `- **${c.conceptName}**: ${c.summary} [tags: ${c.tags.join(', ')}]`)
    .join('\n')

  return [
    `你是一个 Wiki 索引生成器。根据以下概念摘要和统计信息，生成 Wiki 索引页面。`,
    `Wiki 共有 ${conceptCount} 个概念和 ${relationshipCount} 个关系。`,
    '',
    '索引页面应包含：',
    '1. 概览段落：Wiki 的主题和范围总结',
    '2. 分类概念列表：按 tags 分组列出所有概念（使用 [[概念名]] 格式）',
    '3. 核心关系图摘要：列出最重要的关联',
    '',
    '以 JSON 格式返回：',
    '{ "sections": [{ "heading": "章节标题", "content": "章节内容（使用 [[概念名]] 引用）", "sourceRefs": [] }], "relatedConcepts": [] }',
    '',
    '--- 概念摘要 ---',
    summaries,
  ].join('\n')
}
