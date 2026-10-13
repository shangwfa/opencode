/**
 * 语言检测工具
 * 用于识别查询文本的语言类型（中文、英文、混合）
 */

export type LanguageType = 'zh' | 'en' | 'mixed'

export interface LanguageDetectionResult {
  language: LanguageType
  confidence: number
  chineseRatio: number
  englishRatio: number
}

/**
 * 检测文本的语言类型
 * @param text 待检测的文本
 * @returns 语言检测结果
 */
export function detectLanguage(text: string): LanguageDetectionResult {
  if (!text || text.trim().length === 0) {
    return {
      language: 'en',
      confidence: 0,
      chineseRatio: 0,
      englishRatio: 0
    }
  }

  // 中文字符范围：\u4e00-\u9fff（CJK统一汉字）
  const chineseRegex = /[\u4e00-\u9fff]/g
  // 英文字符：a-z, A-Z
  const englishRegex = /[a-zA-Z]/g
  // 所有字符（排除空格和标点）
  const allCharsRegex = /[^\s\p{P}]/gu

  const chineseMatches = text.match(chineseRegex) || []
  const englishMatches = text.match(englishRegex) || []
  const allChars = text.match(allCharsRegex) || []

  const chineseCount = chineseMatches.length
  const englishCount = englishMatches.length
  const totalChars = allChars.length

  const chineseRatio = totalChars > 0 ? chineseCount / totalChars : 0
  const englishRatio = totalChars > 0 ? englishCount / totalChars : 0

  // 判断语言类型
  let language: LanguageType
  let confidence: number

  // 如果同时有中英文字符，且比例都超过 20%，认为是混合语言
  if (chineseCount > 0 && englishCount > 0 && chineseRatio > 0.2 && englishRatio > 0.2) {
    // 混合语言
    language = 'mixed'
    confidence = Math.min(chineseRatio, englishRatio) * 2
  } else if (chineseRatio > 0.5) {
    // 主要是中文
    language = 'zh'
    confidence = chineseRatio
  } else if (englishRatio > 0.5) {
    // 主要是英文
    language = 'en'
    confidence = englishRatio
  } else if (chineseCount > 0 && englishCount > 0) {
    // 有中英文字符但比例都不高，可能是混合
    language = 'mixed'
    confidence = chineseRatio + englishRatio
  } else if (chineseCount > 0) {
    // 只有中文
    language = 'zh'
    confidence = chineseRatio
  } else {
    // 默认英文
    language = 'en'
    confidence = englishRatio || 0.5
  }

  return {
    language,
    confidence: Math.min(confidence, 1),
    chineseRatio,
    englishRatio
  }
}

/**
 * 判断文本是否主要是中文
 */
export function isChinese(text: string): boolean {
  const result = detectLanguage(text)
  return result.language === 'zh' || (result.language === 'mixed' && result.chineseRatio > result.englishRatio)
}

/**
 * 判断文本是否主要是英文
 */
export function isEnglish(text: string): boolean {
  const result = detectLanguage(text)
  return result.language === 'en' || (result.language === 'mixed' && result.englishRatio > result.chineseRatio)
}

/**
 * 分离中英文文本
 */
export function separateLanguages(text: string): { chinese: string; english: string } {
  const chineseRegex = /[\u4e00-\u9fff]+/g
  const englishRegex = /[a-zA-Z]+/g

  const chineseParts = text.match(chineseRegex) || []
  const englishParts = text.match(englishRegex) || []

  return {
    chinese: chineseParts.join(' '),
    english: englishParts.join(' ')
  }
}

