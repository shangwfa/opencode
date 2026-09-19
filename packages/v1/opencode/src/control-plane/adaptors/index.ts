import { lazy } from "@/util/lazy"
import { ProjectV2 } from "@opencode-ai/core/project"
import type { WorkspaceAdapter } from "../types"

export type WorkspaceAdaptorEntry = {
  type: string
  name: string
  description: string
}

const BUILTIN: Record<string, () => Promise<WorkspaceAdapter>> = {
  worktree: lazy(async () => (await import("./worktree")).WorktreeAdaptor),
}

const state = new Map<ProjectV2.ID, Map<string, WorkspaceAdapter>>()

export async function getAdaptor(projectID: ProjectV2.ID, type: string): Promise<WorkspaceAdapter> {
  const custom = state.get(projectID)?.get(type)
  if (custom) return custom

  const builtin = BUILTIN[type]
  if (builtin) return builtin()

  throw new Error(`Unknown workspace adaptor: ${type}`)
}

export async function listAdaptors(projectID: ProjectV2.ID): Promise<WorkspaceAdaptorEntry[]> {
  const builtin = await Promise.all(
    Object.entries(BUILTIN).map(async ([type, init]) => {
      const adaptor = await init()
      return {
        type,
        name: adaptor.name,
        description: adaptor.description,
      }
    }),
  )
  const custom = [...(state.get(projectID)?.entries() ?? [])].map(([type, adaptor]) => ({
    type,
    name: adaptor.name,
    description: adaptor.description,
  }))
  return [...builtin, ...custom]
}

// Plugins can be loaded per-project so we need to scope them. If you
// want to install a global one pass `ProjectID.global`
export function registerAdaptor(projectID: ProjectV2.ID, type: string, adaptor: WorkspaceAdapter) {
  const adaptors = state.get(projectID) ?? new Map<string, WorkspaceAdapter>()
  adaptors.set(type, adaptor)
  state.set(projectID, adaptors)
}
