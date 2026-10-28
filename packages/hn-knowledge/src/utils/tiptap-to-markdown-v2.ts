/**
 * 使用 Tiptap Static Renderer 将 TipTap/ProseMirror JSON 转换为 Markdown
 *
 * 相比之前的 prosemirror-markdown 实现：
 * - 代码量减少 90%
 * - 官方支持和维护
 * - 更好的扩展性
 * - 性能优化
 */

import StarterKit from '@tiptap/starter-kit'
import { TableKit } from '@tiptap/extension-table'
import { renderToMarkdown } from '@tiptap/static-renderer/pm/markdown'

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
 * 标准化节点类型名称（snake_case → camelCase）
 * 兼容影刀文档的命名风格
 */
function normalizeNodeType(node: TiptapNode): TiptapNode {
  const normalized = { ...node }

  // 节点类型映射：snake_case → camelCase
  const nodeTypeMapping: Record<string, string> = {
    code_block: 'codeBlock',
    bullet_list: 'bulletList',
    ordered_list: 'orderedList',
    list_item: 'listItem',
    horizontal_rule: 'horizontalRule',
    hard_break: 'hardBreak'
  }

  // 转换节点类型
  if (nodeTypeMapping[normalized.type]) {
    normalized.type = nodeTypeMapping[normalized.type]
  }

  // 标准化 marks（strong → bold, em → italic, code → code）
  if (normalized.marks && Array.isArray(normalized.marks)) {
    normalized.marks = normalized.marks.map((mark: any) => {
      // 兼容影刀文档：strong → bold（Tiptap 标准是 bold）
      if (mark.type === 'strong') {
        return { ...mark, type: 'bold' }
      }
      // 兼容影刀文档：em → italic（Tiptap 标准是 italic）
      if (mark.type === 'em') {
        return { ...mark, type: 'italic' }
      }
      return mark
    })
  }

  // 递归处理子节点
  if (normalized.content && Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map((child: TiptapNode) => normalizeNodeType(child))
  }

  return normalized
}

/**
 * 预处理文档：提取 image 和 video 节点，并用占位符替换
 * 返回: { processedDocument, customNodes }
 * - processedDocument: 移除 image/video 节点后的文档
 * - customNodes: 自定义节点的 Markdown 输出数组
 */
function preprocessCustomNodes(node: TiptapNode): {
  processedDocument: TiptapNode
  customNodes: string[]
} {
  const customNodes: string[] = []

  function processNode(currentNode: TiptapNode): TiptapNode | null {
    const nodeType = currentNode.type

    // 处理视频节点
    if (nodeType === 'video') {
      const src = currentNode.attrs?.src || currentNode.attrs?.url || ''
      const width = currentNode.attrs?.width ? ` width="${currentNode.attrs.width}"` : ''
      const height = currentNode.attrs?.height ? ` height="${currentNode.attrs.height}"` : ''

      customNodes.push(`<video src="${src}"${width}${height}></video>`)
      return null // 从文档中移除
    }

    // 处理图片节点
    if (nodeType === 'image') {
      const src = currentNode.attrs?.src || currentNode.attrs?.url || ''
      const alt = currentNode.attrs?.alt || ''
      const title = currentNode.attrs?.title ? ` "${currentNode.attrs.title}"` : ''

      customNodes.push(`![${alt}](${src}${title})`)
      return null // 从文档中移除
    }

    // 递归处理子节点
    if (currentNode.content && Array.isArray(currentNode.content)) {
      const processedContent = currentNode.content
        .map((child: TiptapNode) => processNode(child))
        .filter((child): child is TiptapNode => child !== null)

      return { ...currentNode, content: processedContent }
    }

    return currentNode
  }

  const processedDocument = processNode(node)
  return {
    processedDocument: processedDocument || node,
    customNodes
  }
}

/**
 * 将 Tiptap/ProseMirror JSON 转换为 Markdown（使用 Tiptap Static Renderer）
 *
 * @param tiptapJson - Tiptap/ProseMirror JSON 对象
 * @returns Markdown 字符串
 */
