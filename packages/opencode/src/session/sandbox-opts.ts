import type { SessionID } from "@/session/schema"
import * as Database from "@/storage/db"
import { SessionTable } from "@/session/session.pg"
import { eq } from "drizzle-orm"

export interface SandboxOpts {
  id: SessionID
  pvcMode?: "session" | "app"
  appId?: string
}

export async function resolveSandboxOpts(sessionID: SessionID): Promise<SandboxOpts> {
  let current: SessionID = sessionID
  let visited = 0
  while (visited < 10) {
    visited++
    const row = await Database.use((db) =>
      db
        .select({ parent_id: SessionTable.parent_id, pvc_mode: SessionTable.pvc_mode, app_id: SessionTable.app_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, current))
        .get(),
    )
    if (!row?.parent_id) {
      return { id: current, pvcMode: (row?.pvc_mode as "session" | "app") ?? undefined, appId: row?.app_id ?? undefined }
    }
    current = row.parent_id as SessionID
  }
  return { id: current }
}

export function worktreeScript(sessionID: string): string {
  const wt = `/workspace/worktrees/${sessionID}`
  return [
    `if [ -d /workspace/repo/.git ]; then`,
    `  if [ ! -d ${wt} ]; then`,
    `    git -C /workspace/repo worktree add --detach ${wt} HEAD;`,
    `  fi;`,
    `fi`,
  ].join(" ")
}
