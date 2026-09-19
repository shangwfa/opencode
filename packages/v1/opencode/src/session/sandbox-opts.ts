import type { SessionID } from "@/session/schema"
import * as Database from "../storage/db"
import { SessionTable } from "../session/session.pg"
import { Flag } from "@/flag/flag"
import { eq } from "drizzle-orm"

export interface SandboxOpts {
  id: SessionID
  pvcMode?: "session" | "app"
  appId?: string
  /** workspace 持久化方式（创建时固化到 session.persist_mode；旧行缺省回退全局 VOLUME_TYPE） */
  persistMode: "pvc" | "snapshot"
  sandbox?: { cpu: string; memory: string; image?: string; snapshotId?: string; persistMode?: "pvc" | "snapshot" }
}

export async function resolveSandboxOpts(sessionID: SessionID): Promise<SandboxOpts> {
  let current: SessionID = sessionID
  let visited = 0
  while (visited < 10) {
    visited++
    const row = await Database.use((db) =>
      db
        .select({ parent_id: SessionTable.parent_id, pvc_mode: SessionTable.pvc_mode, app_id: SessionTable.app_id, sandbox: SessionTable.sandbox })
        .from(SessionTable)
        .where(eq(SessionTable.id, current))
        .get(),
    )
    if (!row?.parent_id) {
      const sandbox = parseSandboxColumn(row?.sandbox)
      const persistMode = sandbox?.persistMode
        ?? (Flag.OPENCODE_SANDBOX_VOLUME_TYPE === "snapshot" ? "snapshot" : "pvc")
      return {
        id: current,
        pvcMode: (row?.pvc_mode as "session" | "app") ?? undefined,
        appId: row?.app_id ?? undefined,
        persistMode,
        sandbox: sandbox ?? undefined,
      }
    }
    current = row.parent_id as SessionID
  }
  return {
    id: current,
    pvcMode: undefined,
    appId: undefined,
    persistMode: Flag.OPENCODE_SANDBOX_VOLUME_TYPE === "snapshot" ? "snapshot" : "pvc",
    sandbox: undefined,
  }
}

export type SandboxResource = { cpu: string; memory: string; image?: string; snapshotId?: string; persistMode?: "pvc" | "snapshot" }

/**
 * sandbox 列值统一解析。PG bridge 下 jsonb 以原始 JSON 字符串返回（db.pg.ts jsonb parse 恒等），
 * SQLite 侧为对象——消费方必须兼容两种形态，否则 persistMode 等字段静默丢失回退全局默认。
 */
export function parseSandboxColumn(raw: unknown): SandboxResource | undefined {
  if (typeof raw !== "string") {
    return raw && typeof raw === "object" && typeof (raw as SandboxResource).cpu === "string"
      ? (raw as SandboxResource)
      : undefined
  }
  try {
    const v = JSON.parse(raw)
    if (v && typeof v.cpu === "string" && typeof v.memory === "string") {
      return {
        cpu: v.cpu,
        memory: v.memory,
        ...(typeof v.image === "string" ? { image: v.image } : {}),
        ...(typeof v.snapshotId === "string" ? { snapshotId: v.snapshotId } : {}),
        ...(v.persistMode === "snapshot" || v.persistMode === "pvc" ? { persistMode: v.persistMode } : {}),
      }
    }
  } catch {}
}
