/**
 * 菜单树服务:CRUD / 兄弟链表排序 / 启停 / 建树
 * type=doc 的菜单创建时同步建立 documents 行(1:1,content 空、status=draft)
 */
import { and, eq, inArray } from "drizzle-orm"
import { db, documents, kbAliases, knowledgeBases, menus } from "../../db/index.js"
import { DocPlatformError, type CreateMenuRequest, type MenuTreeNode, type ReorderMenuRequest } from "../types.js"
import { buildMenuTree, computeLinkRemoval, validateMenuSlug, type MenuRowLike } from "../utils.js"
import { syncWorkerService } from "./sync-worker.service.js"

function newId(): string {
  return `${Date.now()}${Math.random().toString(36).substring(2, 8)}`
}

export class MenuService {
  /** 创建节点;doc 类型同步建 documents 行(status=draft,content 空) */
  async createMenu(kbId: string, request: CreateMenuRequest) {
    const kb = await this.assertKb(kbId)
    void kb

    if (request.type !== "folder" && request.type !== "doc") {
      throw new DocPlatformError("VALIDATION_ERROR", `type 非法: ${request.type}`)
    }
    if (request.slug) validateMenuSlug(request.slug)

    let parent: MenuRowLike | null = null
    if (request.parentId) {
      parent = await this.getMenuRow(kbId, request.parentId)
      if (parent.type !== "folder") {
        throw new DocPlatformError("VALIDATION_ERROR", "父节点只能是文件夹")
      }
    }
    if (request.previousId) {
      const previous = await this.getMenuRow(kbId, request.previousId)
      if ((previous.parentId ?? null) !== (request.parentId ?? null)) {
        throw new DocPlatformError("VALIDATION_ERROR", "previousId 与 parentId 不在同一层级")
      }
    }

    const id = newId()
    await db.insert(menus).values({
      id,
      knowledgeBaseId: kbId,
      parentId: request.parentId ?? null,
      previousId: request.previousId ?? null,
      name: request.name,
      type: request.type,
      iconUrl: request.iconUrl ?? null,
      slug: request.slug ?? null,
      enable: 1,
      docUniqueId: request.type === "doc" ? id : null,
    })

    if (request.type === "doc") {
      await db.insert(documents).values({
        id,
        knowledgeBaseId: kbId,
        content: "",
        type: "tiptap",
        status: "draft",
        menuId: id,
      })
    }

    return this.getMenuRow(kbId, id)
  }

