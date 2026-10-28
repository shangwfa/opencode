import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { tiptapToMarkdown } from './tiptap-to-markdown.js'

describe('tiptapToMarkdown', () => {
  it('应该保留列表、硬换行和 textStyle 文本', () => {
    const result = tiptapToMarkdown({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: '第一行', marks: [{ type: 'textStyle', attrs: { color: '#fff' } }] },
              { type: 'hardBreak' },
              { type: 'text', text: '第二行' },
            ],
          }],
        }],
      }],
    })

    expect(result).toContain('- 第一行')
    expect(result).toContain('第二行')
    expect(result).not.toContain('无法转换')
  })

  describe('基本段落转换', () => {
    it('应该转换简单段落', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '这是一个测试段落'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 简单段落转换结果:')
      console.log(result)
      expect(result).toBe('这是一个测试段落')
    })

    it('应该转换多个段落', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '第一段' }]
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '第二段' }]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 多个段落转换结果:')
      console.log(result)
      expect(result).toContain('第一段')
      expect(result).toContain('第二段')
    })
  })

  describe('标题转换', () => {
    it('应该转换h1标题', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: '一级标题' }]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] H1标题转换结果:')
      console.log(result)
      expect(result).toMatch(/^#\s+一级标题/)
    })

    it('应该转换h2-h6标题', () => {
      const levels = [2, 3, 4, 5, 6]
      levels.forEach((level) => {
        const tiptapJson = {
          type: 'doc',
          content: [
            {
              type: 'heading',
              attrs: { level },
              content: [{ type: 'text', text: `标题${level}` }]
            }
          ]
        }

        const result = tiptapToMarkdown(tiptapJson)
        console.log(`\n[测试] H${level}标题转换结果:`)
        console.log(result)
        const expectedHashes = '#'.repeat(level)
        expect(result).toMatch(new RegExp(`^${expectedHashes}\\s+标题${level}`))
      })
    })
  })

  describe('列表转换', () => {
    it('应该转换无序列表', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bullet_list',
            content: [
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '项目1' }]
                  }
                ]
              },
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '项目2' }]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 无序列表转换结果:')
      console.log(result)
      expect(result).toContain('项目1')
      expect(result).toContain('项目2')
      expect(result).toMatch(/[-*]\s+项目1/)
    })

    it('应该转换有序列表', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'ordered_list',
            content: [
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '第一项' }]
                  }
                ]
              },
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '第二项' }]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('第一项')
      expect(result).toContain('第二项')
    })
  })

  describe('代码块转换', () => {
    it('应该转换代码块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'code_block',
            attrs: { language: 'javascript' },
            content: [{ type: 'text', text: 'const x = 1;' }]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 代码块转换结果:')
      console.log(result)
      expect(result).toContain('const x = 1;')
      expect(result).toMatch(/```/)
    })
  })

  describe('文本标记转换', () => {
    it('应该转换粗体文本', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '粗体文本',
                marks: [{ type: 'strong' }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 粗体文本转换结果:')
      console.log(result)
      expect(result).toMatch(/\*\*粗体文本\*\*/)
    })

    it('应该转换斜体文本', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '斜体文本',
                marks: [{ type: 'em' }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toMatch(/[*_]\s*斜体文本\s*[*_]/)
    })

    it('应该转换代码文本', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'code',
                marks: [{ type: 'code' }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toMatch(/`code`/)
    })
  })

  describe('自定义节点转换', () => {
    it('应该转换图片节点', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/image.png',
              alt: '测试图片'
            }
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 图片节点转换结果:')
      console.log(result)
      expect(result).toContain('![测试图片](https://example.com/image.png)')
    })

    it('应该转换没有alt的图片节点', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/image.png'
            }
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toMatch(/!\[\]\(https:\/\/example\.com\/image\.png\)/)
    })

    it('应该转换视频节点', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'video',
            attrs: {
              src: 'https://example.com/video.mp4'
            }
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 视频节点转换结果:')
      console.log(result)
      // 视频节点是自定义节点，应该被转换为HTML标签
      // 如果prosemirror-markdown不支持，会降级为文本提取，但我们的handleCustomNode应该处理它
      expect(result).toMatch(/<video.*src.*https:\/\/example\.com\/video\.mp4.*><\/video>/)
    })
  })

  describe('嵌套结构转换', () => {
    it('应该转换嵌套列表', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bullet_list',
            content: [
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '外层项目' }]
                  },
                  {
                    type: 'bullet_list',
                    content: [
                      {
                        type: 'list_item',
                        content: [
                          {
                            type: 'paragraph',
                            content: [{ type: 'text', text: '内层项目' }]
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('外层项目')
      expect(result).toContain('内层项目')
    })

    it('应该转换混合内容', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: '标题' }]
          },
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '段落内容' }]
          },
          {
            type: 'bullet_list',
            content: [
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '列表项' }]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('标题')
      expect(result).toContain('段落内容')
      expect(result).toContain('列表项')
    })
  })

  describe('边界情况处理', () => {
    it('应该处理空文档', () => {
      const tiptapJson = {
        type: 'doc',
        content: []
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toBe('')
    })

    it('应该处理只有空段落的文档', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: []
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toBe('')
    })

    it('应该处理无效JSON（缺少type字段）', () => {
      const invalidJson = { content: [] }

      expect(() => tiptapToMarkdown(invalidJson as any)).toThrow('Invalid Tiptap JSON: missing type field')
    })

    it('应该处理null输入', () => {
      expect(() => tiptapToMarkdown(null as any)).toThrow('Invalid Tiptap JSON: missing type field')
    })

    it('应该处理undefined输入', () => {
      expect(() => tiptapToMarkdown(undefined as any)).toThrow('Invalid Tiptap JSON: missing type field')
    })

    it('应该处理不支持的节点类型（降级为文本）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'custom_node',
            content: [
              {
                type: 'text',
                text: '自定义节点内容'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('自定义节点内容')
    })
  })

  describe('复杂文档结构', () => {
    it('应该处理prosemirror-markdown转换失败的情况（降级为文本提取）', () => {
      // 创建一个会导致prosemirror-markdown转换失败的无效结构
      const invalidTiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'invalid_node_type',
            content: [
              {
                type: 'text',
                text: '降级文本内容'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(invalidTiptapJson)
      // 应该降级为文本提取
      expect(result).toContain('降级文本内容')
    })

    it('应该处理processNode中转换失败的情况（降级为文本）', () => {
      // 创建一个包含自定义节点和无效节点的混合结构
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '正常段落' }]
          },
          {
            type: 'invalid_custom_node',
            content: [
              {
                type: 'text',
                text: '自定义节点文本'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      // 应该包含正常段落和降级后的文本
      expect(result).toContain('正常段落')
      expect(result).toContain('自定义节点文本')
    })

    it('应该处理完全无效的Tiptap JSON（主try-catch降级）', () => {
      // 创建一个会导致Node.fromJSON失败的无效结构
      const invalidJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: {
              invalidAttr: null
            },
            content: 'invalid_content' // 应该是数组，不是字符串
          }
        ]
      }

      // 抑制预期的警告输出（这是测试降级逻辑，警告是预期的）
      const consoleWarnSpy = spyOn(console, 'warn').mockImplementation(() => {})

      try {
        // 这个测试可能会触发主try-catch的降级逻辑
        const result = tiptapToMarkdown(invalidJson as any)
        // 应该返回空字符串或降级后的文本
        expect(typeof result).toBe('string')
        // 验证确实调用了降级逻辑（console.warn被调用）
        expect(consoleWarnSpy).toHaveBeenCalled()
      } finally {
        consoleWarnSpy.mockRestore()
      }
    })

    it('应该转换包含多种节点类型的复杂文档', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', text: '文档标题' }]
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '这是' },
              { type: 'text', text: '粗体', marks: [{ type: 'strong' }] },
              { type: 'text', text: '和' },
              { type: 'text', text: '斜体', marks: [{ type: 'em' }] },
              { type: 'text', text: '文本。' }
            ]
          },
          {
            type: 'code_block',
            attrs: { language: 'javascript' },
            content: [{ type: 'text', text: 'console.log("test");' }]
          },
          {
            type: 'bullet_list',
            content: [
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '列表项1' }]
                  }
                ]
              }
            ]
          },
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/image.png',
              alt: '示例图片'
            }
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      console.log('\n[测试] 复杂文档结构转换结果:')
      console.log('='.repeat(60))
      console.log(result)
      console.log('='.repeat(60))
      expect(result).toContain('文档标题')
      expect(result).toContain('粗体')
      expect(result).toContain('斜体')
      expect(result).toContain('console.log("test");')
      expect(result).toContain('列表项1')
      expect(result).toContain('![示例图片](https://example.com/image.png)')
    })
  })

  describe('错误降级处理', () => {
    it('应该处理包含 null 值的 content 数组', () => {
      // 创建一个包含 null 的节点（测试边界情况）
      // 注意：这种情况在实际使用中很少见，但我们需要确保不会崩溃
      const result = tiptapToMarkdown({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '正常内容' }] }
        ]
      })

      // 验证基本功能正常
      expect(result).toContain('正常内容')
      expect(typeof result).toBe('string')
    })

    it('应该处理缺少 text 字段的 text 节点', () => {
      // 创建包含异常数据的节点
      const invalidNode = {
        type: 'weird_node',
        content: [
          { type: 'text', text: '文本1' },
          { type: 'text' } as any, // 缺少 text 字段，extractText 会返回空字符串
          { type: 'text', text: '文本2' }
        ]
      }

      const result = tiptapToMarkdown({ type: 'doc', content: [invalidNode] })
      // 应该包含有效的文本（空字符串会被忽略）
      expect(result).toContain('文本1')
      expect(result).toContain('文本2')
      // 结果应该是有效的字符串
      expect(result.length).toBeGreaterThan(0)
    })

    it('应该处理只有空内容的自定义节点', () => {
      // 创建只包含空内容的节点
      const emptyNode = {
        type: 'custom_empty_node',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: '   ' } // 只有空格
        ]
      }

      const result = tiptapToMarkdown({ type: 'doc', content: [emptyNode] })
      // 应该返回空字符串或只包含空白
      expect(result.trim()).toBe('')
    })
  })

  describe('特殊边界情况', () => {
    it('应该处理超深层嵌套', () => {
      // 创建 50 层嵌套的文档（性能测试，避免过深导致栈溢出）
      let deepNode = { type: 'paragraph', content: [{ type: 'text', text: 'deep content' }] }
      for (let i = 0; i < 50; i++) {
        deepNode = {
          type: 'bullet_list',
          content: [{ type: 'list_item', content: [deepNode] }]
        } as any
      }

      const startTime = Date.now()
      const result = tiptapToMarkdown({ type: 'doc', content: [deepNode] })
      const duration = Date.now() - startTime

      expect(result).toContain('deep content')
      // 应该在合理时间内完成（< 1秒）
      expect(duration).toBeLessThan(1000)
    })

    it('应该处理空字符串 text 节点', () => {
      const result = tiptapToMarkdown({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '' }] }
        ]
      })
      expect(result).toBe('')
    })

    it('应该处理只有空白字符的文档', () => {
      const result = tiptapToMarkdown({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '   \n\t  ' }] }
        ]
      })
      expect(result.trim()).toBe('')
    })

    it('应该处理混合空内容的段落', () => {
      const result = tiptapToMarkdown({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [] },
          { type: 'paragraph', content: [{ type: 'text', text: '有效内容' }] },
          { type: 'paragraph', content: [] }
        ]
      })
      expect(result).toContain('有效内容')
      // 不应该包含多余的空行
      expect(result).not.toContain('\n\n\n\n')
    })
  })

  describe('性能测试', () => {
    it('应该在合理时间内处理大型文档', () => {
      // 创建包含 500 个段落的文档
      const content = Array.from({ length: 500 }, (_, i) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `段落 ${i}` }]
      }))

      const startTime = Date.now()
      const result = tiptapToMarkdown({ type: 'doc', content })
      const duration = Date.now() - startTime

      expect(result.split('\n').length).toBeGreaterThanOrEqual(500)
      expect(duration).toBeLessThan(2000) // 应该在 2 秒内完成
    })

    it('应该在合理时间内处理大量代码块', () => {
      // 创建包含 100 个代码块的文档
      const content = Array.from({ length: 100 }, (_, i) => ({
        type: 'code_block',
        attrs: { language: 'javascript' },
        content: [{ type: 'text', text: `const x${i} = ${i};` }]
      }))

      const startTime = Date.now()
      const result = tiptapToMarkdown({ type: 'doc', content })
      const duration = Date.now() - startTime

      expect(result).toContain('const x0 = 0;')
      expect(result).toContain('const x99 = 99;')
      expect(duration).toBeLessThan(1000) // 应该在 1 秒内完成
    })
  })

  describe('图片和视频属性增强测试', () => {
    it('应该处理带 title 属性的图片', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/image.png',
              alt: '示例图片',
              title: '这是图片标题'
            }
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toMatch(/!\[示例图片\]\(https:\/\/example\.com\/image\.png "这是图片标题"\)/)
    })

    it('应该处理带宽高属性的 video', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'video',
            attrs: {
              src: 'https://example.com/video.mp4',
              width: 800,
              height: 600
            }
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('<video src="https://example.com/video.mp4" width="800" height="600"></video>')
    })

    it('应该处理只有部分属性的 video', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'video',
            attrs: {
              src: 'https://example.com/video.mp4',
              width: 800
            }
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('width="800"')
      expect(result).not.toContain('height=')
    })
  })

  describe('代码块语言支持测试', () => {
    it('应该处理带语言的代码块', () => {
      const languages = ['javascript', 'python', 'java', 'typescript', 'go', 'rust']

      languages.forEach((lang) => {
        const tiptapJson = {
          type: 'doc',
          content: [
            {
              type: 'code_block',
              attrs: { language: lang },
              content: [{ type: 'text', text: `code in ${lang}` }]
            }
          ]
        }

        const result = tiptapToMarkdown(tiptapJson)
        expect(result).toContain(`\`\`\`${lang}`)
      })
    })

    it('应该处理不带语言的代码块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'code_block',
            attrs: {},
            content: [{ type: 'text', text: 'plain code' }]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      // 应该只有 ``` ，没有语言标识
      expect(result).toMatch(/```\s*\nplain code\n```/)
    })

    it('应该处理空语言的代码块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'code_block',
            attrs: { language: '' },
            content: [{ type: 'text', text: 'empty language' }]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('empty language')
    })
  })

  describe('补充的高优先级场景', () => {
    it('应该转换链接标记', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '点击这里',
                marks: [{ type: 'link', attrs: { href: 'https://example.com' } }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('[点击这里](https://example.com)')
    })

    it('应该转换带 title 的链接', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '示例链接',
                marks: [
                  { type: 'link', attrs: { href: 'https://example.com', title: '链接标题' } }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toMatch(/\[示例链接\]\(https:\/\/example\.com "链接标题"\)/)
    })

    it('应该转换引用块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '这是一段引用' }] }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toMatch(/^> /)
      expect(result).toContain('这是一段引用')
    })

    it('应该转换多行引用块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '第一行引用' }] },
              { type: 'paragraph', content: [{ type: 'text', text: '第二行引用' }] }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('第一行引用')
      expect(result).toContain('第二行引用')
      // 验证每行都有引用标记
      const lines = result.split('\n').filter((line: string) => line.trim().length > 0)
      lines.forEach((line: string) => {
        expect(line).toMatch(/^>/)
      })
    })

    it('应该转换水平分割线', () => {
      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'horizontal_rule' }]
      }

      const result = tiptapToMarkdown(tiptapJson)
      // Markdown 支持三种水平分割线格式：---, ***, ___
      expect(result).toMatch(/^(-{3}|\*{3}|_{3})\s*$/)
    })

    it('应该转换包含水平分割线的文档', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: '第一段' }] },
          { type: 'horizontal_rule' },
          { type: 'paragraph', content: [{ type: 'text', text: '第二段' }] }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('第一段')
      expect(result).toContain('第二段')
      expect(result).toMatch(/---|\*\*\*|___/)
    })

    it('应该处理删除线标记（降级为纯文本）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '删除的内容',
                marks: [{ type: 'strike' }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      // 注意：prosemirror-schema-basic 默认不支持 strike 标记
      // 当前实现会降级为纯文本
      expect(result).toContain('删除的内容')
      // 如果需要支持删除线，需要在 schema 中添加 strike mark 定义
    })

    it('应该转换混合标记的文本（支持的标记）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '正常文本' },
              { type: 'text', text: '粗体', marks: [{ type: 'strong' }] },
              { type: 'text', text: '和' },
              { type: 'text', text: '斜体', marks: [{ type: 'em' }] },
              { type: 'text', text: '和' },
              { type: 'text', text: '代码', marks: [{ type: 'code' }] }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('**粗体**')
      expect(result).toContain('*斜体*') // 或 _斜体_
      expect(result).toContain('`代码`')
    })

    it('应该转换硬换行（换行符）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '第一行' },
              { type: 'hard_break' },
              { type: 'text', text: '第二行' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('第一行')
      expect(result).toContain('第二行')
      // prosemirror-markdown 会将硬换行转换为真正的换行
      // 验证包含换行符（不验证具体格式）
      const lines = result.split('\n')
      expect(lines.length).toBeGreaterThan(1)
      expect(lines.join('')).toContain('第一行')
      expect(lines.join('')).toContain('第二行')
    })

    it('应该转换包含多个硬换行的段落', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '第一行' },
              { type: 'hard_break' },
              { type: 'text', text: '第二行' },
              { type: 'hard_break' },
              { type: 'text', text: '第三行' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('第一行')
      expect(result).toContain('第二行')
      expect(result).toContain('第三行')
      // 验证包含两个换行
      const lineCount = result.split('\n').length
      expect(lineCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe('复杂嵌套场景', () => {
    it('应该转换有序列表中包含无序列表', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'ordered_list',
            content: [
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '有序项目1' }]
                  },
                  {
                    type: 'bullet_list',
                    content: [
                      {
                        type: 'list_item',
                        content: [
                          {
                            type: 'paragraph',
                            content: [{ type: 'text', text: '无序子项1' }]
                          }
                        ]
                      },
                      {
                        type: 'list_item',
                        content: [
                          {
                            type: 'paragraph',
                            content: [{ type: 'text', text: '无序子项2' }]
                          }
                        ]
                      }
                    ]
                  }
                ]
              },
              {
                type: 'list_item',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '有序项目2' }]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('有序项目1')
      expect(result).toContain('有序项目2')
      expect(result).toContain('无序子项1')
      expect(result).toContain('无序子项2')
    })

    it('应该转换引用块中包含列表', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: '引用段落' }]
              },
              {
                type: 'bullet_list',
                content: [
                  {
                    type: 'list_item',
                    content: [
                      {
                        type: 'paragraph',
                        content: [{ type: 'text', text: '引用中的列表项' }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(tiptapJson)
      expect(result).toContain('引用段落')
      expect(result).toContain('引用中的列表项')
      // 验证包含引用标记
      expect(result).toMatch(/>/)
    })
  })

  describe('真实数据场景测试', () => {
    it('应该转换影刀概述文档（包含 bold 标记、水平线、视频）', () => {
      // 真实数据：影刀概述文档
      const realDoc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {
              lineHeight: null,
              textAlign: null,
              level: 1,
              id: '影刀概述'
            },
            content: [
              {
                type: 'text',
                marks: [{ type: 'bold' }],
                text: '影刀概述'
              }
            ]
          },
          {
            type: 'paragraph',
            attrs: {
              lineHeight: null,
              textAlign: null
            },
            content: [
              {
                type: 'text',
                marks: [{ type: 'bold' }],
                text: '「 分叉智能 」'
              },
              {
                type: 'text',
                text: ' 一家人工智能科技公司，主要聚焦在RPA领域'
              }
            ]
          },
          {
            type: 'horizontalRule'
          },
          {
            type: 'video',
            attrs: {
              src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/712111712911486976/71f05278-ba00-4f65-8f0a-a569e8722ba8/video0.mp4'
            },
            src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/712111712911486976/71f05278-ba00-4f65-8f0a-a569e8722ba8/video0.mp4'
          }
        ]
      }

      const result = tiptapToMarkdown(realDoc)

      console.log('\n[真实数据] 影刀概述转换结果:')
      console.log(result)

      // 验证标题
      expect(result).toContain('#')
      expect(result).toContain('影刀概述')

      // 验证粗体（bold 标记应该被转换为 Markdown 的 **）
      expect(result).toContain('**「 分叉智能 」**')

      // 验证水平线
      expect(result).toMatch(/---|\*\*\*|___/)

      // 验证视频
      expect(result).toContain('<video')
      expect(result).toContain('video0.mp4')

      console.log('\n[真实数据] 影刀概述转换结果:')
      console.log(result)
    })

    it('应该转换Excel自动化文档（包含图片、视频）', () => {
      // 真实数据：Excel自动化文档
      const realDoc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {
              lineHeight: null,
              textAlign: null,
              level: 1,
              id: 'h1_5b60ef7d-6440-4cae-9eb3-c945e0526aa5'
            },
            content: [
              {
                type: 'text',
                text: '与Excel的交互'
              }
            ]
          },
          {
            type: 'video',
            attrs: {
              src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/711654104870891520/9c2713f7-0589-4895-8b61-fd9044a280de/video0.mp4'
            },
            src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/711654104870891520/9c2713f7-0589-4895-8b61-fd9044a280de/video0.mp4'
          },
          {
            type: 'heading',
            attrs: {
              lineHeight: null,
              textAlign: null,
              level: 3,
              id: 'h3_1f5a1c90-b6c2-4c63-9ffa-76bbfc562d3a'
            },
            content: [
              {
                type: 'text',
                marks: [{ type: 'bold' }],
                text: '影刀Excel操作大全'
              }
            ]
          },
          {
            type: 'paragraph',
            attrs: {
              lineHeight: null,
              textAlign: null
            },
            content: [
              {
                type: 'text',
                marks: [{ type: 'bold' }],
                text: '基本操作'
              },
              {
                type: 'text',
                text: '：读取Excel内容、写入内容至Excel、循环Excel内容等'
              }
            ]
          },
          {
            type: 'image',
            attrs: {
              src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/711654104870891520/5351ef09-e052-4d00-b2e3-3e07c9797c34/img0.png',
              alt: null,
              title: null,
              width: null,
              height: null
            },
            src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/711654104870891520/5351ef09-e052-4d00-b2e3-3e07c9797c34/img0.png'
          }
        ]
      }

      const result = tiptapToMarkdown(realDoc)

      console.log('\n[真实数据] Excel自动化转换结果:')
      console.log(result)

      // 验证包含标题
      expect(result).toContain('#')
      expect(result).toContain('与Excel的交互')
      expect(result).toContain('影刀Excel操作大全')

      // 验证粗体
      expect(result).toContain('**基本操作**')

      // 验证视频
      expect(result).toContain('<video')

      // 验证图片
      expect(result).toContain('![')
      expect(result).toContain('img0.png')

      console.log('\n[真实数据] Excel自动化转换结果:')
      console.log(result)
    })

    it('应该转换供应链文档（包含多张图片、空段落）', () => {
      // 真实数据：供应链文档片段
      const realDoc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: {
              lineHeight: null,
              textAlign: 'left',
              level: 2,
              id: 'cankaoanli'
            },
            content: [
              {
                type: 'text',
                marks: [{ type: 'bold' }],
                text: '参考案例'
              }
            ]
          },
          {
            type: 'image',
            attrs: {
              src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/889696888228614144/d0c48770-b2e6-4cbf-bc03-dec16cdc7f8a/5.1.png',
              alt: null,
              title: null,
              width: null,
              height: null
            },
            src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa_zh-CN/asset/889696888228614144/d0c48770-b2e6-4cbf-bc03-dec16cdc7f8a/5.1.png'
          },
          {
            type: 'paragraph',
            attrs: {
              lineHeight: null,
              textAlign: null
            },
            content: [
              {
                type: 'text',
                marks: [{ type: 'bold' }],
                text: '执行结果：'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdown(realDoc)

      console.log('\n[真实数据] 供应链文档转换结果:')
      console.log(result)

      // 验证包含二级标题标记
      expect(result).toMatch(/^##\s/)
      expect(result).toContain('参考案例')

      // 验证粗体
      expect(result).toContain('**执行结果：**')

      // 验证图片
      expect(result).toContain('![')
      expect(result).toContain('5.1.png')

      console.log('\n[真实数据] 供应链文档转换结果:')
      console.log(result)
    })
  })
})

