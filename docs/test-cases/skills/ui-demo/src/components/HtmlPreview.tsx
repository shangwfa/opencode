import { useEffect, useState } from "react"
import { ExternalLink, Loader2, X } from "lucide-react"

interface HtmlPreviewProps {
  sessionId: string
  filePath: string
  onClose: () => void
}

export function HtmlPreview({ sessionId, filePath, onClose }: HtmlPreviewProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    import("../api").then(({ readSandboxFile }) =>
      readSandboxFile(sessionId, filePath)
        .then(setHtml)
        .catch((e) => setError(String(e))),
    )
  }, [sessionId, filePath])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-xs text-gray-500">{filePath}</p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                if (html) {
                  const blob = new Blob([html], { type: "text/html" })
                  window.open(URL.createObjectURL(blob), "_blank")
                }
              }}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              title="在新标签页打开"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1">
          {error ? (
            <div className="flex h-full items-center justify-center p-6 text-sm text-red-500">
              {error}
            </div>
          ) : html === null ? (
            <div className="flex h-full items-center justify-center text-gray-400">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <iframe
              srcDoc={html}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin"
              title={filePath}
            />
          )}
        </div>
      </div>
    </div>
  )
}
