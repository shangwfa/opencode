/**
 * Open API 权限兼容层
 * 决策 #4(鉴权后置):buildPermissionContext 返回全放行上下文;
 * assertPermission 结构保留(恒过),鉴权接入时替换实现即可,调用方零改动。
 */
import { BookOpenError } from "./errors.js";
import type { OpenContext } from "./types.js";

export async function buildPermissionContext(
  caller: { id?: string },
  kb: {
    kbId: string;
    kbSlug: string;
    languageCode: string;
    settings: Record<string, unknown>;
  },
): Promise<OpenContext> {
  const envCode =
    typeof kb.settings.envCode === "string" ? kb.settings.envCode : "default";
  return {
    caller,
    kbId: kb.kbId,
    kbSlug: kb.kbSlug,
    languageCode: kb.languageCode,
    languageCodes: [kb.languageCode],
    envCode,
    canRead: true,
    canCreate: true,
    canUpdate: true,
    canEnable: true,
    canDelete: true,
  };
}

export function assertPermission(
  context: OpenContext,
  permission: "read" | "create" | "update" | "enable" | "delete",
): void {
  const allowed = {
    read: context.canRead,
    create: context.canCreate,
    update: context.canUpdate,
    enable: context.canEnable,
    delete: context.canDelete,
  }[permission];
  if (!allowed) {
    // 当前全放行,不可达;鉴权接入后生效
    throw new BookOpenError("FORBIDDEN", `当前调用方没有执行该操作的权限: ${permission}`, {
      kbId: context.kbId,
    });
  }
}
