import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import {
  parseAndValidateExtraction,
  parseAndValidatePageContent,
  buildExtractionPrompt,
  buildPagePrompt,
  conceptToSlug,
  ExtractedConceptSchema,
  WikiPageContentSchema,
  buildLintPrompt,
  parseLintResults,
  buildIndexPagePrompt
} from '../../services/wiki-prompts.js'

describe('wiki-prompts', () => {
  describe('parseAndValidateExtraction', () => {
    it('合法 JSON 输出应成功解析', () => {
      const validOutput = JSON.stringify({
        concepts: [
          { concept: 'RPA自动化', summary: '机器人流程自动化技术', is_new: true, tags: ['rpa', 'automation'] },
          { concept: '循环指令', summary: '用于重复执行操作的指令', is_new: false }
        ]
      })
      const result = parseAndValidateExtraction(validOutput)
      expect(result).toHaveLength(2)
      expect(result[0].concept).toBe('RPA自动化')
    })

    it('包含额外文本的 JSON 应能提取', () => {
      const outputWithText = '以下是提取的概念：\n' + JSON.stringify({ concepts: [{ concept: '测试概念', summary: '测试', is_new: true }] })
      const result = parseAndValidateExtraction(outputWithText)
      expect(result).toHaveLength(1)
    })

    it('超过 20 个概念应被截断', () => {
      const concepts = Array.from({ length: 25 }, (_, i) => ({
        concept: `概念${i}`, summary: `摘要${i}`, is_new: true
      }))
      const output = JSON.stringify({ concepts })
      const result = parseAndValidateExtraction(output)
      expect(result.length).toBeLessThanOrEqual(20)
    })

    it('畸形 JSON 应返回空数组', () => {
      expect(parseAndValidateExtraction('not json')).toEqual([])
      expect(parseAndValidateExtraction('')).toEqual([])
      expect(parseAndValidateExtraction('{}')).toEqual([])
    })

    it('缺少必填字段应返回空数组', () => {
      const invalid = JSON.stringify({ concepts: [{ concept: '只有名称' }] })
      const result = parseAndValidateExtraction(invalid)
      expect(result).toEqual([])
    })
  })

  describe('parseAndValidatePageContent', () => {
    it('合法页面内容应成功解析', () => {
      const validOutput = JSON.stringify({
        sections: [{ heading: '概述', content: '这是概述内容', sourceRefs: ['doc1.md'] }],
        relatedConcepts: ['[[循环指令]]']
      })
      const result = parseAndValidatePageContent(validOutput)
      expect(result).not.toBeNull()
      expect(result!.sections).toHaveLength(1)
    })

    it('空 sections 应返回 null', () => {
      const invalid = JSON.stringify({ sections: [] })
      expect(parseAndValidatePageContent(invalid)).toBeNull()
    })

    it('畸形输出应返回 null', () => {
      expect(parseAndValidatePageContent('invalid')).toBeNull()
    })
  })

  describe('conceptToSlug', () => {
    it('英文概念名应转换为小写连字符格式', () => {
      expect(conceptToSlug('RPA Automation')).toBe('rpa-automation')
    })

    it('中文概念名应直接保留（可读 slug）', () => {
      const slug = conceptToSlug('循环指令')
      expect(slug).toBe('循环指令')
      expect(slug.length).toBeGreaterThan(0)
    })

    it('特殊字符应被移除', () => {
      expect(conceptToSlug('API & SDK')).toBe('api-sdk')
    })
  })

  describe('buildExtractionPrompt', () => {
    it('应包含文档内容', () => {
      const prompt = buildExtractionPrompt('这是文档内容', [], '测试文档')
      expect(prompt).toContain('这是文档内容')
      expect(prompt).toContain('测试文档')
    })

    it('有已有概念时应包含去重提示', () => {
      const prompt = buildExtractionPrompt('内容', ['概念A', '概念B'])
      expect(prompt).toContain('概念A')
      expect(prompt).toContain('概念B')
    })
  })

  describe('buildPagePrompt', () => {
    it('应包含概念名和源材料', () => {
      const prompt = buildPagePrompt('循环指令', '源材料内容')
      expect(prompt).toContain('循环指令')
      expect(prompt).toContain('源材料内容')
    })

    it('有现有页面时应包含更新提示', () => {
      const prompt = buildPagePrompt('概念', '内容', '现有页面内容')
      expect(prompt).toContain('现有页面内容')
    })
  })

  describe('buildLintPrompt', () => {
    it('应包含概念摘要', () => {
      const prompt = buildLintPrompt('### ML\nMachine Learning')
      expect(prompt).toContain('ML')
      expect(prompt).toContain('Machine Learning')
    })

    it('应包含 Lint 输出格式说明', () => {
      const prompt = buildLintPrompt('概念摘要')
      expect(prompt).toContain('---LINT:')
      expect(prompt).toContain('---END LINT---')
    })
  })

  describe('parseLintResults', () => {
    it('应该正确解析 LINT block 格式', () => {
      const rawOutput = `---LINT: contradiction | warning | 矛盾检测 ---
概念A和概念B描述矛盾。
PAGES: 概念A, 概念B
---END LINT---

---LINT: stale | info | 过时信息 ---
概念C信息可能过时。
PAGES: 概念C
---END LINT---`

      const results = parseLintResults(rawOutput)

      expect(results).toHaveLength(2)
      expect(results[0].type).toBe('contradiction')
      expect(results[0].severity).toBe('warning')
      expect(results[0].title).toBe('矛盾检测')
      expect(results[0].affectedPages).toEqual(['概念A', '概念B'])
      expect(results[1].type).toBe('stale')
    })

    it('空输出应返回空数组', () => {
      expect(parseLintResults('')).toEqual([])
      expect(parseLintResults('no lint blocks here')).toEqual([])
    })

    it('单条 Lint 应正确解析', () => {
      const rawOutput = `---LINT: missing_page | error | 缺失页面 ---
需要补充概念D。
PAGES: 概念D
---END LINT---`

      const results = parseLintResults(rawOutput)

      expect(results).toHaveLength(1)
      expect(results[0].type).toBe('missing_page')
      expect(results[0].severity).toBe('info')
    })

    it('无 PAGES 行的 Lint 应设置 affectedPages 为 undefined', () => {
      const rawOutput = `---LINT: suggestion | info | 改进建议 ---
可以优化描述。
---END LINT---`

      const results = parseLintResults(rawOutput)

      expect(results).toHaveLength(1)
      expect(results[0].affectedPages).toBeUndefined()
    })
  })

  describe('buildIndexPagePrompt', () => {
    it('应包含概念列表和统计信息', () => {
      const concepts = [
        { conceptName: 'ML', summary: 'Machine Learning', tags: ['AI'] },
        { conceptName: 'DL', summary: 'Deep Learning', tags: ['AI', 'DL'] }
      ]
      const prompt = buildIndexPagePrompt(concepts, 5, 10)
      expect(prompt).toContain('ML')
      expect(prompt).toContain('Deep Learning')
      expect(prompt).toContain('10')
      expect(prompt).toContain('5')
    })
  })

  describe('ExtractedConceptSchema - aliases + typed relationships', () => {
    it('应该接受带 aliases 的概念', () => {
      const result = ExtractedConceptSchema.safeParse({
        concept: '机器学习',
        summary: 'ML',
        is_new: true,
        aliases: ['ML', 'Machine Learning']
      })
      expect(result.success).toBe(true)
      expect(result.data?.aliases).toEqual(['ML', 'Machine Learning'])
    })

    it('应该接受带关系类型的相关概念', () => {
      const result = ExtractedConceptSchema.safeParse({
        concept: 'DL',
        summary: 'Deep Learning',
        is_new: true,
        related_concepts: [
          { name: 'ML', type: 'prerequisite' },
          { name: 'CNN', type: 'related' }
        ]
      })
      expect(result.success).toBe(true)
      expect(result.data?.related_concepts).toHaveLength(2)
    })

    it('应该接受字符串格式的 related_concepts（向后兼容）', () => {
      const result = ExtractedConceptSchema.safeParse({
        concept: 'Test',
        summary: 'Summary',
        is_new: true,
        related_concepts: ['ConceptA', 'ConceptB']
      })
      expect(result.success).toBe(true)
    })
  })
})
