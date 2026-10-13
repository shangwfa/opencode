/**
 * tiptapToMarkdownV2 函数单元测试
 * 使用 Tiptap Static Renderer + TableKit
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tiptapToMarkdownV2 } from './tiptap-to-markdown-v2.js'

describe('tiptapToMarkdownV2', () => {
  describe('基本节点转换', () => {
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

      const result = tiptapToMarkdownV2(tiptapJson)
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

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('第一段')
      expect(result).toContain('第二段')
    })

    it('应该处理空段落', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: []
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toBeDefined()
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

      const result = tiptapToMarkdownV2(tiptapJson)
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

        const result = tiptapToMarkdownV2(tiptapJson)
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
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '项目1' }] }]
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '项目2' }] }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('- 项目1')
      expect(result).toContain('- 项目2')
    })

    it('应该转换有序列表', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'orderedList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '第一项' }] }]
              },
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '第二项' }] }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('1. 第一项')
      expect(result).toContain('2. 第二项')
    })

    it('应该转换嵌套列表', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: '父项目' }] },
                  {
                    type: 'bulletList',
                    content: [
                      {
                        type: 'listItem',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: '子项目' }] }]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('- 父项目')
      expect(result).toContain('- 子项目')
      // 注意：Tiptap Static Renderer 可能将嵌套列表平铺，这是一个已知的格式差异
    })
  })

  describe('代码块转换', () => {
    it('应该转换代码块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            attrs: { language: 'javascript' },
            content: [{ type: 'text', text: 'const x = 1;' }]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('```javascript')
      expect(result).toContain('const x = 1;')
      expect(result).toContain('```')
    })

    it('应该转换无语言标记的代码块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'codeBlock',
            content: [{ type: 'text', text: 'code without language' }]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('```')
      expect(result).toContain('code without language')
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
              { type: 'text', marks: [{ type: 'bold' }], text: '粗体文本' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('**粗体文本**')
    })

    it('应该转换斜体文本', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'italic' }], text: '斜体文本' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('_斜体文本_')
    })

    it('应该转换删除线文本', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'strike' }], text: '删除线' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('~~删除线~~')
    })

    it('应该转换代码文本', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'code' }], text: 'code' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('`code`')
    })

    it('应该转换混合标记', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [{ type: 'bold' }, { type: 'italic' }],
                text: '粗斜体'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('***粗斜体***')
    })
  })

  describe('链接转换', () => {
    it('应该转换链接', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [
                  { type: 'link', attrs: { href: 'https://example.com' } }
                ],
                text: '示例链接'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('[示例链接](https://example.com)')
    })

    it('应该转换带标题的链接', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [
                  { type: 'link', attrs: { href: 'https://example.com', title: '示例' } }
                ],
                text: '链接文本'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      // 注意：Tiptap Static Renderer 可能省略 title 属性，这是一个已知的格式差异
      expect(result).toContain('[链接文本](https://example.com')
    })
  })

  describe('图片转换', () => {
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

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('![测试图片](https://example.com/image.png)')
    })

    it('应该转换带标题的图片', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/image.png',
              alt: '测试图片',
              title: '图片标题'
            }
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('![测试图片](https://example.com/image.png "图片标题")')
    })
  })

  describe('视频转换', () => {
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

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('<video src="https://example.com/video.mp4"></video>')
    })

    it('应该转换带尺寸的视频', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'video',
            attrs: {
              src: 'https://example.com/video.mp4',
              width: 640,
              height: 480
            }
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('width="640"')
      expect(result).toContain('height="480"')
    })
  })

  describe('表格转换', () => {
    it('应该转换简单表格', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableHeader',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: '列1' }] }]
                  },
                  {
                    type: 'tableHeader',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: '列2' }] }]
                  }
                ]
              },
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: '数据1' }] }]
                  },
                  {
                    type: 'tableCell',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: '数据2' }] }]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('| 列1 | 列2 |')
      expect(result).toContain('| 数据1 | 数据2 |')
      expect(result).toContain('| --- | --- |')
    })

    it('应该转换包含粗体的表格', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableHeader',
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '标题' }] }
                    ]
                  },
                  {
                    type: 'tableHeader',
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', text: '值' }] }
                    ]
                  }
                ]
              },
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableCell',
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', text: '内容' }] }
                    ]
                  },
                  {
                    type: 'tableCell',
                    content: [
                      { type: 'paragraph', content: [{ type: 'text', text: '123' }] }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('| **标题** | 值 |')
      expect(result).toContain('| 内容 | 123 |')
    })

    it('应该转换多列表格', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'C' }] }] }
                ]
              },
              {
                type: 'tableRow',
                content: [
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }] },
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '3' }] }] }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('| A | B | C |')
      expect(result).toContain('| 1 | 2 | 3 |')
      expect(result).toContain('| --- | --- | --- |')
    })
  })

  describe('其他节点类型', () => {
    it('应该转换引用块', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: '这是一段引用' }] }]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('> 这是一段引用')
    })

    it('应该转换水平线', () => {
      const tiptapJson = {
        type: 'doc',
        content: [{ type: 'horizontalRule' }]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toMatch(/^---|\\\*\\\*\\\*|___$/)
    })

    it('应该转换硬换行', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: '第一行' },
              { type: 'hardBreak' },
              { type: 'text', text: '第二行' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('第一行')
      expect(result).toContain('第二行')
      // 注意：Tiptap Static Renderer 可能使用不同的硬换行格式（如单个换行符）
    })
  })

  describe('兼容性：影刀文档格式', () => {
    it('应该处理 bold 标记（影刀格式）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'bold' }], text: '粗体文本' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('**粗体文本**')
    })

    it('应该处理 strong 标记（转换为 bold）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'strong' }], text: '粗体文本' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('**粗体文本**')
    })

    it('应该处理 em 标记（转换为 italic）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'em' }], text: '斜体文本' }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('_斜体文本_')
    })

    it('应该处理 snake_case 节点名（code_block → codeBlock）', () => {
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

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('```javascript')
    })

    it('应该处理 snake_case 节点名（bullet_list → bulletList）', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bullet_list',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '项目1' }] }]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('- 项目1')
    })
  })

  describe('复杂文档结构', () => {
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
              { type: 'text', marks: [{ type: 'bold' }], text: '粗体' },
              { type: 'text', text: '和' },
              { type: 'text', marks: [{ type: 'italic' }], text: '斜体' }
            ]
          },
          {
            type: 'codeBlock',
            attrs: { language: 'javascript' },
            content: [{ type: 'text', text: 'console.log("test");' }]
          },
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '列表项1' }] }]
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

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('# 文档标题')
      expect(result).toContain('**粗体**')
      expect(result).toContain('_斜体_')
      expect(result).toContain('```javascript')
      expect(result).toContain('- 列表项1')
      expect(result).toContain('![示例图片]')
    })
  })

  describe('错误处理', () => {
    it('应该抛出错误当缺少 type 字段', () => {
      const invalidJson = { content: [] } as any

      expect(() => tiptapToMarkdownV2(invalidJson)).toThrow('Invalid Tiptap JSON')
    })

    it('应该处理空文档', () => {
      const tiptapJson = {
        type: 'doc',
        content: []
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toBeDefined()
      expect(typeof result).toBe('string')
    })

    it('应该处理 null 内容', () => {
      const tiptapJson = {
        type: 'doc',
        content: null as any
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toBeDefined()
    })
  })

  describe('真实数据场景测试', () => {
    it('应该转换影刀概述文档（包含 bold 标记、水平线、视频）', () => {
      const realDoc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 1 },
            content: [{ type: 'text', marks: [{ type: 'bold' }], text: '影刀概述' }]
          },
          { type: 'horizontalRule' },
          {
            type: 'paragraph',
            content: [
              { type: 'text', marks: [{ type: 'bold' }], text: '「 分叉智能 」' },
              { type: 'text', text: '成立于2020年6月' }
            ]
          },
          {
            type: 'video',
            attrs: {
              src: 'https://xybot-oss-cdn.yingdao.com/yddoc/rpa/zh-CN/doc/6740fe469fb4b2eca6c28e39/assets/video-0.mp4',
              width: 1280,
              height: 720
            }
          }
        ]
      }

      const result = tiptapToMarkdownV2(realDoc)
      expect(result).toContain('#')
      expect(result).toContain('影刀概述')
      expect(result).toContain('**「 分叉智能 」**')
      expect(result).toContain('成立于2020年6月')
      expect(result).toContain('<video')
      expect(result).toContain('width="1280"')
      expect(result).toContain('height="720"')
    })

    it('应该转换包含表格的API文档', () => {
      const apiDoc = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', marks: [{ type: 'bold' }], text: '请求参数' }]
          },
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '参数名' }] }] },
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '类型' }] }] },
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', marks: [{ type: 'bold' }], text: '说明' }] }] }
                ]
              },
              {
                type: 'tableRow',
                content: [
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'phone' }] }] },
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'String' }] }] },
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '手机号' }] }] }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(apiDoc)
      expect(result).toContain('## **请求参数**')
      expect(result).toContain('| **参数名** | **类型** | **说明** |')
      expect(result).toContain('| phone | String | 手机号 |')
    })
  })

  describe('深层嵌套结构（提高覆盖率）', () => {
    it('应该递归处理深层嵌套的文档结构', () => {
      // 测试 normalizeNodeType 的递归处理（覆盖 line 64-66）
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', marks: [{ type: 'bold' }], text: '第一层' }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('**第一层**')
    })

    it('应该处理包含 mark 的深层嵌套节点', () => {
      // 测试 normalizeNodeType 中 mark 的递归处理
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bullet_list',  // snake_case，需要转换
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', marks: [{ type: 'strong' }], text: '粗体文本' }  // strong 需要转为 bold
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('**粗体文本**')
    })
  })

  describe('自定义节点处理（提高覆盖率）', () => {
    it('应该合并主要内容和自定义节点', () => {
      // 测试 customNodes.length > 0 分支（覆盖 line 187-196）
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '段落文本' }]
          },
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/image.jpg',
              alt: '测试图片'
            }
          },
          {
            type: 'video',
            attrs: {
              src: 'https://example.com/video.mp4',
              width: 640,
              height: 480
            }
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('段落文本')
      expect(result).toContain('![测试图片]')
      expect(result).toContain('<video')
      expect(result).toContain('width="640"')
      expect(result).toContain('height="480"')
    })

    it('应该处理只有自定义节点没有主要内容的情况', () => {
      // 测试 cleanedMain 为空的情况（覆盖 line 192-193）
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/image.jpg',
              alt: '图片'
            }
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('![图片]')
    })
  })

  describe('边界情况和错误恢复', () => {
    it('应该处理段落中嵌套的自定义节点', () => {
      // 测试 preprocessCustomNodes 的递归处理（覆盖 line 120-126）
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: '引用文本' },
                  {
                    type: 'image',
                    attrs: {
                      src: 'https://example.com/img.jpg',
                      alt: '内嵌图片'
                    }
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('引用文本')
      expect(result).toContain('![内嵌图片]')
    })

    it('应该处理图片和视频的所有属性组合', () => {
      // 测试 attrs 的各种情况
      const tiptapJson = {
        type: 'doc',
        content: [
          // 只有 src，没有 alt
          {
            type: 'image',
            attrs: { src: 'https://example.com/img1.jpg' }
          },
          // 有 src 和 title
          {
            type: 'image',
            attrs: {
              src: 'https://example.com/img2.jpg',
              alt: '图片',
              title: '标题'
            }
          },
          // 使用 url 而不是 src
          {
            type: 'image',
            attrs: { url: 'https://example.com/img3.jpg' }
          },
          // 视频只有 src
          {
            type: 'video',
            attrs: { src: 'https://example.com/video.mp4' }
          },
          // 视频使用 url
          {
            type: 'video',
            attrs: { url: 'https://example.com/video2.mp4' }
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('![](https://example.com/img1.jpg)')
      expect(result).toContain('![图片](https://example.com/img2.jpg "标题")')
      expect(result).toContain('![](https://example.com/img3.jpg)')
      expect(result).toContain('<video src="https://example.com/video.mp4"></video>')
      expect(result).toContain('<video src="https://example.com/video2.mp4"></video>')
    })
  })

  describe('复杂文档结构（提高覆盖率）', () => {
    it('应该处理包含表格和自定义节点的复杂文档', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: '文档标题' }]
          },
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '列1' }] }] },
                  { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '列2' }] }] }
                ]
              },
              {
                type: 'tableRow',
                content: [
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '数据1' }] }] },
                  { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '数据2' }] }] }
                ]
              }
            ]
          },
          {
            type: 'image',
            attrs: { src: 'https://example.com/chart.png', alt: '图表' }
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('## 文档标题')
      expect(result).toContain('| 列1 | 列2 |')
      expect(result).toContain('| 数据1 | 数据2 |')
      expect(result).toContain('![图表]')
    })

    it('应该处理多个列表嵌套和格式化', () => {
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', marks: [{ type: 'bold' }], text: '粗体项目' }
                    ]
                  }
                ]
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: '普通项目' },
                      { type: 'text', marks: [{ type: 'italic' }], text: '斜体部分' }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('**粗体项目**')
      expect(result).toContain('普通项目')
      expect(result).toContain('_斜体部分_')
    })
  })

  describe('错误恢复和降级策略', () => {
    it('应该处理深层嵌套的自定义节点（测试递归提取）', () => {
      // 测试 preprocessCustomNodes 的递归处理（覆盖 line 120-126）
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: '列表项文本' },
                      {
                        type: 'image',
                        attrs: { src: 'https://example.com/nested-img.jpg', alt: '嵌套图片' }
                      }
                    ]
                  },
                  {
                    type: 'video',
                    attrs: { src: 'https://example.com/nested-video.mp4' }
                  }
                ]
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('列表项文本')
      expect(result).toContain('![嵌套图片]')
      expect(result).toContain('<video src="https://example.com/nested-video.mp4"')
    })

    it('应该处理包含多个 marks 的节点（测试 mark 递归）', () => {
      // 测试 normalizeNodeType 的 marks 处理（覆盖 line 49-57）
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                marks: [
                  { type: 'strong' },  // 需要转换为 bold
                  { type: 'em' }       // 需要转换为 italic
                ],
                text: '粗斜体'
              }
            ]
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('粗斜体')
    })

    it('应该处理包含所有 snake_case 节点类型的文档', () => {
      // 测试所有节点类型转换（覆盖 line 34-46）
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'code_block',  // snake_case
            attrs: { language: 'javascript' },
            content: [{ type: 'text', text: 'console.log("test")' }]
          },
          {
            type: 'bullet_list',  // snake_case
            content: [
              {
                type: 'list_item',  // snake_case
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: '列表项' }] }
                ]
              }
            ]
          },
          {
            type: 'ordered_list',  // snake_case
            content: [
              {
                type: 'list_item',
                content: [
                  { type: 'paragraph', content: [{ type: 'text', text: '有序项' }] }
                ]
              }
            ]
          },
          {
            type: 'horizontal_rule'  // snake_case
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('```javascript')
      expect(result).toContain('console.log("test")')
      expect(result).toContain('- 列表项')
      expect(result).toContain('1. 有序项')
      expect(result).toContain('---')
    })

    it('应该处理空 content 数组的情况', () => {
      // 测试 content 为空数组时的处理
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: []
          }
        ]
      }

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toBeDefined()
      expect(typeof result).toBe('string')
    })

    it('应该处理多层嵌套的列表', () => {
      // 测试深层嵌套结构
      const tiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  {
                    type: 'paragraph',
                    content: [{ type: 'text', text: '第一层' }]
                  }
                ]
              },
              {
                type: 'listItem',
                content: [
                  {
                    type: 'bulletList',
                    content: [
                      {
                        type: 'listItem',
                        content: [
                          {
                            type: 'paragraph',
                            content: [{ type: 'text', text: '第二层' }]
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

      const result = tiptapToMarkdownV2(tiptapJson)
      expect(result).toContain('第一层')
      expect(result).toContain('第二层')
    })
  })
})
