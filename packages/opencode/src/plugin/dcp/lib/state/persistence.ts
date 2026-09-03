/**
 * State persistence module for DCP plugin.
 * Persists pruned tool IDs across sessions so they survive OpenCode restarts.
 * Storage location: ~/.local/share/opencode/storage/plugin/dcp/{sessionId}.json
 */

import * as fs from "fs/promises"
import { existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { CompressionBlock, PrunedMessageEntry, SessionState, SessionStats } from "./types"
import type { Logger } from "../logger"
import { serializePruneMessagesState } from "./utils"

/** Prune state as stored on disk */
export interface PersistedPruneMessagesState {
  byMessageId: Record<string, PrunedMessageEntry>
  blocksById: Record<string, CompressionBlock>
  activeBlockIds: number[]
  activeByAnchorMessageId: Record<string, number>
  nextBlockId: number
  nextRunId: number
}

export interface PersistedPrune {
  tools?: Record<string, number>
  messages?: PersistedPruneMessagesState
}

export interface PersistedNudges {
  contextLimitAnchors: string[]
  turnNudgeAnchors?: string[]
  iterationNudgeAnchors?: string[]
}

export interface PersistedSessionState {
  sessionName?: string
  manualMode?: boolean
  prune: PersistedPrune
  nudges: PersistedNudges
  stats: SessionStats
  lastUpdated: string
}

export interface DcpSessionStats {
  hasState: boolean
  totalTokensSaved: number
  prunedTools: number
  prunedMessages: number
  compressionBlocks: number
  activeCompressionBlocks: number
  compressedTokens: number
  summaryTokens: number
  compressionDurationMs: number
  lastUpdated: string | null
}

const STORAGE_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "opencode",
  "storage",
  "plugin",
  "dcp",
)

/**
 * Optional storage backend. When the host (e.g. opencode SaaS with multiple
 * server instances sharing one PostgreSQL) provides one, state is persisted
 * through it instead of the instance-local filesystem so all instances see
 * the same view. Keys follow opencode storage conventions, e.g.
 * ["plugin", "dcp", sessionId].
 */
export interface DcpStorageBackend {
  read(key: string[]): Promise<PersistedSessionState | null>
  write(key: string[], content: PersistedSessionState): Promise<void>
  list(prefix: string[]): Promise<string[][]>
}

let storageBackend: DcpStorageBackend | undefined

export function setStorageBackend(backend: DcpStorageBackend | undefined): void {
  storageBackend = backend
}

function dcpKey(sessionId: string): string[] {
  return ["plugin", "dcp", sessionId]
}

async function ensureStorageDir(): Promise<void> {
  if (!existsSync(STORAGE_DIR)) {
    await fs.mkdir(STORAGE_DIR, { recursive: true })
  }
}

function getSessionFilePath(sessionId: string): string {
  return join(STORAGE_DIR, `${sessionId}.json`)
}

async function writePersistedSessionState(
  sessionId: string,
  state: PersistedSessionState,
  logger: Logger,
): Promise<void> {
  if (storageBackend) {
    await storageBackend.write(dcpKey(sessionId), state)
    logger.info("Saved session state to storage backend", {
      sessionId,
      totalTokensSaved: state.stats.totalPruneTokens,
    })
    return
  }

  await ensureStorageDir()

  const filePath = getSessionFilePath(sessionId)
  const content = JSON.stringify(state, null, 2)
  await fs.writeFile(filePath, content, "utf-8")

  logger.info("Saved session state to disk", {
    sessionId,
    totalTokensSaved: state.stats.totalPruneTokens,
  })
}

export async function saveSessionState(
  sessionState: SessionState,
  logger: Logger,
  sessionName?: string,
): Promise<void> {
  try {
    if (!sessionState.sessionId) {
      return
    }

    const state: PersistedSessionState = {
      sessionName: sessionName,
      manualMode: !!sessionState.manualMode,
      prune: {
        tools: Object.fromEntries(sessionState.prune.tools),
        messages: serializePruneMessagesState(sessionState.prune.messages),
      },
      nudges: {
        contextLimitAnchors: Array.from(sessionState.nudges.contextLimitAnchors),
        turnNudgeAnchors: Array.from(sessionState.nudges.turnNudgeAnchors),
        iterationNudgeAnchors: Array.from(sessionState.nudges.iterationNudgeAnchors),
      },
      stats: sessionState.stats,
      lastUpdated: new Date().toISOString(),
    }

    await writePersistedSessionState(sessionState.sessionId, state, logger)
  } catch (error: any) {
    logger.error("Failed to save session state", {
      sessionId: sessionState.sessionId,
      error: error?.message,
    })
  }
}