  async updateMenu(kbId: string, menuId: string, patch: { name?: string; iconUrl?: string | null; slug?: string | null }) {
    await this.getMenuRow(kbId, menuId)
    if (patch.slug) validateMenuSlug(patch.slug)
    const [updated] = await db
      .update(menus)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.iconUrl !== undefined ? { iconUrl: patch.iconUrl } : {}),
        ...(patch.slug !== undefined ? { slug: patch.slug } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(menus.id, menuId), eq(menus.knowledgeBaseId, kbId)))
      .returning()
    return updated
  }

  /**
   * 拖拽排序(兄弟链表维护):
   * 1) 从旧链摘除:旧后继的 previous 指向旧前驱
   * 2) 插入新链:menu.previous = targetPrevious;原后继(previous=targetPrevious)改指 menu
   * 3) 环约束:targetParentId 不能是自己或自己的后代
   */
  async reorderMenu(kbId: string, request: ReorderMenuRequest) {
    const menu = await this.getMenuRow(kbId, request.menuId)

    // 后代集合(含自身),禁止移入自身子树
    const all = await this.listRows(kbId)
    const descendantIds = this.collectDescendants(all, menu.id)
    if (request.targetParentId && descendantIds.has(request.targetParentId)) {
      throw new DocPlatformError("VALIDATION_ERROR", "不能移动到自身或其后代之下")
    }
    if (request.targetPreviousId && descendantIds.has(request.targetPreviousId)) {
      throw new DocPlatformError("VALIDATION_ERROR", "不能移动到自身或其后代之后")
    }
    if (request.targetPreviousId) {
      const previous = await this.getMenuRow(kbId, request.targetPreviousId)
      if ((previous.parentId ?? null) !== (request.targetParentId ?? null)) {
        throw new DocPlatformError("VALIDATION_ERROR", "targetPreviousId 与 targetParentId 不在同一层级")
      }
    }

    const oldSiblings = all.filter(
      (r) => (r.parentId ?? null) === (menu.parentId ?? null) && r.id !== menu.id,
    )
    // 1) 摘除:旧后继接旧前驱
    for (const patch of computeLinkRemoval([...oldSiblings, menu], menu.id)) {
      await db.update(menus).set({ previousId: patch.previousId, updatedAt: new Date() }).where(eq(menus.id, patch.id))
    }
    // 2) 插入新链
    await db
      .update(menus)
      .set({ parentId: request.targetParentId ?? null, previousId: request.targetPreviousId ?? null, updatedAt: new Date() })
      .where(eq(menus.id, menu.id))
    // 3) 新位置原后继改指 menu
    const newSiblings = (await this.listRows(kbId)).filter(
      (r) => (r.parentId ?? null) === (request.targetParentId ?? null) && r.id !== menu.id,
    )
    const displaced = newSiblings.find((r) => r.previousId === (request.targetPreviousId ?? null))
    if (displaced) {
      await db
        .update(menus)
        .set({ previousId: menu.id, updatedAt: new Date() })
        .where(eq(menus.id, displaced.id))
    }
    return this.getMenuRow(kbId, menu.id)
  }

  async setEnable(kbId: string, menuId: string, enable: boolean) {
    await this.getMenuRow(kbId, menuId)
    await db
      .update(menus)
      .set({ enable: enable ? 1 : 0, updatedAt: new Date() })
      .where(eq(menus.id, menuId))
  }

  /** 删除子树:递归收集后代,级联删 documents(menus 删除后由 FK/清理处理)与别名;按启用模式写删除派生任务 */
  async deleteMenu(kbId: string, menuId: string) {
    const all = await this.listRows(kbId)
    if (!all.some((r) => r.id === menuId)) {
      throw new DocPlatformError("NOT_FOUND", `菜单不存在: ${menuId}`)
    }
    const ids = [...this.collectDescendants(all, menuId)]
    if (ids.length) {
      // 删除前确认哪些 id 是文档(有 documents 行),用于派生删除任务
      const docRows = await db
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.knowledgeBaseId, kbId), inArray(documents.menuId, ids)))

      await db.delete(documents).where(and(eq(documents.knowledgeBaseId, kbId), inArray(documents.menuId, ids)))
      await db.delete(kbAliases).where(and(eq(kbAliases.knowledgeBaseId, kbId), inArray(kbAliases.menuId, ids)))
      await db.delete(menus).where(and(eq(menus.knowledgeBaseId, kbId), inArray(menus.id, ids)))

      // 删除派生:每个文档×启用模式一份任务(delete 对不存在文档幂等)
      for (const doc of docRows) {
        await syncWorkerService.enqueueDocumentSync(kbId, doc.id, "delete", true)
      }
    }
  }

  /** 建树:管理端含禁用项;公开端仅 enable */
  async getTree(kbId: string, options: { includeDisabled?: boolean } = {}): Promise<MenuTreeNode[]> {
    await this.assertKb(kbId)
    const rows = await this.listRows(kbId)
    return buildMenuTree(rows, options)
  }

  // ── 内部 ──

  private async listRows(kbId: string): Promise<MenuRowLike[]> {
    return db
      .select({
        id: menus.id,
        parentId: menus.parentId,
        previousId: menus.previousId,
        name: menus.name,
        type: menus.type,
        iconUrl: menus.iconUrl,
        slug: menus.slug,
        enable: menus.enable,
        docUniqueId: menus.docUniqueId,
      })
      .from(menus)
      .where(eq(menus.knowledgeBaseId, kbId))
  }

  private async getMenuRow(kbId: string, menuId: string) {
    const [row] = await db
      .select()
      .from(menus)
      .where(and(eq(menus.id, menuId), eq(menus.knowledgeBaseId, kbId)))
      .limit(1)
    if (!row) throw new DocPlatformError("NOT_FOUND", `菜单不存在: ${menuId}`)
    return row
  }

  private async assertKb(kbId: string) {
    const [kb] = await db.select({ id: knowledgeBases.id }).from(knowledgeBases).where(eq(knowledgeBases.id, kbId)).limit(1)
    if (!kb) throw new DocPlatformError("NOT_FOUND", `知识库不存在: ${kbId}`)
    return kb
  }

  /** 收集后代(含自身) */
  private collectDescendants(rows: MenuRowLike[], rootId: string): Set<string> {
    const childrenByParent = new Map<string, MenuRowLike[]>()
    for (const row of rows) {
      const key = row.parentId ?? ""
      if (!childrenByParent.has(key)) childrenByParent.set(key, [])
      childrenByParent.get(key)!.push(row)
    }
    const result = new Set<string>([rootId])
    const stack = [rootId]
    while (stack.length) {
      const current = stack.pop()!
      for (const child of childrenByParent.get(current) ?? []) {
        if (!result.has(child.id)) {
          result.add(child.id)
          stack.push(child.id)
        }
      }
    }
    return result
  }
}
