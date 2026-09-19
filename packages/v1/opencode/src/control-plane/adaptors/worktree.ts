import z from "zod"
import { AppRuntime } from "@/effect/app-runtime"
import { Worktree } from "@/worktree"
import type { WorkspaceAdapter, WorkspaceInfo } from "../types"

const WorktreeConfig = z.object({
  name: z.string(),
  branch: z.string(),
  directory: z.string(),
})

export const WorktreeAdaptor: WorkspaceAdapter = {
  name: "Worktree",
  description: "Create a git worktree",
  async configure(info: WorkspaceInfo) {
    const worktree = await AppRuntime.runPromise(Worktree.Service.use((svc) => svc.makeWorktreeInfo()))
    return {
      ...info,
      name: worktree.name,
      branch: worktree.branch,
      directory: worktree.directory,
    }
  },
  async create(info: WorkspaceInfo) {
    const config = WorktreeConfig.parse(info)
    await AppRuntime.runPromise(
      Worktree.Service.use((svc) =>
        svc.createFromInfo({
          name: config.name,
          directory: config.directory,
          branch: config.branch,
        }),
      ),
    )
  },
  async remove(info: WorkspaceInfo) {
    const config = WorktreeConfig.parse(info)
    await AppRuntime.runPromise(Worktree.Service.use((svc) => svc.remove({ directory: config.directory })))
  },
  target(info: WorkspaceInfo) {
    const config = WorktreeConfig.parse(info)
    return {
      type: "local" as const,
      directory: config.directory,
    }
  },
}
