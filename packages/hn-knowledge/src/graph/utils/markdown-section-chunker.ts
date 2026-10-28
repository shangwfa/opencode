import { MDocument } from '@mastra/rag'

export interface MarkdownChunk {
  text: string
  metadata: {
    headingPath: string[]
    /** 该 chunk 覆盖的全部章节路径（相邻 section 合并后可能多条，去重保序） */
    headingPaths: string[][]
    sectionIndex: number
  }
}

interface Section {
  headingPath: string[]
  text: string
}

/**
 * 先按 Markdown 标题组织 section，再将相邻 section 合并成接近 maxSize 的组，
 * 组内超长时用 Markdown 策略继续切分。
 *
 * 相邻合并（不跨组）对齐 TrustGraph chunk_size=2000 的大块策略：
 * 避免大量小 section 各自成碎块，保证 LLM 抽取时的上下文完整性。
 * 组内多路径在 chunk 前缀联合标注（"章节路径：A > B；A > C"），
 * 标题层级信息保留在合并文本中，不做跨层错配拼接。
 */
export async function chunkMarkdownBySections(
  markdown: string,
  options: { maxSize: number; overlap: number }
): Promise<MarkdownChunk[]> {
  const sections: Section[] = []
  const stack: Array<{ level: number; title: string }> = []
  let currentPath: string[] = []
  let currentLines: string[] = []

  const flush = () => {
    const text = currentLines.join('\n').trim()
    if (text) sections.push({ headingPath: currentPath, text })
    currentLines = []
  }

  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/)
    if (match) {
      flush()
      const level = match[1].length
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
      stack.push({ level, title: match[2].trim() })
      currentPath = stack.map((item) => item.title)
    }
    currentLines.push(line)
  }
  flush()

  if (sections.length === 0) {
    sections.push({ headingPath: [], text: markdown.trim() })
  }

  // 相邻 section 合并成接近 maxSize 的组：不足 maxSize 则继续吸收下一个 section
  interface SectionGroup {
    headingPaths: string[][]
    text: string
  }
  const groups: SectionGroup[] = []
  let currentGroup: SectionGroup | null = null
  for (const section of sections) {
    if (currentGroup && currentGroup.text.length + section.text.length <= options.maxSize) {
      currentGroup.headingPaths.push(section.headingPath)
      currentGroup.text += `\n\n${section.text}`
    } else {
      currentGroup = { headingPaths: [section.headingPath], text: section.text }
      groups.push(currentGroup)
    }
  }

  const result: MarkdownChunk[] = []
  for (const [sectionIndex, group] of groups.entries()) {
    const document = MDocument.fromMarkdown(group.text)
    const chunks = await document.chunk({
      strategy: 'markdown',
      maxSize: options.maxSize,
      overlap: options.overlap,
    })
    const headingPaths: string[][] = []
    const seenPaths = new Set<string>()
    for (const path of group.headingPaths) {
      const key = path.join(' > ')
      if (!seenPaths.has(key)) {
        seenPaths.add(key)
        headingPaths.push(path)
      }
    }
    const prefix = headingPaths.length > 0
      ? `章节路径：${headingPaths.map((path) => path.join(' > ')).join('；')}\n\n`
      : ''
    for (const chunk of chunks) {
      const text = String(chunk.text || '').trim()
      if (!text) continue
      result.push({
        text: `${prefix}${text}`,
        metadata: { headingPath: headingPaths[0] ?? [], headingPaths, sectionIndex },
      })
    }
  }
  return result
}
