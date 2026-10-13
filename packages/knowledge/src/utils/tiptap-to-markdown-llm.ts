/**
 * 使用大模型将 Tiptap/ProseMirror JSON 转换为 Markdown
 * 第三种转换方法：通过 LLM 进行转换，确保信息完整性
 */

import { generateText } from 'ai'
import { openaiChat } from '../providers/llm.js'

/**
 * TipTap/ProseMirror 节点类型定义
 */
interface TiptapNode {
  type: string
  attrs?: Record<string, any>
  content?: TiptapNode[]
  text?: string
  marks?: any[]
}

/**
 * LLM 转换选项
 */
export interface TiptapToMarkdownLLMOptions {
  llmModel?: string // LLM 模型名称，默认 'gpt-4o-mini'
  temperature?: number // 温度参数，默认 0.1
  maxTokens?: number // 最大 token 数，默认根据模型自动设置
  enableValidation?: boolean // 是否启用内容完整性验证，默认 true
  contentRetentionThreshold?: number // 内容保留率阈值，默认 0.9 (90%)
}

/**
 * 统计 Tiptap JSON 中的文本内容
 */
function countTextContent(node: TiptapNode): { textCount: number; charCount: number; nodeCount: number } {
  let textCount = 0
  let charCount = 0
  let nodeCount = 0

  function traverse(currentNode: TiptapNode) {
    nodeCount++

    if (currentNode.text) {
      textCount++
      charCount += currentNode.text.length
    }

    if (currentNode.content && Array.isArray(currentNode.content)) {
      currentNode.content.forEach((child) => traverse(child))
    }
  }

  traverse(node)
  return { textCount, charCount, nodeCount }
}

/**
 * 估算 JSON 的 token 数量（粗略估算：1 token ≈ 4 字符）
 */
function estimateTokenCount(jsonString: string): number {
  return Math.ceil(jsonString.length / 4)
}

/**
 * 检查文档是否需要分块处理
 */
function needsChunking(tiptapJson: TiptapNode, maxTokens: number = 100000): boolean {
  const jsonString = JSON.stringify(tiptapJson)
  const estimatedTokens = estimateTokenCount(jsonString)
  return estimatedTokens > maxTokens
}

/**
 * 智能分块：按文档结构分块，保持结构完整
 */
function chunkDocument(tiptapJson: TiptapNode, maxChunkSize: number = 80000): TiptapNode[] {
  const chunks: TiptapNode[] = []

  if (!tiptapJson.content || !Array.isArray(tiptapJson.content)) {
    return [tiptapJson]
  }

  let currentChunk: TiptapNode[] = []
  let currentSize = 0

  for (const node of tiptapJson.content) {
    const nodeString = JSON.stringify(node)
    const nodeTokens = estimateTokenCount(nodeString)

    // 如果单个节点就超过限制，需要进一步拆分（这里简化处理，直接包含）
    if (nodeTokens > maxChunkSize * 0.8) {
      // 如果当前块有内容，先保存
      if (currentChunk.length > 0) {
        chunks.push({
          type: 'doc',
          content: [...currentChunk]
        })
        currentChunk = []
        currentSize = 0
      }
      // 大节点单独成块
      chunks.push({
        type: 'doc',
        content: [node]
      })
    } else if (currentSize + nodeTokens > maxChunkSize && currentChunk.length > 0) {
      // 当前块已满，保存并开始新块
      chunks.push({
        type: 'doc',
        content: [...currentChunk]
      })
      currentChunk = [node]
      currentSize = nodeTokens
    } else {
      // 添加到当前块
      currentChunk.push(node)
      currentSize += nodeTokens
    }
  }

  // 添加最后一个块
  if (currentChunk.length > 0) {
    chunks.push({
      type: 'doc',
      content: currentChunk
    })
  }

  return chunks.length > 0 ? chunks : [tiptapJson]
}

/**
 * 构建 LLM Prompt
 */
