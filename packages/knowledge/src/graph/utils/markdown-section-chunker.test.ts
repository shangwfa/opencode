import { describe, expect, it } from 'bun:test'
import { chunkMarkdownBySections } from './markdown-section-chunker.js'

describe('chunkMarkdownBySections', () => {
  it('保留标题层级并把路径注入 chunk', async () => {
    const chunks = await chunkMarkdownBySections(
      '# 产品说明\n\n## 智能体\n\n智能体用于处理业务任务。\n\n### 工具\n\n工具用于连接外部系统。',
      { maxSize: 512, overlap: 50 }
    )

    expect(chunks.length).toBeGreaterThan(0)
    // 相邻 section 不足 maxSize 会合并成组，chunk 覆盖多条路径
    expect(chunks.some((chunk) => chunk.metadata.headingPaths.some((p) => p.join(' > ') === '产品说明 > 智能体'))).toBe(true)
    expect(chunks.some((chunk) => chunk.text.includes('产品说明 > 智能体'))).toBe(true)
  })

  it('相邻小 section 合并成大块，路径联合标注', async () => {
    const sections = Array.from(
      { length: 4 },
      (_, i) => `## 章节${i}\n\n章节${i}的内容，用于验证相邻合并。`
    ).join('\n\n')
    const chunks = await chunkMarkdownBySections(`# 文档\n\n${sections}`, {
      maxSize: 100,
      overlap: 0,
    })

    // 4 个小 section + 文档头总长 < 100*3，应合并远少于 5 块
    expect(chunks.length).toBeLessThan(4)
    expect(chunks[0].metadata.headingPaths.length).toBeGreaterThan(1)
    expect(chunks[0].text).toContain('；')
  })

  it('超长 section 继续使用 markdown 策略切分', async () => {
    const chunks = await chunkMarkdownBySections(
      `# 长文档\n\n${Array.from({ length: 30 }, (_, i) => `第${i}段内容，用于验证结构化分块。`).join('\n\n')}`,
      { maxSize: 120, overlap: 20 }
    )

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((chunk) => chunk.metadata.headingPath[0] === '长文档')).toBe(true)
  })
})
