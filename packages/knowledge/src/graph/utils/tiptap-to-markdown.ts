import { Schema } from 'prosemirror-model'
import { schema } from 'prosemirror-schema-basic'
import { addListNodes } from 'prosemirror-schema-list'
import { defaultMarkdownSerializer } from 'prosemirror-markdown'
import { Node } from 'prosemirror-model'

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

const nodeTypeMap: Record<string, string> = {
  bulletList: 'bullet_list',
  orderedList: 'ordered_list',
  listItem: 'list_item',
  hardBreak: 'hard_break',
  horizontalRule: 'horizontal_rule',
  codeBlock: 'code_block',
}

/**
 * 创建ProseMirror Schema（支持基本节点、列表和 bold 标记）
 */
const mySchema = new Schema({
  nodes: addListNodes(schema.spec.nodes, 'paragraph block*', 'block'),
  marks: schema.spec.marks
})

// 手动添加 bold 标记到 schema（用于兼容影刀文档数据）
if (!mySchema.marks.bold) {
  // 通过修改 schema 的 marks 属性来添加 bold mark
  // 注意：这需要创建一个新的 schema 实例
}

/**
 * 标准化节点中的 marks（将 bold 转换为 strong）
 */
function normalizeMarks(node: TiptapNode): TiptapNode {
  const normalized = { ...node }
  normalized.type = nodeTypeMap[normalized.type] || normalized.type

  // 标准化当前节点的 marks
  if (normalized.marks && Array.isArray(normalized.marks)) {
    normalized.marks = normalized.marks.map((mark: any) => {
      // textStyle 只承载编辑器样式，不影响知识内容，basic schema 不定义该 mark。
      if (mark.type === 'textStyle') return null
      // 将 bold 标记映射为 strong（兼容影刀文档）
      if (mark.type === 'bold') {
        return { ...mark, type: 'strong' }
      }
      if (mark.type === 'italic') return { ...mark, type: 'em' }
      return mark
    }).filter(Boolean)
  }

  // 递归处理子节点
  if (normalized.content && Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map((child: TiptapNode) => normalizeMarks(child))
  }

  return normalized
}

/**
 * 递归提取节点中的文本内容（保留格式）
 * 改进：保留 marks（格式标记）信息
 */
