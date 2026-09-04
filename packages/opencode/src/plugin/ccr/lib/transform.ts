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
  compressed: number
  tokensSaved: number
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
    const messages = output.messages
    console.log(
      `[ccr] transform: messages=${Array.isArray(messages) ? messages.length : "invalid"} completedTools=${Array.isArray(messages) ? messages.flatMap((m) => (Array.isArray(m.parts) ? m.parts : [])).filter((p) => (p as ToolPartLike).type === "tool" && (p as ToolPartLike).state?.status === "completed").length : 0}`,
    )
    if (!Array.isArray(messages) || messages.length === 0) return

    const stats: CcrTransformStats = { compressed: 0, tokensSaved: 0 }
    const lastCompressibleIndex = messages.length - 1 - config.protectRecent
    const query = extractQuery(messages)
    console.log(
      `[ccr] window: last=${lastCompressibleIndex} ids=${messages
        .slice(0, lastCompressibleIndex + 1)
        .map((m) => m?.info?.id?.slice(4, 16))
        .join(",")}`,
    )

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
        if (estimateTokens(outputText) < config.minTokens) continue
        const replacement = await store.replace({
          sessionID: msg.info.sessionID,
          messageID: msg.info.id,
          tool: toolPart.tool,
          output: outputText,
          query,
        })
        if (replacement === undefined) {
          console.log(
            `[ccr] skip: idx=${i} id=${msg.info.id.slice(4, 20)} tool=${toolPart.tool} len=${outputText.length}`,
          )
          continue
        }

        stats.compressed++
        stats.tokensSaved += estimateTokens(outputText) - estimateTokens(replacement)
        toolPart.state.output = replacement
      }
    }

    if (stats.compressed > 0) {
      console.log(`[ccr] compressed ${stats.compressed} tool output(s), ~${stats.tokensSaved} tokens saved`)
    }
    if (stats.imagesResized) {
      console.log(`[ccr] images: ${stats.imagesResized} history screenshot(s) resized to fit 512`)
    }
  }
}