export function tiptapToMarkdownV2(tiptapJson: TiptapNode): string {
  if (!tiptapJson || !tiptapJson.type) {
    throw new Error('Invalid Tiptap JSON: missing type field')
  }

  try {
    console.log(`[tiptapToMarkdownV2] 开始转换，原始 tiptapJson type: ${tiptapJson.type}`)
    console.log(`[tiptapToMarkdownV2] 原始 content 长度: ${tiptapJson.content?.length || 0}`)
    
    // 预处理：标准化节点类型名称和 marks
    const normalizedJson = normalizeNodeType(tiptapJson)
    console.log(`[tiptapToMarkdownV2] 标准化后 type: ${normalizedJson.type}`)
    console.log(`[tiptapToMarkdownV2] 标准化后 content 长度: ${normalizedJson.content?.length || 0}`)
    
    // 记录节点类型
    if (normalizedJson.content && Array.isArray(normalizedJson.content)) {
      const nodeTypes = normalizedJson.content.map((node: any) => node.type).slice(0, 10)
      console.log(`[tiptapToMarkdownV2] 前10个节点类型:`, nodeTypes)
    }

    // 预处理：提取 image 和 video 节点（StarterKit 不支持这些节点）
    const { processedDocument, customNodes } = preprocessCustomNodes(normalizedJson)
    console.log(`[tiptapToMarkdownV2] 预处理后 content 长度: ${processedDocument.content?.length || 0}`)
    console.log(`[tiptapToMarkdownV2] 自定义节点数量: ${customNodes.length}`)
    
    // 记录处理后的节点类型
    if (processedDocument.content && Array.isArray(processedDocument.content)) {
      const processedNodeTypes = processedDocument.content.map((node: any) => node.type).slice(0, 10)
      console.log(`[tiptapToMarkdownV2] 预处理后前10个节点类型:`, processedNodeTypes)
    }

    // 使用 renderToMarkdown 处理剩余的节点
    let mainContent: string
    let unhandledNodes: string[] = []
    let unhandledMarks: string[] = []
    
    try {
      console.log(`[tiptapToMarkdownV2] 调用 renderToMarkdown，content 结构:`, JSON.stringify({
        type: processedDocument.type,
        contentLength: processedDocument.content?.length || 0,
        firstNode: processedDocument.content?.[0] ? {
          type: processedDocument.content[0].type,
          hasText: !!processedDocument.content[0].text,
          hasContent: !!processedDocument.content[0].content,
          contentLength: processedDocument.content[0].content?.length || 0
        } : null
      }, null, 2))
      
      mainContent = renderToMarkdown({
        extensions: [StarterKit, TableKit],
        content: processedDocument as any,
        options: {
          // 处理未处理的节点（降级为纯文本）
          unhandledNode({ node }: any) {
            const nodeType = node.type
            unhandledNodes.push(nodeType)
            console.warn(`[tiptapToMarkdownV2] Unhandled node type: ${nodeType}`, JSON.stringify({
              type: node.type,
              attrs: node.attrs,
              hasContent: !!node.content,
              contentLength: node.content?.length || 0,
              hasText: !!node.text
            }, null, 2).substring(0, 500))

            // 尝试提取文本内容
            if (node.content) {
              return node.content
                .map((child: any) =>
                  child.text || child.type === 'text' ? child.text : JSON.stringify(child)
                )
                .join('')
            }
            return `[unknown node ${nodeType}]`
          },
          // 处理未处理的标记（降级为纯文本）
          unhandledMark({ mark }: any) {
            unhandledMarks.push(mark.type)
            console.warn(`[tiptapToMarkdownV2] Unhandled mark type: ${mark.type}`, JSON.stringify(mark, null, 2).substring(0, 200))
            return ''
          }
        }
      })
      console.log(`[tiptapToMarkdownV2] renderToMarkdown 返回内容长度: ${mainContent?.length || 0}`)
      console.log(`[tiptapToMarkdownV2] renderToMarkdown 返回内容预览: ${mainContent?.substring(0, 200) || '(空)'}`)
      console.log(`[tiptapToMarkdownV2] 未处理的节点类型:`, [...new Set(unhandledNodes)])
      console.log(`[tiptapToMarkdownV2] 未处理的标记类型:`, [...new Set(unhandledMarks)])
    } catch (renderError: any) {
      console.error(`[tiptapToMarkdownV2] renderToMarkdown 失败: ${renderError.message}`)
      console.error(`[tiptapToMarkdownV2] renderToMarkdown 错误堆栈:`, renderError.stack)
      console.error(`[tiptapToMarkdownV2] processedDocument:`, JSON.stringify(processedDocument, null, 2).substring(0, 2000))
      // 如果 renderToMarkdown 失败，使用降级策略
      mainContent = ''
    }

    // 如果 mainContent 为空，使用降级策略提取文本
    if (!mainContent || mainContent.trim().length === 0) {
      console.warn(`[tiptapToMarkdownV2] mainContent 为空，使用降级策略提取文本`)
      const fallbackText = extractTextFromTiptap(processedDocument)
      if (fallbackText && fallbackText.trim().length > 0) {
        console.log(`[tiptapToMarkdownV2] 降级策略提取到文本: ${fallbackText.substring(0, 200)}`)
        mainContent = fallbackText
      }
    }

    // 合并主要内容（从 renderToMarkdown）和自定义节点（image/video）
    // 策略：将自定义节点插入到对应的位置
    // 简化方案：直接拼接（自定义节点在最后）
    if (customNodes.length > 0) {
      // 清理并合并内容
      const cleanedMain = mainContent.trim()
      const cleanedCustom = customNodes.join('\n\n')

      if (!cleanedMain) {
        return cleanedCustom
      }

      return `${cleanedMain}\n\n${cleanedCustom}`
    }

    // 修剪输出以匹配原实现的行为
    const result = mainContent.trim()
    if (!result || result.length === 0) {
      console.warn(`[tiptapToMarkdownV2] 最终结果为空，尝试从原始 tiptapJson 提取文本`)
      const finalFallback = extractTextFromTiptap(tiptapJson)
      if (finalFallback && finalFallback.trim().length > 0) {
        return finalFallback
      }
    }
    return result
  } catch (error: any) {
    console.error('[tiptapToMarkdownV2] Failed to render markdown:', error.message)
    console.error('[tiptapToMarkdownV2] Input data:', JSON.stringify(tiptapJson, null, 2))

    // 降级策略：尝试提取文本
    try {
      const fallbackText = extractTextFromTiptap(tiptapJson)
      if (fallbackText && fallbackText.trim().length > 0) {
        console.log(`[tiptapToMarkdownV2] 降级策略提取到文本: ${fallbackText.substring(0, 200)}`)
        return fallbackText
      }
      return ''
    } catch (fallbackError: any) {
      console.error('[tiptapToMarkdownV2] Fallback also failed:', fallbackError.message)
      return ''
    }
  }
}