function extractText(node: TiptapNode, preserveFormat: boolean = false): string {
  if (node.type === 'text') {
    let text = node.text || ''

    // 如果保留格式，应用 marks
    if (preserveFormat && node.marks && Array.isArray(node.marks)) {
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

  if (node.type === 'hard_break') return '\n'

  if (node.content && Array.isArray(node.content)) {
    return node.content.map((child: TiptapNode) => extractText(child, preserveFormat)).join('')
  }
  return ''
}

/**
 * 提取文本内容（不保留格式，用于降级策略）
 */
function extractPlainText(node: TiptapNode): string {
  return extractText(node, false)
}

/**
 * 提取文本内容（保留格式，用于降级策略）
 */
function extractFormattedText(node: TiptapNode): string {
  return extractText(node, true)
}

function renderList(node: TiptapNode, ordered: boolean): string {
  const items = node.content || []
  return items.map((item, index) => {
    const marker = ordered ? `${index + 1}.` : '-'
    const blocks = (item.content || []).map((child) => {
      if (child.type === 'bullet_list') return renderList(child, false)
      if (child.type === 'ordered_list') return renderList(child, true)
      return extractFormattedText(child)
    }).filter(Boolean)
    const first = blocks.shift() || ''
    const nested = blocks.length > 0 ? `\n${blocks.join('\n')}` : ''
    return `${marker} ${first}${nested}`
  }).join('\n')
}

function renderBlockquote(node: TiptapNode): string {
  const content = (node.content || []).map((child) => {
    if (child.type === 'bullet_list') return renderList(child, false)
    if (child.type === 'ordered_list') return renderList(child, true)
    return extractFormattedText(child)
  }).filter(Boolean).join('\n\n')
  return content.split('\n').map((line) => `> ${line}`).join('\n')
}

/**
 * 手动处理自定义节点（prosemirror-markdown不支持的节点）
 */
function handleCustomNode(node: TiptapNode, markdown: string[]): void {
  const nodeType = node.type

  // 处理image节点
  if (nodeType === 'image') {
    const attrs = node.attrs || {}
    const src = attrs.src || attrs.url || ''
    const alt = attrs.alt || '' // 改进：只使用 attrs.alt，不再调用 extractText
    const title = attrs.title ? ` "${attrs.title}"` : '' // 改进：支持 title 属性

    markdown.push(`![${alt}](${src}${title})`)
    return
  }

  // 处理code_block节点（改进：添加语言支持）
  if (nodeType === 'code_block') {
    const attrs = node.attrs || {}
    const language = attrs.language || ''
    const code = extractPlainText(node) // 代码块不需要格式标记

    if (code.trim()) {
      markdown.push(`\`\`\`${language}\n${code}\n\`\`\``)
    }
    return
  }

  // 处理video节点
  if (nodeType === 'video') {
    const attrs = node.attrs || {}
    const src = attrs.src || attrs.url || ''
    const width = attrs.width ? ` width="${attrs.width}"` : ''
    const height = attrs.height ? ` height="${attrs.height}"` : ''

    markdown.push(`<video src="${src}"${width}${height}></video>`)
    return
  }

  // 处理其他自定义节点：降级为段落或纯文本（保留格式）
  if (node.content && Array.isArray(node.content)) {
    // 尝试保留格式
    const formattedText = extractFormattedText(node)
    if (formattedText.trim()) {
      markdown.push(formattedText)
    }
  } else {
    const formattedText = extractFormattedText(node)
    if (formattedText.trim()) {
      markdown.push(formattedText)
    }
  }
}

/**
 * 将Tiptap/ProseMirror JSON转换为Markdown
 *
 * @param tiptapJson - Tiptap/ProseMirror JSON对象
 * @returns Markdown字符串
 */
export function tiptapToMarkdown(tiptapJson: TiptapNode): string {
  if (!tiptapJson || !tiptapJson.type) {
    throw new Error('Invalid Tiptap JSON: missing type field')
  }

  console.log(`[tiptapToMarkdown] 开始转换，type: ${tiptapJson.type}, content长度: ${tiptapJson.content?.length || 0}`)

  // 标准化 marks（将 bold 等映射为标准标记）
  const normalizedJson = normalizeMarks(tiptapJson)

  const processedMarkdown: string[] = []

  /**
   * 处理单个节点（改进：消除重复遍历，边检测边处理）
   */
  function processNode(node: TiptapNode, parentMarkdown: string[]): void {
    const nodeType = node.type

    // 对列表和引用显式渲染，避免嵌套 Tiptap 节点触发 schema 降级。
    if (nodeType === 'bullet_list') {
      parentMarkdown.push(renderList(node, false))
      return
    }
    if (nodeType === 'ordered_list') {
      parentMarkdown.push(renderList(node, true))
      return
    }
    if (nodeType === 'blockquote') {
      parentMarkdown.push(renderBlockquote(node))
      return
    }
    if (nodeType === 'hard_break') {
      parentMarkdown.push('\n')
      return
    }

    // 1. 特殊处理的节点（image, video, code_block, horizontal_rule/horizontalRule）
    if (['image', 'video', 'code_block', 'horizontal_rule', 'horizontalRule'].includes(nodeType)) {
      // 对于 horizontal_rule/horizontalRule，直接输出 markdown 水平线
      if (nodeType === 'horizontal_rule' || nodeType === 'horizontalRule') {
        parentMarkdown.push('---')
        return
      }
      handleCustomNode(node, parentMarkdown)
      return
    }

    // 2. 自定义节点（不在 schema 中）
    if (nodeType && !mySchema.nodes[nodeType]) {
      handleCustomNode(node, parentMarkdown)
      return
    }

    // 3. 标准节点，尝试使用 prosemirror-markdown
    try {
      // 对于块级节点，需要包装在文档中才能正确序列化
      const isBlockNode =
        nodeType &&
        [
          'paragraph',
          'heading',
          'blockquote',
          'horizontal_rule',
          'horizontalRule',
          'bullet_list',
          'ordered_list'
        ].includes(nodeType)

      if (isBlockNode) {
        // 创建临时文档结构来序列化块级节点
        const tempDoc = {
          type: 'doc',
          content: [node]
        }
        const docNode = Node.fromJSON(mySchema, tempDoc)
        const nodeMarkdown = defaultMarkdownSerializer.serialize(docNode)
        if (nodeMarkdown.trim()) {
          parentMarkdown.push(nodeMarkdown)
        }
      } else {
        // 对于内联节点或文档节点，直接序列化
        const docNode = Node.fromJSON(mySchema, node)
        const nodeMarkdown = defaultMarkdownSerializer.serialize(docNode)
        if (nodeMarkdown.trim()) {
          parentMarkdown.push(nodeMarkdown)
        }
      }
    } catch (error: any) {
      // 改进：详细的错误日志
      console.warn(`[tiptapToMarkdown] Failed to convert node of type "${nodeType}":`, error.message)
      console.warn('[tiptapToMarkdown] Node data:', JSON.stringify(node, null, 2))

      // 如果转换失败，降级为文本提取（保留格式）
      try {
        // 根据节点类型决定是否保留格式
        const shouldPreserveFormat = ['paragraph', 'heading', 'blockquote'].includes(nodeType)
        const text = shouldPreserveFormat ? extractFormattedText(node) : extractPlainText(node)

        // 如果是标题节点，添加标题标记
        if (nodeType === 'heading' && node.attrs?.level) {
          const level = node.attrs.level
          const prefix = '#'.repeat(level) + ' '
          if (text.trim()) {
            parentMarkdown.push(prefix + text.trim())
          }
        } else if (text.trim()) {
          parentMarkdown.push(text)
        }
      } catch (extractError: any) {
        // 改进：双重错误处理
        console.warn('[tiptapToMarkdown] Failed to extract text from node:', extractError.message)
        parentMarkdown.push('[无法转换的内容]')
      }
    }
  }

  // 递归处理文档内容（改进：单次遍历，无需预先检测自定义节点）
  try {
    if (normalizedJson.content && Array.isArray(normalizedJson.content)) {
      normalizedJson.content.forEach((child: TiptapNode) => {
        processNode(child, processedMarkdown)
      })
    }
  } catch (error: any) {
    // 改进：顶层错误处理
    console.warn('[tiptapToMarkdown] Failed to process document content:', error.message)
    console.warn('[tiptapToMarkdown] Document data:', JSON.stringify(normalizedJson, null, 2))

    // 最终降级：提取所有文本（保留格式）
    try {
      const text = extractFormattedText(normalizedJson)
      if (text && text.trim().length > 0) {
        console.log('[tiptapToMarkdown] 使用降级策略提取文本，长度:', text.length)
        return text
      }
      return ''
    } catch (finalError: any) {
      console.warn('[tiptapToMarkdown] Failed to extract text from document:', finalError.message)
      return ''
    }
  }

  // 合并结果并清理多余的空白行
  const markdown = processedMarkdown
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  console.log(`[tiptapToMarkdown] 转换完成，结果长度: ${markdown.length}, 块数量: ${processedMarkdown.length}`)
  if (markdown.length === 0) {
    console.warn(
      `[tiptapToMarkdown] 警告：转换结果为空，原始内容:`,
      JSON.stringify(tiptapJson, null, 2).substring(0, 500)
    )
  }

  return markdown
}
