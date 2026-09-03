import { estimateTokens, type CcrConfig } from "./config"
import { contentHash, type CcrStore } from "./store"

const EXCLUDED_TOOLS = new Set(["edit", "write", "question"])

interface ToolPartLike {
  type: "tool"
  tool: string
  callID: string
  state: { status?: string; output?: string }
}

interface MessageLike {
  info: { id: string; sessionID: string; role: string }
  parts: Array<ToolPartLike | { type: string }>
}

export interface CcrTransformStats {
  compressed: number
  tokensSaved: number
}

function extractQuery(messages: MessageLike[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.info?.role !== "user") continue
    const parts = Array.isArray(msg.parts) ? msg.parts : []
    const text = parts
      .map((p) => {
        const t = (p as unknown as { text?: unknown }).text
        return typeof t === "string" ? t : ""
      })
      .join(" ")
      .trim()
    if (text) return text.slice(0, 500)
  }
  return undefined
}

export function createMessageTransform(store: CcrStore, config: CcrConfig) {
  return async (_input: unknown, output: { messages: MessageLike[] }) => {
    const messages = output.messages
    console.log(
      `[ccr] transform: messages=${Array.isArray(messages) ? messages.length : "invalid"} completedTools=${Array.isArray(messages) ? messages.flatMap((m) => (Array.isArray(m.parts) ? m.parts : [])).filter((p) => (p as ToolPartLike).type === "tool" && (p as ToolPartLike).state?.status === "completed").length : 0}`,
    )
    if (!Array.isArray(messages) || messages.length === 0) return

    const stats: CcrTransformStats = { compressed: 0, tokensSaved: 0 }
    const lastCompressibleIndex = messages.length - 1 - config.protectRecent
    const query = extractQuery(messages)
    // Proactive expansion (Headroom context_tracker parity): outputs whose
    // stored originals match the current query stay uncompressed this turn.
    const expandHashes =
      messages.length > 0 ? await store.expandableHashes(messages[0].info.sessionID, query) : new Set<string>()
    if (expandHashes.size > 0) {
      console.log(`[ccr] proactive expansion: ${expandHashes.size} output(s) kept full for this query`)
    }
    console.log(
      `[ccr] window: last=${lastCompressibleIndex} ids=${messages.slice(0, lastCompressibleIndex + 1).map((m) => m?.info?.id?.slice(4, 16)).join(",")}`,
    )

    for (let i = 0; i <= lastCompressibleIndex; i++) {
      const msg = messages[i]
      const parts = Array.isArray(msg?.parts) ? msg.parts : []
      for (const part of parts) {
        if (part.type !== "tool") continue
        const toolPart = part as ToolPartLike
        if (EXCLUDED_TOOLS.has(toolPart.tool)) continue
        if (toolPart.state?.status !== "completed") continue
        const outputText = toolPart.state.output
        if (typeof outputText !== "string") continue
        if (estimateTokens(outputText) < config.minTokens) continue
        if (expandHashes.has(contentHash(outputText))) continue

        const replacement = await store.replace({
          sessionID: msg.info.sessionID,
          messageID: msg.info.id,
          tool: toolPart.tool,
          output: outputText,
          query,
        })
        if (replacement === undefined) {
          console.log(`[ccr] skip: idx=${i} id=${msg.info.id.slice(4, 20)} tool=${toolPart.tool} len=${outputText.length}`)
          continue
        }

        stats.compressed++
        stats.tokensSaved += estimateTokens(outputText) - estimateTokens(replacement)
        toolPart.state.output = replacement
      }
    }

    if (stats.compressed > 0) {
      console.log(
        `[ccr] compressed ${stats.compressed} tool output(s), ~${stats.tokensSaved} tokens saved`,
      )
    }
  }
}