export async function loadSessionState(sessionId: string, logger: Logger): Promise<PersistedSessionState | null> {
  try {
    let state: PersistedSessionState | null
    if (storageBackend) {
      state = await storageBackend.read(dcpKey(sessionId))
    } else {
      const filePath = getSessionFilePath(sessionId)

      if (!existsSync(filePath)) {
        return null
      }

      const content = await fs.readFile(filePath, "utf-8")
      state = JSON.parse(content) as PersistedSessionState
    }

    const hasPruneTools = state?.prune?.tools && typeof state.prune.tools === "object"
    const hasPruneMessages = state?.prune?.messages && typeof state.prune.messages === "object"
    const hasNudgeFormat = state?.nudges && typeof state.nudges === "object"
    if (!state || !state.prune || !hasPruneTools || !hasPruneMessages || !state.stats || !hasNudgeFormat) {
      logger.warn(`Invalid session state ${storageBackend ? "from storage backend" : "file"}, ignoring`, {
        sessionId: sessionId,
      })
      return null
    }

    const rawContextLimitAnchors = Array.isArray(state.nudges.contextLimitAnchors)
      ? state.nudges.contextLimitAnchors
      : []
    const validAnchors = rawContextLimitAnchors.filter((entry): entry is string => typeof entry === "string")
    const dedupedAnchors = [...new Set(validAnchors)]
    if (validAnchors.length !== rawContextLimitAnchors.length) {
      logger.warn("Filtered out malformed contextLimitAnchors entries", {
        sessionId: sessionId,
        original: rawContextLimitAnchors.length,
        valid: validAnchors.length,
      })
    }
    state.nudges.contextLimitAnchors = dedupedAnchors

    const rawTurnNudgeAnchors = Array.isArray(state.nudges.turnNudgeAnchors) ? state.nudges.turnNudgeAnchors : []
    const validSoftAnchors = rawTurnNudgeAnchors.filter((entry): entry is string => typeof entry === "string")
    const dedupedSoftAnchors = [...new Set(validSoftAnchors)]
    if (validSoftAnchors.length !== rawTurnNudgeAnchors.length) {
      logger.warn("Filtered out malformed turnNudgeAnchors entries", {
        sessionId: sessionId,
        original: rawTurnNudgeAnchors.length,
        valid: validSoftAnchors.length,
      })
    }
    state.nudges.turnNudgeAnchors = dedupedSoftAnchors

    const rawIterationNudgeAnchors = Array.isArray(state.nudges.iterationNudgeAnchors)
      ? state.nudges.iterationNudgeAnchors
      : []
    const validIterationAnchors = rawIterationNudgeAnchors.filter((entry): entry is string => typeof entry === "string")
    const dedupedIterationAnchors = [...new Set(validIterationAnchors)]
    if (validIterationAnchors.length !== rawIterationNudgeAnchors.length) {
      logger.warn("Filtered out malformed iterationNudgeAnchors entries", {
        sessionId: sessionId,
        original: rawIterationNudgeAnchors.length,
        valid: validIterationAnchors.length,
      })
    }
    state.nudges.iterationNudgeAnchors = dedupedIterationAnchors

    logger.info(`Loaded session state from ${storageBackend ? "storage backend" : "disk"}`, {
      sessionId: sessionId,
    })

    return state
  } catch (error: any) {
    logger.warn("Failed to load session state", {
      sessionId: sessionId,
      error: error?.message,
    })
    return null
  }
}

