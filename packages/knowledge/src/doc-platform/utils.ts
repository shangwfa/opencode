/**
 * 文档平台纯函数工具(slug 校验/建树/兄弟链表/纯文本提取)
 * 与 DB 解耦,可独立单测
 */
import { DocPlatformError, type MenuTreeNode } from "./types.js"

/** 知识库 slug 保留字(与公开路由/系统路径冲突的段) */
export const KB_SLUG_RESERVED = new Set([
  "api",
  "kb",
  "admin",
  "static",
  "public",
  "_next",
  "favicon.ico",
  "open",
  "mcp",
  "assets",
  "docs",
  "help",
])

/** 知识库 slug 校验:先保留字(优先级高),再格式:3-64 位,小写字母/数字开头,可含连字符 */
export function validateKbSlug(slug: string): void {
  if (KB_SLUG_RESERVED.has(slug)) {
    throw new DocPlatformError("VALIDATION_ERROR", `slug 不能使用保留字: ${slug}`)
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(slug)) {
    throw new DocPlatformError(
      "VALIDATION_ERROR",
      "slug 需为 3-64 位小写字母/数字,可含连字符,且以字母或数字开头",
    )
  }
  if (KB_SLUG_RESERVED.has(slug)) {
    throw new DocPlatformError("VALIDATION_ERROR", `slug 不能使用保留字: ${slug}`)
  }
}

/** 菜单 slug 校验(kb 内路径段):1-255 位,不含 / 与空白 */
export function validateMenuSlug(slug: string): void {
  if (!/^[^\s/]{1,255}$/.test(slug)) {
    throw new DocPlatformError("VALIDATION_ERROR", "菜单 slug 不能包含 / 或空白字符")
  }
}

/** 菜单行(与 DB 平铺行同构的最小结构) */
export interface MenuRowLike {
  id: string
  parentId: string | null
  previousId: string | null
  name: string
  type: string
  iconUrl: string | null
  slug: string | null
  enable: number | boolean
  docUniqueId: string | null
}

/**
 * 平铺菜单行 → 树(按兄弟链表 previous_id 排序)
 * - 兄弟排序:从链头(previous_id 为空或指向不在组内的节点)沿链遍历,防环
 * - 断链容错:无法到达的节点按 id 兜底追加
 */
export function buildMenuTree(
  rows: MenuRowLike[],
  options: { includeDisabled?: boolean } = {},
): MenuTreeNode[] {
  const byParent = new Map<string | null, MenuRowLike[]>()
  for (const row of rows) {
    if (!options.includeDisabled && !Number(row.enable)) continue
    const key = row.parentId
    if (!byParent.has(key)) byParent.set(key, [])
    byParent.get(key)!.push(row)
  }

  const pathByRoot = new Map<MenuRowLike, string[]>()
  const nodeById = new Map(rows.map((r) => [r.id, r]))

  function buildSiblings(parent: MenuRowLike | null, parentPath: string[]): MenuTreeNode[] {
    const group = byParent.get(parent ? parent.id : null) ?? []
    const inGroup = new Set(group.map((r) => r.id))
    const ordered: MenuRowLike[] = []
    const visited = new Set<string>()
    // 逐链展开:每个链头(previous 为空或断链)各走一条链,按组内原顺序串联
    const heads = group.filter((r) => !r.previousId || !inGroup.has(r.previousId))
    for (const head of heads) {
      let cursor: MenuRowLike | undefined = head
      while (cursor && !visited.has(cursor.id)) {
        visited.add(cursor.id)
        ordered.push(cursor)
        cursor = group.find((r) => r.previousId === cursor!.id)
      }
    }
    // 兜底:环等异常数据按原顺序追加
    for (const row of group) {
      if (!visited.has(row.id)) ordered.push(row)
    }

    return ordered.map((row) => {
      const path = [...parentPath, row.name]
      if (!parent) pathByRoot.set(row, path)
      const children = buildSiblings(row, path)
      return {
        id: row.id,
        name: row.name,
        type: (row.type === "folder" ? "folder" : "doc") as MenuTreeNode["type"],
        iconUrl: row.iconUrl,
        slug: row.slug,
        enable: Number(row.enable) === 1,
        docUniqueId: row.docUniqueId,
        parentId: row.parentId,
        path,
        menuTrees: children,
      }
    })
  }

  return buildSiblings(null, [])
}

/**
 * 兄弟链表摘除补丁:把 menuId 从当前链中摘除后,
 * 其直接后继(previous_id = menuId 的兄弟)应改为指向其前驱。
 * 返回需要更新的节点补丁;无后继时返回空数组。
 */
export function computeLinkRemoval(
  siblings: MenuRowLike[],
  menuId: string,
): Array<{ id: string; previousId: string | null }> {
  const removed = siblings.find((r) => r.id === menuId)
  if (!removed) return []
  const next = siblings.find((r) => r.previousId === menuId && r.id !== menuId)
  if (!next) return []
  return [{ id: next.id, previousId: removed.previousId }]
}

/**
 * 从 TipTap JSON 提取纯文本(递归 text 节点,块级以换行拼接)
 */
export function extractPlainText(contentJson: unknown): string {
  function walk(node: any, out: string[]): void {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, out)
      return
    }
    if (typeof node.type === "string" && node.type === "text" && typeof node.text === "string") {
      out.push(node.text)
      return
    }
    // 块级节点(段落/标题/列表项等)后追加换行,保持可读性
    const blockish =
      typeof node.type === "string" &&
      !["text", "inlineCode", "hardBreak"].includes(node.type)
    if (Array.isArray(node.content)) {
      walk(node.content, out)
      if (blockish) out.push("\n")
    }
  }
  const parts: string[] = []
  walk(contentJson, parts)
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim()
}
