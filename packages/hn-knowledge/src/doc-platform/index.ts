/**
 * 文档平台子应用挂载入口
 *   /kb-admin/**   管理写(鉴权后置)
 *   /kb/**         公开读(私密库 404)
 *   /open/**       (M2)book-open 契约:文档编辑 REST/MCP 的后端实现位
 */
import { Hono } from "hono"
import { kbAdminApp } from "./routes/admin.routes.js"
import { kbPublicApp } from "./routes/public.routes.js"
import { openApp } from "./open/open.routes.js"
import { compatApp } from "./compat/compat.routes.js"
import { syncWorkerService } from "./services/sync-worker.service.js"

export const docPlatformApp = new Hono()
  .route("/kb-admin", kbAdminApp)
  .route("/", kbPublicApp)
  .route("/", openApp)
  .route("/compat", compatApp)

/** 服务启动后调用:恢复残留的派生任务(幂等) */
export async function recoverPendingSyncTasks(): Promise<number> {
  return syncWorkerService.recoverPendingTasks()
}

export { KbService } from "./services/kb.service.js"
export { MenuService } from "./services/menu.service.js"
export { DocumentService } from "./services/document.service.js"
export { OpenDocumentService } from "./open/open-document.service.js"
export { DocPlatformError } from "./types.js"
export { buildMenuTree, extractPlainText, validateKbSlug } from "./utils.js"
