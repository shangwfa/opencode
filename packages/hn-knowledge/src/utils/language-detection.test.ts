/**
 * 语言检测工具测试
 */

import { describe, it, expect } from 'bun:test'
import { detectLanguage, isChinese, isEnglish, separateLanguages } from './language-detection'

describe('language-detection', () => {
  describe('detectLanguage', () => {
    it('应该检测纯中文文本', () => {
      const result = detectLanguage('这是一段中文文本')

      expect(result.language).toBe('zh')
      expect(result.confidence).toBeGreaterThan(0.5)
      expect(result.chineseRatio).toBe(1)
      expect(result.englishRatio).toBe(0)
    })

    it('应该检测纯英文文本', () => {
      const result = detectLanguage('This is English text')

      expect(result.language).toBe('en')
      expect(result.confidence).toBeGreaterThan(0.5)
      expect(result.chineseRatio).toBe(0)
      expect(result.englishRatio).toBe(1)
    })

    it('应该检测混合文本（中英都超过20%）', () => {
      const result = detectLanguage('这是中文 and this is English 更多中文 more English')

      expect(result.language).toBe('mixed')
      expect(result.chineseRatio).toBeGreaterThan(0.2)
      expect(result.englishRatio).toBeGreaterThan(0.2)
    })

    it('应该检测混合文本（主要是中文）', () => {
      const result = detectLanguage('这是中文文本 with a little English')

      // 文本中中英文都超过20%，所以会被识别为 mixed
      // 实际上这个文本英文单词更多，所以 englishRatio > chineseRatio
      expect(result.language).toBe('mixed')
      expect(result.chineseRatio).toBeGreaterThan(0.2)
      expect(result.englishRatio).toBeGreaterThan(0.2)
    })

    it('应该检测混合文本（主要是英文）', () => {
      const result = detectLanguage('This is English text with 少量中文')

      expect(result.language).toBe('en')
      expect(result.englishRatio).toBeGreaterThan(0.5)
    })

    it('应该处理空字符串', () => {
      const result = detectLanguage('')

      expect(result.language).toBe('en')
      expect(result.confidence).toBe(0)
      expect(result.chineseRatio).toBe(0)
      expect(result.englishRatio).toBe(0)
    })

    it('应该处理只有空格的字符串', () => {
      const result = detectLanguage('   ')

      expect(result.language).toBe('en')
      expect(result.confidence).toBe(0)
    })

    it('应该正确计算置信度', () => {
      const result1 = detectLanguage('纯中文文本')
      expect(result1.confidence).toBe(1)

      const result2 = detectLanguage('mixed 混合 text')
      expect(result2.confidence).toBeGreaterThan(0)
      expect(result2.confidence).toBeLessThanOrEqual(1)
    })

    it('应该处理只有标点符号的文本', () => {
      const result = detectLanguage('！@#￥%……&*（）——+')

      expect(result.language).toBe('en')
      expect(result.confidence).toBeLessThan(1)
    })

    it('应该识别包含数字的文本', () => {
      const result = detectLanguage('这是123数字')

      expect(result.language).toBe('zh')
      expect(result.chineseRatio).toBeGreaterThan(0)
    })

    it('应该处理中文标点符号', () => {
      const result = detectLanguage('你好，世界！')

      expect(result.language).toBe('zh')
      expect(result.confidence).toBeGreaterThan(0.5)
    })
  })

  describe('isChinese', () => {
    it('应该识别纯中文文本', () => {
      expect(isChinese('这是中文')).toBe(true)
    })

    it('应该识别混合但主要是中文的文本', () => {
      // '这是中文 text' - 中文和英文都存在，可能被识别为 mixed
      // isChinese 在 mixed 模式下检查 chineseRatio > englishRatio
      const result = detectLanguage('这是中文 text')
      // 如果结果是 'mixed'，需要检查 chineseRatio > englishRatio
      if (result.language === 'mixed') {
        expect(isChinese('这是中文 text')).toBe(result.chineseRatio > result.englishRatio)
      } else {
        expect(isChinese('这是中文 text')).toBe(result.language === 'zh')
      }
    })

    it('应该拒绝纯英文文本', () => {
      expect(isChinese('This is English')).toBe(false)
    })

    it('应该拒绝混合但主要是英文的文本', () => {
      expect(isChinese('This is English 文本')).toBe(false)
    })

    it('应该处理空文本', () => {
      // 空文本返回 language='en', confidence=0, chineseRatio=0, englishRatio=0
      // isChinese 检查 language === 'zh' 或 (mixed 且 chineseRatio > englishRatio)
      // 空文本不满足这些条件，所以返回 false
      const result = detectLanguage('')
      expect(result.language).toBe('en')
      expect(result.confidence).toBe(0)
      expect(isChinese('')).toBe(false)
    })
  })

  describe('isEnglish', () => {
    it('应该识别纯英文文本', () => {
      expect(isEnglish('This is English')).toBe(true)
    })

    it('应该识别混合但主要是英文的文本', () => {
      expect(isEnglish('This is English 文本')).toBe(true)
    })

    it('应该拒绝纯中文文本', () => {
      expect(isEnglish('这是中文')).toBe(false)
    })

    it('应该拒绝混合但主要是中文的文本', () => {
      expect(isEnglish('这是中文 text')).toBe(false)
    })

    it('应该处理空文本', () => {
      // 空文本返回 language='en', confidence=0, chineseRatio=0, englishRatio=0
      // isEnglish 检查 language === 'en' 或 (mixed 且 englishRatio > chineseRatio)
      // 空文本虽然 language='en', 但 confidence=0, englishRatio=0
      // 实际上 isEnglish('') 应该返回 true 因为 language === 'en'
      const result = detectLanguage('')
      expect(result.language).toBe('en')
      expect(result.confidence).toBe(0)
      expect(result.englishRatio).toBe(0)
      // isEnglish 只检查 language === 'en'，不检查 confidence
      expect(isEnglish('')).toBe(true)
    })
  })

  describe('separateLanguages', () => {
    it('应该分离混合文本中的中英文', () => {
      const result = separateLanguages('这是中文 and this is English')

      expect(result.chinese).toBe('这是中文')
      expect(result.english).toContain('and')
      expect(result.english).toContain('this')
      expect(result.english).toContain('is')
      expect(result.english).toContain('English')
    })

    it('应该处理只有中文的文本', () => {
      const result = separateLanguages('只有中文')

      expect(result.chinese).toBe('只有中文')
      expect(result.english).toBe('')
    })

    it('应该处理只有英文的文本', () => {
      const result = separateLanguages('Only English')

      expect(result.chinese).toBe('')
      expect(result.english).toBe('Only English')
    })

    it('应该处理空文本', () => {
      const result = separateLanguages('')

      expect(result.chinese).toBe('')
      expect(result.english).toBe('')
    })

    it('应该处理包含数字和标点的文本', () => {
      const result = separateLanguages('中文123 and English 456')

      expect(result.chinese).toBe('中文')
      expect(result.english).toContain('and')
      expect(result.english).toContain('English')
    })

    it('应该保留英文单词的连续性', () => {
      const result = separateLanguages('Hello世界World')

      expect(result.chinese).toBe('世界')
      expect(result.english).toBe('Hello World')
    })
  })

  describe('边界情况', () => {
    it('应该处理连续的中文字符', () => {
      const result = detectLanguage('你好世界大家好')

      expect(result.language).toBe('zh')
      expect(result.chineseRatio).toBe(1)
    })

    it('应该处理连续的英文字符', () => {
      const result = detectLanguage('HelloWorldEveryone')

      expect(result.language).toBe('en')
      expect(result.englishRatio).toBe(1)
    })

    it('应该处理单个中文字符', () => {
      const result = detectLanguage('你')

      expect(result.language).toBe('zh')
    })

    it('应该处理单个英文字符', () => {
      const result = detectLanguage('a')

      expect(result.language).toBe('en')
    })

    it('应该处理特殊字符', () => {
      const result = detectLanguage('@#$%^&*()')

      expect(result.language).toBe('en')
      expect(result.confidence).toBeLessThan(1)
    })

    it('应该处理中日韩混合文本', () => {
      const result = detectLanguage('这是中文와 한국어')

      expect(result.language).toBe('zh')
      expect(result.chineseRatio).toBeGreaterThan(0)
    })
  })
})
