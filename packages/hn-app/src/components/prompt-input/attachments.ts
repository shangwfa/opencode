/**
 * composer 附件逻辑（React hook 版）。
 * 源：xybot-front-opencode-ui src/components/prompt-input/attachments.ts（Solid）。
 * usePrompt/useLanguage/useSDK/useSync/useParams 上下文 → 注入式依赖（prompt 控制器 / t / sessionId / directory），
 * 粘贴、拖拽、上传降级链（sync → OSS → uploadError 标记）语义 1:1。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { showToast } from "@/ui/components/toast"
import type { ContentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { getCursorPosition } from "./editor-dom"
import { uuid } from "@/utils/uuid"
import { attachmentMime } from "./files"
import { normalizePaste, pasteMode } from "./paste"
import { uploadAttachmentFile } from "@/api/requirement/uploads"
import { syncAttachmentToWorkspace, shouldUseDataUrl } from "@/features/workspace/workspace-sync"
import { MAX_UPLOAD_SIZE } from "@/features/workspace/workspace-config"

/** [MIGRATION] Prompt 控制器最小接口（React 会话壳接入时由 prompt store 提供） */
export type PromptController = {
  current: () => Prompt
  cursor: () => number | undefined
  set: (parts: Prompt, cursor?: number) => void
}

function dataUrl(file: File, mime: string) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => resolve(""))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      const idx = value.indexOf(",")
      if (idx === -1) {
        resolve(value)
        return
      }
      resolve(`data:${mime};base64,${value.slice(idx + 1)}`)
    })
    reader.readAsDataURL(file)
  })
}

type PromptAttachmentsInput = {
  /** 编辑器节点：源项目为 contenteditable div，本项目 composer 用 textarea，故取 HTMLElement */
  editor: () => HTMLElement | undefined
  isDialogActive: () => boolean
  setDraggingType: (type: "image" | "@mention" | null) => void
  focusEditor: () => void
  addPart: (part: ContentPart) => boolean
  readClipboardImage?: () => Promise<File | null>
  prompt: PromptController
  sessionId?: string
  /** sync.effectiveDirectory */
  directory?: string | undefined
  /** i18n（源键：prompt.toast.pasteUnsupported.*） */
  t: (key: string) => string
}