function buildConversionPrompt(tiptapJson: TiptapNode): string {
  return `你是一个专业的文档转换工具。请将以下 Tiptap/ProseMirror JSON 格式的文档转换为 Markdown 格式。

**重要要求：**
1. **必须保留所有内容**：所有文本节点、所有属性、所有元数据都必须完整保留
2. **必须保留所有格式**：标题层级、粗体、斜体、链接、代码块、列表、图片、视频等所有格式
3. **输出纯 Markdown**：只输出转换后的 Markdown 内容，不要包含任何解释文字、注释或说明
4. **保持结构完整**：保持文档的层级结构和顺序

**Tiptap JSON 结构说明：**
- \`type: "doc"\` - 文档根节点
- \`type: "heading"\` - 标题，\`attrs.level\` 表示层级（1-6）
- \`type: "paragraph"\` - 段落
- \`type: "text"\` - 文本节点，\`text\` 字段包含文本内容
- \`marks\` - 格式标记数组，如 \`[{type: "bold"}]\` 表示粗体，\`[{type: "italic"}]\` 表示斜体，\`[{type: "link", attrs: {href: "url"}}]\` 表示链接
- \`type: "bulletList"\` 或 \`type: "orderedList"\` - 列表
- \`type: "listItem"\` - 列表项
- \`type: "codeBlock"\` - 代码块，\`attrs.language\` 表示语言
- \`type: "image"\` - 图片，\`attrs.src\` 是图片 URL，\`attrs.alt\` 是替代文本
- \`type: "video"\` - 视频，\`attrs.src\` 是视频 URL
- \`type: "blockquote"\` - 引用块
- \`type: "hardBreak"\` - 换行

**Markdown 格式要求：**
- 标题：使用 \`#\` 到 \`######\` 表示 1-6 级标题
- 粗体：使用 \`**text**\`
- 斜体：使用 \`*text*\`
- 链接：使用 \`[text](url)\`
- 代码：行内代码使用 \`code\`，代码块使用 \`\`\`language\\ncode\\n\`\`\`
- 列表：无序列表使用 \`-\`，有序列表使用 \`1.\`
- 图片：使用 \`![alt](src)\`
- 视频：使用 \`<video src="url"></video>\`
- 引用：使用 \`> text\`

**输入 JSON：**
\`\`\`json
${JSON.stringify(tiptapJson, null, 2)}
\`\`\`

**请直接输出转换后的 Markdown 内容（不要包含任何解释）：**
`
}

/**
 * 验证转换后的内容完整性
 */
