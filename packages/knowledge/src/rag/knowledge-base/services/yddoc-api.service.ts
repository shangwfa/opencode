/**
 * 影刀文档API客户端服务
 * 用于从影刀文档系统获取菜单和文档内容
 */

interface MenuTreeNode {
  id: string
  name: string
  type: 'doc' | 'folder'
  docUniqueId: string
  menuTrees?: MenuTreeNode[]
}

interface MenuTreeResponse {
  data: MenuTreeNode[]
}

interface DocumentInfo {
  id: string
  name: string
  path: string        // 完整路径，如 "教程/快速开始/入门指南"
  parentPath: string  // 父级路径，如 "教程/快速开始"
}

/**
 * 重试配置
 */
interface RetryConfig {
  maxRetries: number
  retryDelay: number // 初始延迟（毫秒）
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelay: 1000 // 1秒
}

/**
 * 判断错误是否可重试
 */
function isRetryableError(error: any): boolean {
  // 网络错误
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true
  }

  // 5xx服务器错误
  if (error.response && error.response.status >= 500 && error.response.status < 600) {
    return true
  }

  // 临时性错误
  if (error.message && error.message.includes('timeout')) {
    return true
  }

  return false
}

/**
 * 延迟函数
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带重试的HTTP请求
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit = {},
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<Response> {
  let lastError: any

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 30000) // 30秒超时

      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      // 5xx错误，可以重试
      if (response.status >= 500 && response.status < 600) {
        if (attempt < retryConfig.maxRetries) {
          const delayMs = retryConfig.retryDelay * Math.pow(2, attempt) // 指数退避
          await delay(delayMs)
          continue
        }
      }

      // 4xx错误，不重试
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      return response
    } catch (error: any) {
      lastError = error

      // 如果是中止信号，不重试
      if (error.name === 'AbortError') {
        throw new Error('Request timeout after 30 seconds')
      }

      // 判断是否可重试
      if (isRetryableError(error) && attempt < retryConfig.maxRetries) {
        const delayMs = retryConfig.retryDelay * Math.pow(2, attempt) // 指数退避
        await delay(delayMs)
        continue
      }

      // 不可重试或已达到最大重试次数
      throw error
    }
  }

  throw lastError || new Error('Request failed after retries')
}

export class YddocApiService {
  private baseUrl: string
  private retryConfig: RetryConfig

  constructor(baseUrl: string = 'https://api.yingdao.com', retryConfig?: RetryConfig) {
    this.baseUrl = baseUrl
    this.retryConfig = retryConfig || DEFAULT_RETRY_CONFIG
  }

  /**
   * 获取文档菜单树
   * @param brandCode - 品牌代码（例如：'rpa'）
   * @param languageCode - 语言代码（例如：'zh-CN'）
   * @returns 菜单树JSON
   */
  async getMenuTree(brandCode: string, languageCode: string): Promise<MenuTreeNode[]> {
    const url = `${this.baseUrl}/api/noauth/v1/yddoc/menus/getMenuTreeByBrandCode?brandCode=${encodeURIComponent(
      brandCode
    )}&languageCode=${encodeURIComponent(languageCode)}`

    try {
      const response = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json, text/plain, */*'
          }
        },
        this.retryConfig
      )

      if (!response.ok) {
        throw new Error(`Failed to fetch menu tree: HTTP ${response.status}`)
      }

      const data: MenuTreeResponse = await response.json()

      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('Invalid menu tree response: missing data array')
      }

      return data.data
    } catch (error: any) {
      throw new Error(`Failed to get menu tree: ${error.message}`)
    }
  }

  /**
   * 获取文档内容
   * @param docId - 文档ID（docUniqueId）
   * @param brandCode - 品牌代码
   * @param languageCode - 语言代码
   * @returns Tiptap JSON格式的文档内容
   */
  async getDocumentContent(docId: string, brandCode: string, languageCode: string): Promise<any> {
    const knowledgeBaseId = `${brandCode}_${languageCode}`
    const url = `https://xybot-oss-cdn.yingdao.com/yddoc/${knowledgeBaseId}/doc/${docId}`

    try {
      const response = await fetchWithRetry(
        url,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json'
          }
        },
        this.retryConfig
      )

      if (!response.ok) {
        throw new Error(`Failed to fetch document content: HTTP ${response.status}`)
      }

      const data = await response.json()

      // 验证返回的数据是否是有效的Tiptap JSON
      if (!data || typeof data !== 'object' || data.type !== 'doc') {
        throw new Error('Invalid document content: not a valid Tiptap JSON')
      }

      return data
    } catch (error: any) {
      throw new Error(`Failed to get document content for docId ${docId}: ${error.message}`)
    }
  }

  /**
   * 递归遍历菜单树，提取所有文档ID（包含完整路径）
   * @param menuTree - 菜单树节点数组
   * @returns 文档ID数组（包含id、name和完整路径）
   */
  extractAllDocIds(menuTree: MenuTreeNode[]): DocumentInfo[] {
    const docIds: DocumentInfo[] = []

    function traverse(node: MenuTreeNode, parentPath: string = ''): void {
      // 构建当前节点的路径
      const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name

      // 如果是文档节点，添加到结果数组
      if (node.type === 'doc') {
        docIds.push({
          id: node.docUniqueId,
          name: node.name,
          path: currentPath,
          parentPath
        })
      }

      // 如果有子节点，递归遍历
      if (node.menuTrees && Array.isArray(node.menuTrees)) {
        node.menuTrees.forEach(child => {
          traverse(child, currentPath)
        })
      }
    }

    // 遍历所有根节点
    menuTree.forEach(node => traverse(node, ''))

    return docIds
  }
}
