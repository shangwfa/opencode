import { resolveSandboxOpts } from "../session/sandbox-opts"
import { CodegraphStore as S } from "./store"

/**
 * Shared tool entry logic: resolve a session to its codegraph scope
 * (application dimension only — see codegraph.pg.ts). No appId → no
 * codegraph; returns guidance text rather than an error so the agent keeps
 * using the toolset on app-bearing sessions (codegraph's NotIndexedError
 * pattern).
 */
export const resolveScopeOrGuide = async (
  sessionID: string,
): Promise<{ scope: S.Scope | null; guidance: string | null }> => {
  const opts = await resolveSandboxOpts(sessionID as any)
  if (!opts.appId) {
    return {
      scope: null,
      guidance:
        "当前会话未绑定应用（无 appId），codegraph 不可用。请使用 read/grep 等内置工具探索代码。",
    }
  }
  return { scope: S.scopeFor(opts.appId), guidance: null }
}

/** Index-state prefix appended to read-tool outputs so the agent knows the data may lag or be mid-build. */
export const indexStateNote = async (scope: S.Scope): Promise<string> => {
  const idx = await S.getIndex(scope)
  if (!idx) return "（codegraph 索引尚未建立）\n"
  if (idx.state === "indexing")
    return `（codegraph 索引构建中：${idx.files_done}/${idx.files_total} 文件）\n`
  if (idx.state === "failed") return `（codegraph 索引失败：${idx.error ?? "unknown"}）\n`
  if (idx.state === "ready" && idx.stale_files?.length) {
    return `（注意：以下文件刚被编辑、索引尚未同步，读其内容请用 read 工具：${idx.stale_files.slice(0, 5).join(", ")}${idx.stale_files.length > 5 ? "…" : ""}）\n`
  }
  return ""
}
