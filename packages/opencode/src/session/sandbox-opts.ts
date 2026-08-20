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
      const raw = row?.sandbox
      const sandbox = typeof raw === "string" ? safeParse(raw) : raw
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

function safeParse(s: string): { cpu: string; memory: string; image?: string; snapshotId?: string; persistMode?: "pvc" | "snapshot" } | undefined {
  try {
    const v = JSON.parse(s)
    if (v && typeof v.cpu === "string" && typeof v.memory === "string") {
      return {
        cpu: v.cpu,
        memory: v.memory,
        ...(typeof v.image === "string" ? { image: v.image } : {}),
        ...(typeof v.snapshotId === "string" ? { snapshotId: v.snapshotId } : {}),
      }
    }
  } catch {}
}
