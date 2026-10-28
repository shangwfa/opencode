import { describe, it, expect, mock, spyOn, jest, beforeEach, afterEach } from 'bun:test'
import { YddocApiService } from './yddoc-api.service.js'

describe('YddocApiService', () => {
  let service: YddocApiService
  let fetchSpy: any

  beforeEach(() => {
    service = new YddocApiService()
    // Mock global fetch
    fetchSpy = spyOn(global, 'fetch')
  })

  afterEach(() => {
    mock.restore()
    jest.useRealTimers()
  })

  describe('getMenuTree', () => {
    it('应该成功获取菜单树', async () => {
      const mockMenuTree = {
        data: [
          {
            id: '1',
            name: '文档1',
            type: 'doc' as const,
            docUniqueId: '1',
            menuTrees: []
          }
        ]
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockMenuTree
      })

      const result = await service.getMenuTree('rpa', 'zh-CN')

      expect(result).toEqual(mockMenuTree.data)
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('brandCode=rpa'), expect.any(Object))
    })

    it('应该在网络错误时重试', async () => {
      const mockError = { code: 'ECONNRESET', message: 'Connection reset' }
      const mockResponse = {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      }

      // 第一次失败，第二次成功
      fetchSpy.mockRejectedValueOnce(mockError).mockResolvedValueOnce(mockResponse)

      const resultPromise = service.getMenuTree('rpa', 'zh-CN')

      // 等待重试延迟

      const result = await resultPromise

      expect(result).toEqual([])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('应该在5xx错误时重试', async () => {
      const mockResponse500 = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      }
      const mockResponse200 = {
        ok: true,
        status: 200,
        json: async () => ({ data: [] })
      }

      // 第一次500错误，第二次成功
      fetchSpy.mockResolvedValueOnce(mockResponse500).mockResolvedValueOnce(mockResponse200)

      const resultPromise = service.getMenuTree('rpa', 'zh-CN')

      // 等待重试延迟

      const result = await resultPromise

      expect(result).toEqual([])
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('应该在4xx错误时不重试', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found'
      }

      fetchSpy.mockResolvedValueOnce(mockResponse)

      await expect(service.getMenuTree('rpa', 'zh-CN')).rejects.toThrow()

      expect(fetchSpy).toHaveBeenCalledTimes(1)
    })

    it('应该处理超时', async () => {
      const abortError = new Error('Aborted')
      abortError.name = 'AbortError'

      fetchSpy.mockRejectedValueOnce(abortError)

      await expect(service.getMenuTree('rpa', 'zh-CN')).rejects.toThrow('Request timeout after 30 seconds')
    })

    it('应该处理无效响应（缺少data数组）', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}) // 缺少data字段
      })

      await expect(service.getMenuTree('rpa', 'zh-CN')).rejects.toThrow('Invalid menu tree response')
    })

    it('应该处理response.ok为false的情况', async () => {
      // 5xx错误会重试，但最终会失败（因为response.ok为false，getMenuTree会检查response.ok）
      // 使用自定义重试配置，减少重试次数和延迟，加快测试速度
      const customService = new YddocApiService('https://api.yingdao.com', {
        maxRetries: 1, // 只重试1次
        retryDelay: 10 // 10ms延迟
      })

      const mockResponse500 = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      }

      // 重试1次后仍然返回500错误
      fetchSpy.mockResolvedValueOnce(mockResponse500).mockResolvedValueOnce(mockResponse500)

      await expect(customService.getMenuTree('rpa', 'zh-CN')).rejects.toThrow('Failed to get menu tree')
    })

    it('应该处理5xx错误（通过response.status判断）', async () => {
      // 测试fetchWithRetry中的5xx错误处理，它会重试
      // 使用自定义重试配置，减少重试次数和延迟
      const customService = new YddocApiService('https://api.yingdao.com', {
        maxRetries: 1, // 只重试1次
        retryDelay: 10 // 10ms延迟
      })

      const mockResponse500 = {
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      }

      // 重试1次后仍然返回500错误，最终会失败
      fetchSpy.mockResolvedValueOnce(mockResponse500).mockResolvedValueOnce(mockResponse500)

      await expect(customService.getMenuTree('rpa', 'zh-CN')).rejects.toThrow('Failed to get menu tree')
    })

    it('应该处理timeout错误（通过error.message判断）', async () => {
      // 测试isRetryableError中的timeout错误判断
      // 使用自定义重试配置，减少重试次数和延迟
      const customService = new YddocApiService('https://api.yingdao.com', {
        maxRetries: 1, // 只重试1次
        retryDelay: 10 // 10ms延迟
      })

      const mockError = {
        message: 'Request timeout' // 包含'timeout'，会被isRetryableError识别为可重试
      }

      // 重试1次后仍然失败
      fetchSpy.mockRejectedValueOnce(mockError).mockRejectedValueOnce(mockError)

      await expect(customService.getMenuTree('rpa', 'zh-CN')).rejects.toThrow('Failed to get menu tree')
    })
  })

  describe('getDocumentContent', () => {
    it('应该成功获取文档内容', async () => {
      const mockTiptapJson = {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '测试内容' }]
          }
        ]
      }

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockTiptapJson
      })

      const result = await service.getDocumentContent('123', 'rpa', 'zh-CN')

      expect(result).toEqual(mockTiptapJson)
      expect(fetchSpy).toHaveBeenCalledWith(expect.stringContaining('rpa_zh-CN'), expect.any(Object))
    })

    it('应该在失败时重试', async () => {
      const mockError = { code: 'ETIMEDOUT', message: 'Timeout' }
      const mockTiptapJson = {
        type: 'doc',
        content: []
      }

      fetchSpy.mockRejectedValueOnce(mockError).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockTiptapJson
      })

      const resultPromise = service.getDocumentContent('123', 'rpa', 'zh-CN')


      const result = await resultPromise

      expect(result).toEqual(mockTiptapJson)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    it('应该处理无效Tiptap JSON（缺少type字段）', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ content: [] }) // 缺少type字段
      })

      await expect(service.getDocumentContent('123', 'rpa', 'zh-CN')).rejects.toThrow('Invalid document content')
    })

    it('应该处理无效Tiptap JSON（type不是doc）', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ type: 'not-doc' })
      })

      await expect(service.getDocumentContent('123', 'rpa', 'zh-CN')).rejects.toThrow('Invalid document content')
    })

    it('应该处理response.ok为false的情况', async () => {
      // 4xx错误不重试，直接失败
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      })

      await expect(service.getDocumentContent('123', 'rpa', 'zh-CN')).rejects.toThrow('Failed to get document content')
    })
  })

  describe('extractAllDocIds', () => {
    it('应该提取单个文档ID', () => {
      const menuTree = [
        {
          id: '1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        }
      ]

      const result = service.extractAllDocIds(menuTree)

      expect(result).toEqual([{ id: 'doc1', name: '文档1', path: '文档1', parentPath: '' }])
    })

    it('应该提取嵌套文件夹中的文档ID', () => {
      const menuTree = [
        {
          id: 'folder1',
          name: '文件夹1',
          type: 'folder' as const,
          docUniqueId: 'folder1',
          menuTrees: [
            {
              id: 'doc1',
              name: '文档1',
              type: 'doc' as const,
              docUniqueId: 'doc1',
              menuTrees: []
            },
            {
              id: 'doc2',
              name: '文档2',
              type: 'doc' as const,
              docUniqueId: 'doc2',
              menuTrees: []
            }
          ]
        }
      ]

      const result = service.extractAllDocIds(menuTree)

      expect(result).toEqual([
        { id: 'doc1', name: '文档1', path: '文件夹1/文档1', parentPath: '文件夹1' },
        { id: 'doc2', name: '文档2', path: '文件夹1/文档2', parentPath: '文件夹1' }
      ])
    })

    it('应该处理空菜单树', () => {
      const result = service.extractAllDocIds([])

      expect(result).toEqual([])
    })

    it('应该处理混合doc和folder节点', () => {
      const menuTree = [
        {
          id: 'doc1',
          name: '文档1',
          type: 'doc' as const,
          docUniqueId: 'doc1',
          menuTrees: []
        },
        {
          id: 'folder1',
          name: '文件夹1',
          type: 'folder' as const,
          docUniqueId: 'folder1',
          menuTrees: [
            {
              id: 'doc2',
              name: '文档2',
              type: 'doc' as const,
              docUniqueId: 'doc2',
              menuTrees: []
            }
          ]
        },
        {
          id: 'doc3',
          name: '文档3',
          type: 'doc' as const,
          docUniqueId: 'doc3',
          menuTrees: []
        }
      ]

      const result = service.extractAllDocIds(menuTree)

      expect(result).toEqual([
        { id: 'doc1', name: '文档1', path: '文档1', parentPath: '' },
        { id: 'doc2', name: '文档2', path: '文件夹1/文档2', parentPath: '文件夹1' },
        { id: 'doc3', name: '文档3', path: '文档3', parentPath: '' }
      ])
    })

    it('应该处理深层嵌套结构', () => {
      const menuTree = [
        {
          id: 'folder1',
          name: '文件夹1',
          type: 'folder' as const,
          docUniqueId: 'folder1',
          menuTrees: [
            {
              id: 'folder2',
              name: '文件夹2',
              type: 'folder' as const,
              docUniqueId: 'folder2',
              menuTrees: [
                {
                  id: 'doc1',
                  name: '文档1',
                  type: 'doc' as const,
                  docUniqueId: 'doc1',
                  menuTrees: []
                }
              ]
            }
          ]
        }
      ]

      const result = service.extractAllDocIds(menuTree)

      expect(result).toEqual([{ id: 'doc1', name: '文档1', path: '文件夹1/文件夹2/文档1', parentPath: '文件夹1/文件夹2' }])
    })
  })
})
