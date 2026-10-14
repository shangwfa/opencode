/**
 * 知识库 HTTP 应用装配（hono）。
 *
 * createKnowledgeApp() 返回可独立运行、也可挂载到其它 hono 服务的子应用：
 *   /api/knowledge-base/**   知识库/文档/chunk/检索/同步
 *   /api/base-knowledge/**   base-knowledge 命名空间
 *   /api/database/**         数据表（表问答/行检索）
 *   /api/llm-wiki/**         Wiki 集合/编译/检索
 *   /api/graph/**            知识图谱（摄入/删除/检索/统计）
 *
 * 组织方式遵循 hono 官方最佳实践：每个业务域导出一个 Hono 子应用，
 * 本文件用 app.route(prefix, subApp) 挂载并导出 AppType（供 hono/client RPC 类型共享）。
 */
import { Hono } from "hono"
import { cors } from "hono/cors"
import { knowledgeBaseApp } from "./rag/knowledge-base/index.js"
import { baseKnowledgeApp } from "./rag/routes.js"
import { mountMcpRoutes } from "./mcp/http.js"
import { databaseApp } from "./data-table/routes/index.js"
import { llmWikiApp } from "./llm-wiki/routes/index.js"
import { graphApp } from "./graph/routes/index.js"
import { docPlatformApp } from "./doc-platform/index.js"

/** API 子应用:各业务域子应用按域前缀挂载（basePath 之下） */
export const api = new Hono()
  // 浏览器侧测试/工具页面（docs/ui-demos）直连所需；生产按需收紧 allowOrigin
  .use("*", cors())
  .route("/knowledge-base", knowledgeBaseApp)
  .route("/base-knowledge", baseKnowledgeApp)
  .route("/database", databaseApp)
  .route("/llm-wiki", llmWikiApp)
  .route("/graph", graphApp)
  .route("/doc-platform", docPlatformApp)

/** RPC 客户端类型：`hc<AppType>('http://host/api')` */
export type AppType = typeof api

export interface KnowledgeAppOptions {
  /** 路由前缀，默认 '/api' */
  basePath?: string
  /** 是否初始化数据库表（默认 true，独立服务场景） */
  initDatabase?: boolean
}

export async function createKnowledgeApp(options: KnowledgeAppOptions = {}): Promise<Hono> {
  const basePath = options.basePath ?? "/api"

  if (options.initDatabase !== false) {
    const [{ initDatabase }, { initDatabaseModule }, { initWikiTables }] = await Promise.all([
      import("./db/index.js"),
      import("./data-table/db/index.js"),
      import("./llm-wiki/db/index.js"),
    ])
    await initDatabase()
    await initDatabaseModule()
    await initWikiTables()
    const { wikiCompilerService } = await import('./llm-wiki/services/index.js')
    wikiCompilerService.startRecovery()

    // 文档平台:恢复残留的派生任务(进程崩溃/重启后 pending 任务重新消费)
    try {
      const { recoverPendingSyncTasks } = await import("./doc-platform/index.js")
      await recoverPendingSyncTasks()
    } catch (error: any) {
      console.warn("[knowledge] doc-platform 派生任务恢复失败:", error.message)
    }
  }

  const app = new Hono()

  app.get("/health", (c) => c.json({ code: 200, success: true, message: "ok", data: null }))

  app.route(basePath, api)

  // MCP Streamable HTTP 端点（无 basePath 前缀）：/mcp/kb-document-search
  mountMcpRoutes(app)

  app.onError((error, c) => {
    console.error("[knowledge] unhandled error:", error)
    return c.json(
      {
        code: 500,
        success: false,
        message: error.message || "Internal server error",
        data: null,
      },
      500,
    )
  })

  app.notFound((c) =>
    c.json(
      {
        code: 404,
        success: false,
        message: `Not Found: ${c.req.method} ${c.req.path}`,
        data: null,
      },
      404,
    ),
  )

  return app
}
