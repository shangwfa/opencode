/**
 * 产物面板上下文类型（React 适配版）。
 *
 * 源：xybot-front-opencode-ui src/features/requirement/artifact-panel/types.ts。
 * Solid 版 ctx.req 为 useRequirementSync 的返回（Accessor 风格）；React 版保留
 * 同名同签名的函数成员，req 内的 machine 换成 zustand 实例（getState()/方法直调）。
 * 未搬入的成员（preview 系列 / activeTab / writebackBusy 等）见 MIGRATION.md。
 */
import type { StageArtifact, StageConfig, RequirementFlowConfig } from "@/features/requirement/flows/config"
import type { StageMachine } from "@/features/requirement/stage-machine"

/** [MIGRATION] 需求同步上下文的最小面（源：useRequirementSync 返回值的子集） */
export type RequirementSyncSlice = {
  flow: RequirementFlowConfig
  stages: readonly StageConfig[]
  session: {
    /** 会话 ID（无会话时为 undefined） */
    id: () => string | undefined
  }
  machine: StageMachine
}

export type ArtifactPanelTab = "preview" | "markdown"

export type ArtifactPanelContext = {
  req: RequirementSyncSlice
  stage: () => StageConfig | undefined
  stageId: () => string | undefined
  working: () => StageConfig | undefined
  peeking: () => boolean
  canRollback: () => boolean
  text: () => string
  cacheKey: () => string
  confirmed: () => boolean
  syncing: () => boolean
  head: () => { title: string; hint: string }
  isLast: () => boolean
  currentArtifact: () => StageArtifact | undefined
  /** 需求唯一标识（后端落库 ID，URL ?req= 参数） */
  reqId?: () => string
  appId?: string
  onAfterConfirm?: () => void
  onJumpAdvance?: (opts?: { skipStages?: boolean; targetAgent?: string }) => void
  sendSyncStageMessage?: (entry: { agent: string; text: string }) => Promise<void>
  onRollback: () => void
  rollbackDisabled?: () => boolean
  // [MIGRATION] 源类型还有 preview/activeTab/writebackBusy 等成员，
  // 随 ArtifactPanel UI 迁移补齐（见 MIGRATION.md §ArtifactPanel）
}