/**
 * 从 Tiptap 节点中递归提取文本内容（降级策略）
 * 改进：保留更多格式信息，包括粗体、斜体、代码、链接等
 */
function extractTextFromTiptap(node: any): string {
  if (!node) return ''
  
  if (typeof node === 'string') {
    return node
  }
  
  // 处理文本节点，应用 marks（格式标记）
  if (node.text) {
    let text = node.text
    
    // 应用 marks（格式标记）
    if (node.marks && Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        const markType = mark.type
        if (markType === 'bold' || markType === 'strong') {
          text = `**${text}**`
        } else if (markType === 'italic' || markType === 'em') {
          text = `*${text}*`
        } else if (markType === 'code') {
          text = `\`${text}\``
        } else if (markType === 'link') {
          const href = mark.attrs?.href || mark.attrs?.url || ''
          text = `[${text}](${href})`
        } else if (markType === 'strike') {
          text = `~~${text}~~`
        }
      }
    }
    
    return text
  }
  
  if (node.content && Array.isArray(node.content)) {
    const nodeType = node.type
    
    // 处理各种节点类型，保留格式
    if (nodeType === 'heading') {
      const level = node.attrs?.level || 1
      const prefix = '#'.repeat(level) + ' '
      const content = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
        .join('')
      return prefix + content
    } else if (nodeType === 'paragraph') {
      const content = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
        .join('')
      return content
    } else if (nodeType === 'bulletList' || nodeType === 'bullet_list') {
      const items = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
      return items.map((text: string) => `- ${text}`).join('\n')
    } else if (nodeType === 'orderedList' || nodeType === 'ordered_list') {
      const items = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
      return items.map((text: string, index: number) => `${index + 1}. ${text}`).join('\n')
    } else if (nodeType === 'listItem' || nodeType === 'list_item') {
      const content = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
        .join(' ')
      return content
    } else if (nodeType === 'blockquote') {
      const content = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
        .join('\n')
      return content.split('\n').map((line: string) => `> ${line}`).join('\n')
    } else if (nodeType === 'codeBlock' || nodeType === 'code_block') {
      const language = node.attrs?.language || ''
      const content = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
        .join('')
      return `\`\`\`${language}\n${content}\n\`\`\``
    } else if (nodeType === 'hardBreak' || nodeType === 'hard_break') {
      return '\n'
    } else if (nodeType === 'horizontalRule' || nodeType === 'horizontal_rule') {
      return '---'
    } else if (nodeType === 'image') {
      const src = node.attrs?.src || node.attrs?.url || ''
      const alt = node.attrs?.alt || ''
      const title = node.attrs?.title ? ` "${node.attrs.title}"` : ''
      return `![${alt}](${src}${title})`
    } else if (nodeType === 'video') {
      const src = node.attrs?.src || node.attrs?.url || ''
      const width = node.attrs?.width ? ` width="${node.attrs.width}"` : ''
      const height = node.attrs?.height ? ` height="${node.attrs.height}"` : ''
      return `<video src="${src}"${width}${height}></video>`
    } else {
      // 其他节点类型，递归处理子节点
      const content = node.content
        .map((child: any) => extractTextFromTiptap(child))
        .filter((text: string) => text && text.trim().length > 0)
        .join(' ')
      return content
    }
  }
  
  return ''
}

// 默认导出（保持向后兼容）
export const tiptapToMarkdown = tiptapToMarkdownV2
