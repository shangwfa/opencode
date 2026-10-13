import type { GraphDB } from '../interface.js'
import type { CreateNodeInput, CreateEdgeInput } from '../types.js'

export interface CodeFileInfo {
  path: string
  language: string
}

export interface CodeGraphResult {
  nodes: number
  edges: number
  filesProcessed: number
}

/**
 * 轻量代码图提取器（对标 cognee tasks/code_graph 的简化版）
 *
 * 使用正则解析（零外部依赖），从源码中提取：
 * - CodeRepository 节点
 * - CodeFile 节点
 * - CodeModule（import 依赖）节点 + depends_on 边
 * - CodeFunction / CodeClass 节点 + contains 边
 */
export class CodeGraphExtractor {
  private graph: GraphDB

  constructor(graph: GraphDB) {
    this.graph = graph
  }

  async extractFromFiles(
    files: Array<{ path: string; content: string }>,
    options: { knowledgeBaseId: string; repositoryName?: string }
  ): Promise<CodeGraphResult> {
    const { knowledgeBaseId, repositoryName = 'default-repo' } = options
    let nodeCount = 0
    let edgeCount = 0

    // 仓库节点
    const repoId = await this.graph.addNode({
      knowledgeBaseId,
      name: repositoryName,
      type: 'code_repository',
      properties: { kind: 'CodeRepository' },
    })
    nodeCount++

    const fileIds = new Map<string, string>()
    const moduleDeps: Array<{ from: string; to: string }> = []

    for (const file of files) {
      const language = detectLanguage(file.path)

      // 文件节点
      const fileId = await this.graph.addNode({
        knowledgeBaseId,
        name: file.path,
        type: 'code_file',
        properties: { kind: 'CodeFile', language, path: file.path },
      })
      fileIds.set(file.path, fileId)
      nodeCount++

      // contains: repo → file
      await this.graph.addEdge({
        sourceId: repoId,
        targetId: fileId,
        relationshipName: 'contains',
        knowledgeBaseId,
      })
      edgeCount++

      // 提取 import 依赖
      const imports = extractImports(file.content, language)
      for (const imp of imports) {
        moduleDeps.push({ from: file.path, to: imp })
      }

      // 提取类
      for (const cls of extractClasses(file.content)) {
        const classId = await this.graph.addNode({
          knowledgeBaseId,
          name: cls,
          type: 'code_class',
          properties: { kind: 'CodeClass', file: file.path },
        })
        nodeCount++
        await this.graph.addEdge({
          sourceId: fileId,
          targetId: classId,
          relationshipName: 'contains',
          knowledgeBaseId,
        })
        edgeCount++
      }

      // 提取导出函数
      for (const fn of extractExportedFunctions(file.content, language)) {
        const fnId = await this.graph.addNode({
          knowledgeBaseId,
          name: fn,
          type: 'code_function',
          properties: { kind: 'CodeFunction', file: file.path },
        })
        nodeCount++
        await this.graph.addEdge({
          sourceId: fileId,
          targetId: fnId,
          relationshipName: 'contains',
          knowledgeBaseId,
        })
        edgeCount++
      }
    }

    // depends_on 边（文件 → 依赖模块）
    for (const dep of moduleDeps) {
      const fromId = fileIds.get(dep.from)
      if (!fromId) continue
      let toId = fileIds.get(dep.to)
      if (!toId) {
        // 外部模块节点
        toId = await this.graph.addNode({
          knowledgeBaseId,
          name: dep.to,
          type: 'code_module',
          properties: { kind: 'CodeModule', external: true },
        })
        nodeCount++
        fileIds.set(dep.to, toId)
      }
      await this.graph.addEdge({
        sourceId: fromId,
        targetId: toId,
        relationshipName: 'depends_on',
        knowledgeBaseId,
      })
      edgeCount++
    }

    return { nodes: nodeCount, edges: edgeCount, filesProcessed: files.length }
  }
}

function detectLanguage(path: string): string {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript'
  if (path.endsWith('.js') || path.endsWith('.jsx') || path.endsWith('.mjs')) return 'javascript'
  if (path.endsWith('.py')) return 'python'
  if (path.endsWith('.go')) return 'go'
  if (path.endsWith('.java')) return 'java'
  return 'unknown'
}

function extractImports(content: string, language: string): string[] {
  const results: string[] = []
  if (language === 'typescript' || language === 'javascript') {
    // import ... from '...' / require('...') / import '...'
    const re = /(?:import\s+[^'"]*from\s+|require\(\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) results.push(m[1])
  } else if (language === 'python') {
    const re = /(?:^|\n)\s*(?:import\s+(\S+)|from\s+(\S+)\s+import)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) results.push(m[1] || m[2])
  }
  return [...new Set(results)].slice(0, 50)
}

function extractClasses(content: string): string[] {
  const re = /(?:class|interface)\s+([A-Za-z_][\w]*)/g
  const results: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content))) results.push(m[1])
  return [...new Set(results)].slice(0, 50)
}

function extractExportedFunctions(content: string, language: string): string[] {
  const results: string[] = []
  if (language === 'typescript' || language === 'javascript') {
    const re = /export\s+(?:async\s+)?function\s+([A-Za-z_][\w]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) results.push(m[1])
    // export const foo = ...
    const re2 = /export\s+const\s+([A-Za-z_][\w]*)/g
    while ((m = re2.exec(content))) results.push(m[1])
  } else if (language === 'python') {
    const re = /def\s+([a-z_][\w]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) results.push(m[1])
  }
  return [...new Set(results)].slice(0, 50)
}