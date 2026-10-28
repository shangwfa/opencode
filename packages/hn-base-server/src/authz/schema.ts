/**
 * 权限 schema（ReBAC）。
 * 定义「资源 → 关系」与「权限 = 关系的组合」，判定逻辑只读这里。
 * 新增资源/权限只改本文件，不改判定代码。
 */

export type ResourceType = "org" | "project" | "requirement" | "session" | "git_provider" | "app" | "knowledge_base"
/** 主体可以是人/组织/团队/公开，也可以是另一个资源（parent 关系） */
export type SubjectType = "user" | "org" | "team" | "public" | ResourceType

/** 关系的合法主体类型 */
export const relations: Record<ResourceType, Record<string, SubjectType[]>> = {
  knowledge_base: {
    owner: ["user"],
    editor: ["user", "org", "team"],
    viewer: ["user", "org", "team"],
  },
  org: {
    owner: ["user"],
    admin: ["user"],
    member: ["user", "team"],
  },
  project: {
    org: ["org"],
    owner: ["user"],
    editor: ["user", "org", "team"],
    viewer: ["user", "org", "team", "public"],
  },
  requirement: {
    owner: ["user"],
    editor: ["user", "org", "team"],
    viewer: ["user", "org", "team", "public"],
    parent: ["project"],
  },
  session: {
    owner: ["user"],
    parent: ["requirement", "session"],
    viewer: ["user", "org"],
  },
  app: {
    owner: ["user"],
    viewer: ["user", "org", "team"],
  },
  git_provider: {
    owner: ["user", "org"],
    admin: ["user"],
    user: ["user", "org"],
  },
}

/**
 * 权限 = 允许来源列表。
 *  - 普通项：本资源上的关系名
 *  - "parent->perm"：沿 parent 关系找父对象，再判父对象的 perm
 */
export const permissions: Record<ResourceType, Record<string, string[]>> = {
  knowledge_base: {
    read: ["owner", "editor", "viewer"],
    write: ["owner", "editor"],
    manage: ["owner"],
    delete: ["owner"],
  },
  org: {
    read: ["owner", "admin", "member"],
    manage: ["owner", "admin"],
    delete: ["owner"],
  },
  project: {
    read: ["owner", "editor", "viewer"],
    write: ["owner", "editor"],
    manage: ["owner", "org->admin"],
  },
  requirement: {
    read: ["owner", "editor", "viewer", "parent->read"],
    write: ["owner", "editor", "parent->write"],
    delete: ["owner", "parent->manage"],
    share: ["owner", "parent->manage"],
    run: ["owner", "editor"],
  },
  session: {
    read: ["owner", "viewer", "parent->read"],
    run: ["owner", "parent->run"],
    abort: ["owner", "parent->run"],
    share: ["owner"],
    delete: ["owner", "parent->delete"],
  },
  app: {
    read: ["owner", "viewer"],
    write: ["owner"],
    delete: ["owner"],
    manage: ["owner"],
    run: ["owner"],
  },
  git_provider: {
    /** 可用于 clone/push */
    use: ["owner", "user"],
    /** 可查看/使用 secret（前端仍不返回明文） */
    read_secret: ["owner", "admin"],
    manage: ["owner", "admin"],
  },
}

/** 关系可继承的最大深度，防环 */
export const MAX_DEPTH = 12

export function isResourceType(value: string): value is ResourceType {
  return value in permissions
}

export function isPermission(resource: ResourceType, permission: string): boolean {
  return permission in permissions[resource]
}

/** 解析 "parent->read"；非继承项返回 undefined */
export function parseParentPermission(value: string): { relation: string; permission: string } | undefined {
  const index = value.indexOf("->")
  if (index <= 0) return undefined
  return { relation: value.slice(0, index), permission: value.slice(index + 2) }
}
