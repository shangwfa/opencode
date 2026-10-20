/**
 * 草稿文本写入 prompt parts（附件保留）。
 *
 * 事实：composer 的文本存在本地 state，prompt store 里原本只有历史遗留的空 text part；
 * 页面 handleSubmit 直接 `prompt.set([{type:"text"}])` 会把 image/file 附件整块覆盖掉，
 * 导致粘贴的图片不随请求发送。此处改为「更新或补上 text part，其余 parts 原样保留」。
 */
import type { Prompt, TextPart } from "@/context/prompt"

export function withDraftText(parts: Prompt, text: string): Prompt {
  const next: TextPart = { type: "text", content: text, start: 0, end: text.length }
  const hasText = parts.some((part) => part.type === "text")
  if (!hasText) return [...parts, next]
  let written = false
  return parts.map((part) => {
    if (part.type !== "text") return part
    if (written) return { ...part, content: "", start: text.length, end: text.length }
    written = true
    return { ...part, content: text, start: 0, end: text.length }
  })
}