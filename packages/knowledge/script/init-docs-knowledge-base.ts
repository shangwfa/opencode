import 'dotenv/config'
import { readdir, readFile, stat } from 'fs/promises'
import { join, relative } from 'path'
import { createHash } from 'crypto'

// 加载环境变量（dotenv/config，必须在导入服务之前）

const DOCS_DIR = join(process.cwd(), 'docs')
const KB_NAME = '影刀文档知识库'
const KB_DESCRIPTION = '基于 docs 文件夹创建的影刀产品文档知识库'

/**
 * 递归获取所有 .md 文件
 */
async function getAllMarkdownFiles(
  dir: string,
  baseDir: string = dir
): Promise<Array<{ path: string; relativePath: string; category: string }>> {
  const files: Array<{ path: string; relativePath: string; category: string }> = []

  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        // 递归处理子目录
        const subFiles = await getAllMarkdownFiles(fullPath, baseDir)
        files.push(...subFiles)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // 获取相对路径
        const relativePath = relative(baseDir, fullPath)

        // 根据路径确定分类
        let category = '其他'
        if (relativePath.includes('产品介绍')) {
          category = '产品介绍'
        } else if (relativePath.includes('快速入门')) {
          category = '快速入门'
        } else if (relativePath.includes('管理文档')) {
          category = '管理文档'
        }

        files.push({
          path: fullPath,
          relativePath,
          category
        })
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error)
  }

  return files
}

/**
 * 根据名称查找知识库
 */
async function findKnowledgeBaseByName(name: string, knowledgeBaseService: any): Promise<string | null> {
  const kbs = await knowledgeBaseService.listKnowledgeBases()
  const kb = kbs.find((kb: any) => kb.name === name)
  return kb ? kb.id : null
}

/**
 * 主函数
 */
