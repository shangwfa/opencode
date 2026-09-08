import { estimateTokens, type CcrConfig } from "./config"
import { resizeImageDataUrl } from "./image-resize"
import type { CcrStore } from "./store"

const EXCLUDED_TOOLS = new Set(["edit", "write", "question"])

// Detail-oriented queries need pixels; skip the resize pass this turn.
const IMAGE_DETAIL_RE =
  /\bread\b|\bcount\b|\btranscribe\b|\bexact\b|\bserial\b|\bcompare\b|\bzoom\b|数一下|数量|几个|精确|序列|对比|逐字|逐项|逐个|逐像素|放大|仔细|看清|识别.*(?:文字|文本)/

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
  created: number
  reused: number
  originalTokens: number
  compressedTokens: number
  imagesResized?: number
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
    const startedAt = Date.now()
    const messages = output.messages
    if (!Array.isArray(messages) || messages.length === 0) return

    const stats: CcrTransformStats = { created: 0, reused: 0, originalTokens: 0, compressedTokens: 0 }
    const lastCompressibleIndex = messages.length - 1 - config.protectRecent
    const query = extractQuery(messages)

    for (let i = 0; i <= lastCompressibleIndex; i++) {
      const msg = messages[i]
      const parts = Array.isArray(msg?.parts) ? msg.parts : []
      for (const part of parts) {
        if (part.type === "file") {
          // History images past the protection window get resized (Anthropic
          // bills by pixels); recent ones keep full fidelity. A detail-
          // oriented query (count/read/exact/serial…) preserves this turn's
          // images as well — cheap heuristic for the ML router we skip.
          if (!config.imageResize || IMAGE_DETAIL_RE.test(query ?? "")) continue
          const filePart = part as { url?: string }
          if (typeof filePart.url !== "string" || !filePart.url.startsWith("data:image/")) continue
          const resized = await resizeImageDataUrl(filePart.url)
          if (resized !== undefined && resized !== filePart.url) {
            stats.imagesResized = (stats.imagesResized ?? 0) + 1
            filePart.url = resized
          }
          continue
        }
        if (part.type !== "tool") continue
        const toolPart = part as ToolPartLike
        if (EXCLUDED_TOOLS.has(toolPart.tool)) continue
        if (toolPart.state?.status !== "completed") continue
        const outputText = toolPart.state.output
        if (typeof outputText !== "string") continue
        const originalTokens = estimateTokens(outputText)
        if (originalTokens < config.minTokens) continue
        const result = await store.replace({
          sessionID: msg.info.sessionID,
          messageID: msg.info.id,
          tool: toolPart.tool,
          output: outputText,
          query,
        })
        if (result === undefined) {
          console.log(
            `[ccr] skip: idx=${i} id=${msg.info.id.slice(4, 20)} tool=${toolPart.tool} len=${outputText.length}`,
          )
          continue
        }

        stats[result.origin]++
        const compressedTokens = estimateTokens(result.replacement)
        stats.originalTokens += originalTokens
        stats.compressedTokens += compressedTokens
        toolPart.state.output = result.replacement
      }
    }

    // One structured line per turn: savings trend down when the compressors
    // drift, and a reused count collapsing toward zero means marker bytes
    // stopped matching (prefix cache is being invalidated every request).
    const total = stats.created + stats.reused
    const savedPct =
      stats.originalTokens > 0 ? ((1 - stats.compressedTokens / stats.originalTokens) * 100).toFixed(1) : "0.0"
    const images = stats.imagesResized ? ` images=${stats.imagesResized}` : ""
    console.log(
      `[ccr] turn: messages=${messages.length} window=${lastCompressibleIndex + 1} created=${stats.created} reused=${stats.reused} compressed=${total} orig=${stats.originalTokens} comp=${stats.compressedTokens} saved=${savedPct}%${images} took=${Date.now() - startedAt}ms`,
    )
  }
}