function validateConversion(
  originalJson: TiptapNode,
  convertedMarkdown: string,
  threshold: number = 0.9
): { isValid: boolean; retentionRate: number; issues: string[] } {
  const issues: string[] = []

  // 统计原始内容
  const originalStats = countTextContent(originalJson)
  const originalCharCount = originalStats.charCount

  // 统计转换后的内容（移除 Markdown 标记，只计算纯文本）
  const markdownTextOnly = convertedMarkdown
    .replace(/#{1,6}\s+/g, '') // 移除标题标记
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 移除粗体标记
    .replace(/\*([^*]+)\*/g, '$1') // 移除斜体标记
    .replace(/`([^`]+)`/g, '$1') // 移除行内代码标记
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1') // 移除链接标记，保留文本
    .replace(/!\[([^\]]*)\]\([^\)]+\)/g, '') // 移除图片标记
    .replace(/<video[^>]*><\/video>/g, '') // 移除视频标记
    .replace(/>\s+/g, '') // 移除引用标记
    .replace(/```[\s\S]*?```/g, '') // 移除代码块（代码块内容不计入文本统计）
    .replace(/\n+/g, ' ') // 规范化空白
    .trim()

  const convertedCharCount = markdownTextOnly.length

  // 计算保留率
  const retentionRate = originalCharCount > 0 ? convertedCharCount / originalCharCount : 1

  // 检查保留率
  if (retentionRate < threshold) {
    issues.push(`内容保留率过低: ${(retentionRate * 100).toFixed(1)}% (阈值: ${threshold * 100}%)`)
  }

  // 检查关键节点是否被转换
  if (originalJson.content && Array.isArray(originalJson.content)) {
    const hasHeading = originalJson.content.some((node) => node.type === 'heading')
    const hasParagraph = originalJson.content.some((node) => node.type === 'paragraph')

    if (hasHeading && !/#{1,6}\s/.test(convertedMarkdown)) {
      issues.push('检测到标题节点但 Markdown 中缺少标题标记')
    }

    if (hasParagraph && convertedCharCount < originalCharCount * 0.5) {
      issues.push('段落内容可能丢失')
    }
  }

  const isValid = issues.length === 0 && retentionRate >= threshold

  return {
    isValid,
    retentionRate,
    issues
  }
}

/**
 * 使用 LLM 将 Tiptap JSON 转换为 Markdown
 */
export async function tiptapToMarkdownLLM(
  tiptapJson: TiptapNode,
  options: TiptapToMarkdownLLMOptions = {}
): Promise<string> {
  if (!tiptapJson || !tiptapJson.type) {
    throw new Error('Invalid Tiptap JSON: missing type field')
  }

  const {
    llmModel = 'gpt-4o-mini',
    temperature = 0.1,
    maxTokens,
    enableValidation = true,
    contentRetentionThreshold = 0.9
  } = options

  console.log(`[tiptapToMarkdownLLM] 开始 LLM 转换，模型: ${llmModel}`)

  // 统计原始内容
  const originalStats = countTextContent(tiptapJson)
  console.log(
    `[tiptapToMarkdownLLM] 原始内容统计: ${originalStats.textCount} 个文本节点, ${originalStats.charCount} 字符, ${originalStats.nodeCount} 个节点`
  )

  try {
    // 检查是否需要分块
    const jsonString = JSON.stringify(tiptapJson)
    const estimatedTokens = estimateTokenCount(jsonString)
    console.log(`[tiptapToMarkdownLLM] 估算 token 数: ${estimatedTokens}`)

    let markdown: string

    if (needsChunking(tiptapJson, maxTokens || 100000)) {
      console.log(`[tiptapToMarkdownLLM] 文档较大，使用分块处理`)

      // 分块处理
      const chunks = chunkDocument(tiptapJson, (maxTokens || 100000) * 0.8)
      console.log(`[tiptapToMarkdownLLM] 分为 ${chunks.length} 个块`)

      const chunkResults: string[] = []

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        console.log(`[tiptapToMarkdownLLM] 处理第 ${i + 1}/${chunks.length} 块`)

        const prompt = buildConversionPrompt(chunk)

        const { text } = await generateText({
          model: openaiChat(llmModel),
          prompt,
          temperature,
          ...(maxTokens && { maxTokens })
        })

        const chunkMarkdown = text.trim()
        chunkResults.push(chunkMarkdown)
        console.log(`[tiptapToMarkdownLLM] 第 ${i + 1} 块转换完成，长度: ${chunkMarkdown.length}`)
      }

      // 合并结果
      markdown = chunkResults.join('\n\n')
      console.log(`[tiptapToMarkdownLLM] 所有块转换完成，合并后长度: ${markdown.length}`)
    } else {
      // 单次转换
      const prompt = buildConversionPrompt(tiptapJson)

      const { text } = await generateText({
        model: openaiChat(llmModel),
        prompt,
        temperature,
        ...(maxTokens && { maxTokens })
      })

      markdown = text.trim()
      console.log(`[tiptapToMarkdownLLM] 转换完成，长度: ${markdown.length}`)
    }

    // 验证内容完整性
    if (enableValidation) {
      const validation = validateConversion(tiptapJson, markdown, contentRetentionThreshold)
      console.log(
        `[tiptapToMarkdownLLM] 验证结果: 保留率 ${(validation.retentionRate * 100).toFixed(1)}%, 有效: ${
          validation.isValid
        }`
      )

      if (validation.issues.length > 0) {
        console.warn(`[tiptapToMarkdownLLM] 验证发现问题:`, validation.issues)
      }

      if (!validation.isValid) {
        throw new Error(
          `内容完整性验证失败: ${validation.issues.join('; ')} (保留率: ${(validation.retentionRate * 100).toFixed(
            1
          )}%)`
        )
      }
    }

    return markdown
  } catch (error: any) {
    console.error(`[tiptapToMarkdownLLM] LLM 转换失败: ${error.message}`)
    throw error
  }
}