async function main() {
  try {
    // 动态导入服务（在环境变量加载后）
    const { knowledgeBaseService, documentService } = await import('../src/rag/knowledge-base/index.js')

    console.log('开始初始化文档知识库...')
    console.log(`文档目录: ${DOCS_DIR}`)

    // 检查文档目录是否存在
    try {
      const stats = await stat(DOCS_DIR)
      if (!stats.isDirectory()) {
        throw new Error(`${DOCS_DIR} 不是一个目录`)
      }
    } catch (error) {
      throw new Error(`文档目录不存在: ${DOCS_DIR}`)
    }

    // 获取所有 Markdown 文件
    console.log('正在扫描 Markdown 文件...')
    const mdFiles = await getAllMarkdownFiles(DOCS_DIR)
    console.log(`找到 ${mdFiles.length} 个 Markdown 文件`)

    if (mdFiles.length === 0) {
      console.log('未找到任何 Markdown 文件，退出')
      return
    }

    // 检查知识库是否存在
    let kbId = await findKnowledgeBaseByName(KB_NAME, knowledgeBaseService)

    if (kbId) {
      console.log(`知识库 "${KB_NAME}" 已存在 (ID: ${kbId})`)
      console.log('正在删除现有知识库以重新初始化...')
      try {
        await knowledgeBaseService.deleteKnowledgeBase(kbId)
        console.log('✓ 现有知识库已删除')
      } catch (error: any) {
        console.error('删除知识库失败:', error.message)
        throw error
      }
    }

    // 创建新知识库
    console.log(`正在创建知识库 "${KB_NAME}"...`)
    const kb = await knowledgeBaseService.createKnowledgeBase({
      name: KB_NAME,
      description: KB_DESCRIPTION,
      embeddingModel: 'openai/text-embedding-3-small',
      defaultChunkStrategy: 'markdown',
      defaultChunkConfig: {
        maxSize: 512,
        overlap: 50
      }
    })
    kbId = kb.id
    console.log(`知识库创建成功 (ID: ${kbId})`)

    // 批量导入文档
    console.log('\n开始导入文档...')
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < mdFiles.length; i++) {
      const file = mdFiles[i]
      try {
        // 读取文件内容
        const content = await readFile(file.path, 'utf-8')

        // 使用相对路径的哈希值作为文档 ID，避免中文字符导致的ID冲突
        // 使用 SHA256 的前16个字符作为ID，确保唯一性
        const pathHash = createHash('sha256').update(file.relativePath).digest('hex').substring(0, 16)
        const docId = `doc_${pathHash}`

        // 创建文档 metadata
        const metadata = {
          filePath: file.relativePath,
          category: file.category,
          fileName: file.path.split(/[/\\]/).pop() || 'unknown.md'
        }

        // 检查文档是否已存在
        const existingDoc = await knowledgeBaseService.getDocument(docId)

        if (existingDoc) {
          // 检查文件内容是否已更新（通过比较内容哈希）
          const contentHash = createHash('sha256').update(content).digest('hex')
          const existingContentHash = existingDoc.metadata?.contentHash

          if (existingContentHash === contentHash) {
            console.log(`[${i + 1}/${mdFiles.length}] 跳过未变更的文档: ${file.relativePath}`)
            continue
          } else {
            // 文档内容已更新，需要重新处理
            console.log(`[${i + 1}/${mdFiles.length}] 检测到文档更新，重新处理: ${file.relativePath}...`)

            // 先更新文档记录（包括内容和metadata）
            await knowledgeBaseService.updateDocument(
              docId,
              content,
              'markdown',
              'markdown',
              {
                maxSize: 512,
                overlap: 50
              },
              {
                ...metadata,
                contentHash
              }
            )

            // 重新处理文档：删除旧向量，重新分块、生成嵌入、存储向量
            // documentService.updateDocument 会删除旧向量并重新处理
            console.log(`[${i + 1}/${mdFiles.length}] 正在重新处理向量: ${file.relativePath}...`)
            const { chunkCount } = await documentService.updateDocument(
              kbId!,
              docId,
              content,
              'markdown',
              'markdown',
              {
                maxSize: 512,
                overlap: 50
              },
              {
                ...metadata,
                contentHash
              }
            )

            // 更新文档的块数量
            await knowledgeBaseService.updateDocumentChunkCount(docId, chunkCount)

            console.log(`[${i + 1}/${mdFiles.length}] ✓ 更新完成: ${file.relativePath} (${chunkCount} 个块)`)
            successCount++
            continue
          }
        }

        // 创建新文档记录
        const contentHash = createHash('sha256').update(content).digest('hex')
        const doc = await knowledgeBaseService.createDocument(
          kbId!,
          content,
          'markdown',
          'markdown',
          {
            maxSize: 512,
            overlap: 50
          },
          {
            ...metadata,
            contentHash
          },
          docId
        )

        // 处理文档：分块、生成嵌入、存储向量
        console.log(`[${i + 1}/${mdFiles.length}] 正在处理: ${file.relativePath}...`)
        const { chunkCount } = await documentService.processDocument(
          kbId!,
          content,
          doc.id,
          'markdown',
          'markdown',
          {
            maxSize: 512,
            overlap: 50
          },
          {
            ...metadata,
            contentHash
          }
        )

        // 更新文档的块数量
        await knowledgeBaseService.updateDocumentChunkCount(doc.id, chunkCount)

        console.log(`[${i + 1}/${mdFiles.length}] ✓ 完成: ${file.relativePath} (${chunkCount} 个块)`)
        successCount++
      } catch (error: any) {
        console.error(`[${i + 1}/${mdFiles.length}] ✗ 失败: ${file.relativePath}`)
        console.error(`错误信息: ${error.message}`)
        if (error.stack) {
          console.error(`错误堆栈: ${error.stack.split('\n').slice(0, 3).join('\n')}`)
        }
        failCount++
      }
    }

    console.log('\n导入完成!')
    console.log(`成功: ${successCount} 个文档`)
    console.log(`失败: ${failCount} 个文档`)
    console.log(`知识库 ID: ${kbId}`)
  } catch (error: any) {
    console.error('初始化失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  }
}

// 运行主函数
main()
