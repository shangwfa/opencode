import { useEffect, useState } from "react"
import {
  Loader2,
  Maximize2,
  Minimize2,
  FileText,
  X,
} from "lucide-react"
import { Streamdown } from "streamdown"
import type { FilePreview } from "../types"
import { streamdownPlugins } from "../constants"

export function FilePreviewModal({
  file,
  sessionId,
  onClose,
}: {
  file: FilePreview
  sessionId: string
  onClose: () => void
}) {
  const isHtml = file.filePath.endsWith(".html") || file.filePath.endsWith(".htm")
  const writing = file.status !== "completed" && file.status !== "error"
  const [mode, setMode] = useState<"preview" | "source">("preview")
  const [fullscreen, setFullscreen] = useState(isHtml)
  const [remoteContent, setRemoteContent] = useState<string | null>(null)
  useEffect(() => {
    if (file.content || writing) return
    let cancelled = false
    fetch(`/opencode/file/content?path=${encodeURIComponent(file.filePath)}&sessionID=${encodeURIComponent(sessionId)}`, {
      signal: AbortSignal.timeout(30000),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { content?: string } | null) => {
        if (!cancelled && data?.content) setRemoteContent(data.content)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [file.filePath, file.content, writing, sessionId])
  const content = file.content || remoteContent || ""
  return (
    <div className={fullscreen ? "fixed inset-0 z-50" : "modal-backdrop"} onClick={onClose}>
      <div
        className={
          fullscreen
            ? "flex h-full w-full flex-col bg-white"
            : "flex h-[85vh] w-[90%] max-w-[860px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        }
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-[#e8edf3] px-5 py-3.5">
          <FileText size={16} className="shrink-0 text-[#5b8def]" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-[#253141]">{file.filePath.split("/").pop()}</div>
            <div className="truncate font-mono text-[10px] text-[#8b96a5]">{file.filePath}</div>
          </div>
          {writing && (
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#f0f4ff] px-2.5 py-1 text-[10px] font-semibold text-[#3159ef]">
              <Loader2 size={11} className="animate-spin" />
              正在写入
            </span>
          )}
          {isHtml && (
            <div className="flex shrink-0 rounded-md border border-[#dde4ec] p-0.5">
              {(["preview", "source"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rounded px-2.5 py-1 text-[10px] font-semibold transition-colors ${
                    mode === value ? "bg-[#3159ef] text-white" : "text-[#69768a] hover:text-[#253141]"
                  }`}
                  onClick={() => setMode(value)}
                >
                  {value === "preview" ? "预览" : "源码"}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#7c8794] transition-colors hover:bg-[#f2f5f9] hover:text-[#253141]"
            onClick={() => setFullscreen((value) => !value)}
            title={fullscreen ? "退出全屏" : "全屏"}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#7c8794] transition-colors hover:bg-[#f2f5f9] hover:text-[#253141]"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        {isHtml && mode === "preview" ? (
          <iframe
            title={file.filePath}
            sandbox="allow-scripts"
            srcDoc={content}
            className="min-h-0 flex-1 border-0 bg-white"
          />
        ) : isHtml ? (
          <pre className="min-h-0 flex-1 overflow-auto bg-[#f7f9fc] px-5 py-4 font-mono text-[11px] leading-relaxed text-[#3d4a5c]">
            {content}
          </pre>
        ) : (
          <div className="markdown-content min-h-0 flex-1 overflow-y-auto px-7 py-5 text-[13px] leading-relaxed text-[#3d4a5c]">
            <Streamdown plugins={streamdownPlugins}>{content}</Streamdown>
          </div>
        )}
      </div>
    </div>
  )
}