export function usePromptAttachments(input: PromptAttachmentsInput) {
  const [uploadingCount, setUploadingCount] = useState(0)
  const inputRef = useRef(input)
  inputRef.current = input
  const uploading = uploadingCount > 0

  const updateAttachment = useCallback((id: string, patch: Partial<ImageAttachmentPart>) => {
    const prompt = inputRef.current.prompt
    const current = prompt.current()
    const idx = current.findIndex((p) => p.type === "image" && p.id === id)
    if (idx === -1) return
    const updated = current.slice()
    updated[idx] = { ...updated[idx], ...patch } as ImageAttachmentPart
    prompt.set(updated, prompt.cursor())
  }, [])

  const add = useCallback(
    async (file: File, toast = true) => {
      const { prompt, t } = inputRef.current
      const mime = await attachmentMime(file)
      if (!mime) {
        if (toast) {
          showToast({
            title: t("prompt.toast.pasteUnsupported.title"),
            description: t("prompt.toast.pasteUnsupported.description"),
          })
        }
        return false
      }

      if (file.size > MAX_UPLOAD_SIZE) {
        showToast({
          variant: "error",
          title: "文件过大",
          description: `单个文件不能超过 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`,
        })
        return false
      }

      const editor = inputRef.current.editor()
      if (!editor) return false

      const id = uuid()
      const cursor = prompt.cursor() ?? getCursorPosition(editor)
      const useDataUrl = shouldUseDataUrl(file)
      const base64Url = useDataUrl ? await dataUrl(file, mime) : ""
      if (useDataUrl && !base64Url) return false

      prompt.set(
        [...prompt.current(), { type: "image", id, filename: file.name, mime, dataUrl: base64Url }],
        cursor,
      )

      setUploadingCount((n) => n + 1)
      const sid = inputRef.current.sessionId
      const dir = inputRef.current.directory

      // [P2-15] async/await 替代嵌套 promise 链；[P1-7] 全部失败时标记 uploadError
      void (async () => {
        try {
          if (sid && dir) {
            const result = await syncAttachmentToWorkspace({ sessionId: sid, workingDirectory: dir, file })
            updateAttachment(id, { ossUrl: result.ossUrl, workspacePath: result.sandboxRelativePath })
          } else {
            const ossUrl = await uploadAttachmentFile(file)
            updateAttachment(id, { ossUrl })
          }
        } catch {
          // sync 失败 → 降级 OSS
          try {
            const ossUrl = await uploadAttachmentFile(file)
            updateAttachment(id, { ossUrl })
          } catch {
            // [P1-7] 全部失败 → 标记错误，UI 显示失败状态而非静默丢弃
            updateAttachment(id, { ossUrl: "", uploadError: true })
          }
        } finally {
          setUploadingCount((n) => Math.max(0, n - 1))
        }
      })()

      return true
    },
    [updateAttachment],
  )

  const addAttachment = useCallback((file: File) => add(file), [add])

  const addAttachments = useCallback(
    async (files: File[], toast = true) => {
      let found = false

      for (const file of files) {
        const ok = await add(file, false)
        if (ok) found = true
      }

      if (!found && files.length > 0 && toast) {
        const { t } = inputRef.current
        showToast({
          title: t("prompt.toast.pasteUnsupported.title"),
          description: t("prompt.toast.pasteUnsupported.description"),
        })
      }
      return found
    },
    [add],
  )

  const removeAttachment = useCallback((id: string) => {
    const prompt = inputRef.current.prompt
    const current = prompt.current()
    const next = current.filter((part) => part.type !== "image" || part.id !== id)
    prompt.set(next, prompt.cursor())
  }, [])

  const handlePaste = useCallback(
    async (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData
      if (!clipboardData) return

      event.preventDefault()
      event.stopPropagation()

      const files = Array.from(clipboardData.items).flatMap((item) => {
        if (item.kind !== "file") return []
        const file = item.getAsFile()
        return file ? [file] : []
      })

      if (files.length > 0) {
        await addAttachments(files)
        return
      }

      const plainText = clipboardData.getData("text/plain") ?? ""

      // Desktop: Browser clipboard has no images and no text, try platform's native clipboard for images
      if (inputRef.current.readClipboardImage && !plainText) {
        const file = await inputRef.current.readClipboardImage()
        if (file) {
          await addAttachment(file)
          return
        }
      }

      if (!plainText) return

      const text = normalizePaste(plainText)

      const put = () => {
        if (inputRef.current.addPart({ type: "text", content: text, start: 0, end: 0 })) return true
        inputRef.current.focusEditor()
        return inputRef.current.addPart({ type: "text", content: text, start: 0, end: 0 })
      }

      if (pasteMode(text) === "manual") {
        put()
        return
      }

      const inserted = typeof document.execCommand === "function" && document.execCommand("insertText", false, text)
      if (inserted) return

      put()
    },
    [addAttachments, addAttachment],
  )

  const handleGlobalDragOver = useCallback((event: DragEvent) => {
    if (inputRef.current.isDialogActive()) return

    event.preventDefault()
    const hasFiles = event.dataTransfer?.types.includes("Files")
    const hasText = event.dataTransfer?.types.includes("text/plain")
    if (hasFiles) {
      inputRef.current.setDraggingType("image")
    } else if (hasText) {
      inputRef.current.setDraggingType("@mention")
    }
  }, [])

  const handleGlobalDragLeave = useCallback((event: DragEvent) => {
    if (inputRef.current.isDialogActive()) return
    if (!event.relatedTarget) {
      inputRef.current.setDraggingType(null)
    }
  }, [])

  const handleGlobalDrop = useCallback(
    async (event: DragEvent) => {
      if (inputRef.current.isDialogActive()) return

      event.preventDefault()
      inputRef.current.setDraggingType(null)

      const plainText = event.dataTransfer?.getData("text/plain")
      const filePrefix = "file:"
      if (plainText?.startsWith(filePrefix)) {
        const filePath = plainText.slice(filePrefix.length)
        inputRef.current.focusEditor()
        inputRef.current.addPart({ type: "file", path: filePath, content: "@" + filePath, start: 0, end: 0 })
        return
      }

      const dropped = event.dataTransfer?.files
      if (!dropped) return

      await addAttachments(Array.from(dropped))
    },
    [addAttachments],
  )

  // 全局拖拽监听（源：onMount + makeEventListener）
  useEffect(() => {
    document.addEventListener("dragover", handleGlobalDragOver)
    document.addEventListener("dragleave", handleGlobalDragLeave)
    document.addEventListener("drop", (e) => void handleGlobalDrop(e))
    return () => {
      document.removeEventListener("dragover", handleGlobalDragOver)
      document.removeEventListener("dragleave", handleGlobalDragLeave)
      document.removeEventListener("drop", handleGlobalDrop)
    }
  }, [handleGlobalDragOver, handleGlobalDragLeave, handleGlobalDrop])

  return {
    addAttachment,
    addAttachments,
    removeAttachment,
    handlePaste,
    uploading,
  }
}