export async function loadSessionStats(sessionId: string, logger: Logger): Promise<DcpSessionStats> {
  const state = await loadSessionState(sessionId, logger)
  if (!state) {
    return {
      hasState: false,
      totalTokensSaved: 0,
      prunedTools: 0,
      prunedMessages: 0,
      compressionBlocks: 0,
      activeCompressionBlocks: 0,
      compressedTokens: 0,
      summaryTokens: 0,
      compressionDurationMs: 0,
      lastUpdated: null,
    }
  }

  const messages = Object.values(state.prune.messages?.byMessageId ?? {})
  const blocks = Object.values(state.prune.messages?.blocksById ?? {})
  const activeBlocks = blocks.filter((block) => block.active)

  return {
    hasState: true,
    totalTokensSaved: state.stats.totalPruneTokens,
    prunedTools: Object.keys(state.prune.tools ?? {}).length,
    prunedMessages: messages.filter((message) => message.activeBlockIds.length > 0).length,
    compressionBlocks: blocks.length,
    activeCompressionBlocks: activeBlocks.length,
    compressedTokens: activeBlocks.reduce((total, block) => total + block.compressedTokens, 0),
    summaryTokens: activeBlocks.reduce((total, block) => total + block.summaryTokens, 0),
    compressionDurationMs: activeBlocks.reduce((total, block) => total + block.durationMs, 0),
    lastUpdated: state.lastUpdated,
  }
}

function emptyPersistedState(manualMode: boolean): PersistedSessionState {
  return {
    manualMode,
    prune: {
      tools: {},
      messages: {
        byMessageId: {},
        blocksById: {},
        activeBlockIds: [],
        activeByAnchorMessageId: {},
        nextBlockId: 1,
        nextRunId: 1,
      },
    },
    nudges: {
      contextLimitAnchors: [],
      turnNudgeAnchors: [],
      iterationNudgeAnchors: [],
    },
    stats: {
      pruneTokenCounter: 0,
      totalPruneTokens: 0,
    },
    lastUpdated: new Date().toISOString(),
  }
}

export async function loadManualModeSetting(sessionId: string, logger: Logger): Promise<boolean | undefined> {
  const state = await loadSessionState(sessionId, logger)
  return typeof state?.manualMode === "boolean" ? state.manualMode : undefined
}

export async function saveManualModeSetting(sessionId: string, manualMode: boolean, logger: Logger): Promise<void> {
  const existing = await loadSessionState(sessionId, logger)
  const state = existing ?? emptyPersistedState(manualMode)
  state.manualMode = manualMode
  state.lastUpdated = new Date().toISOString()
  await writePersistedSessionState(sessionId, state, logger)
}

export interface AggregatedStats {
  totalTokens: number
  totalTools: number
  totalMessages: number
  sessionCount: number
}

export async function loadAllSessionStats(logger: Logger): Promise<AggregatedStats> {
  const result: AggregatedStats = {
    totalTokens: 0,
    totalTools: 0,
    totalMessages: 0,
    sessionCount: 0,
  }

  try {
    if (storageBackend) {
      const keys = await storageBackend.list(["plugin", "dcp"])
      for (const key of keys) {
        try {
          const state = await storageBackend.read(key)
          if (state?.stats?.totalPruneTokens && state?.prune) {
            result.totalTokens += state.stats.totalPruneTokens
            result.totalTools += state.prune.tools ? Object.keys(state.prune.tools).length : 0
            result.totalMessages += state.prune.messages?.byMessageId
              ? Object.keys(state.prune.messages.byMessageId).length
              : 0
            result.sessionCount++
          }
        } catch {
          // Skip invalid entries
        }
      }

      logger.debug("Loaded all-time stats", result)
      return result
    }

    if (!existsSync(STORAGE_DIR)) {
      return result
    }

    const files = await fs.readdir(STORAGE_DIR)
    const jsonFiles = files.filter((f) => f.endsWith(".json"))

    for (const file of jsonFiles) {
      try {
        const filePath = join(STORAGE_DIR, file)
        const content = await fs.readFile(filePath, "utf-8")
        const state = JSON.parse(content) as PersistedSessionState

        if (state?.stats?.totalPruneTokens && state?.prune) {
          result.totalTokens += state.stats.totalPruneTokens
          result.totalTools += state.prune.tools ? Object.keys(state.prune.tools).length : 0
          result.totalMessages += state.prune.messages?.byMessageId
            ? Object.keys(state.prune.messages.byMessageId).length
            : 0
          result.sessionCount++
        }
      } catch {
        // Skip invalid files
      }
    }

    logger.debug("Loaded all-time stats", result)
  } catch (error: any) {
    logger.warn("Failed to load all-time stats", { error: error?.message })
  }

  return result
}
