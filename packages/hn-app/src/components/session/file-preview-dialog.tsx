/**
 * 沙箱文件预览弹窗（HTML / 图片 / Markdown / 文本）。
 *
 * 数据来源：GET /file/content?path=&sessionID=（当前部署无端口代理，HTML 以 srcdoc 内联渲染，
 * 因此相对路径资源不解析；模型产出的单文件 HTML（内联 CSS/JS）可完整呈现）。
 */
import { useEffect, useMemo, useState } from "react"
import { Code2, Copy, Download, Eye, FileWarning } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import { readSandboxFile } from "@/lib/rest"
import { Markdown } from "./markdown"
import {
  guessMimeType,
  parentDirectoryOf,
  parseSandboxFileHref,
  previewKindOf,
  type PreviewKind,
} from "./file-preview-url"
import { cn } from "@/lib/utils"

type Loaded = { kind: PreviewKind; content: string; filename: string; path: string; binary: boolean }

export function FilePreviewDialog({
  href,
  directory,
  sessionId,
  onOpenChange,
}: {
  /** file:// 或绝对路径链接 */
  href?: string
  directory?: string
  sessionId?: string
  onOpenChange: (open: boolean) => void
}) {
  const [state, setState] = useState<{ loading: boolean; data?: Loaded; error?: string }>({ loading: false })
  const [showSource, setShowSource] = useState(false)

  const ref = useMemo(() => parseSandboxFileHref(href), [href])
  const kind = ref ? previewKindOf(ref.path) : "unsupported"

  useEffect(() => {
    if (!ref) return
    if (previewKindOf(ref.path) === "unsupported") return
    let cancelled = false
    setState({ loading: true })
    setShowSource(false)
    // 事实（实测）：通道 A = /api/session/:id/fs/read（V2 网关，部分部署未挂载）；
    // 通道 B = /file/content（本地 14096 上游 v2）。绝对路径未带 directory 时用父目录兜底。
    const dir = directory?.trim() || parentDirectoryOf(ref.path)
    readSandboxFile(ref.path, { directory: dir, sessionId, mime: guessMimeType(ref.path) })
      .then((res) => {
        if (cancelled) return
        const kind = previewKindOf(ref.path)
        setState({
          loading: false,
          data: {
            kind,
            content: res.content,
            filename: ref.filename,
            path: ref.path,
            binary: res.binary,
          },
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState({ loading: false, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [ref, directory, sessionId])

  const download = () => {
    if (!state.data) return
    const blob = new Blob([state.data.content], { type: guessMimeType(state.data.path) })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = state.data.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const copy = () => {
    if (state.data) void navigator.clipboard?.writeText(state.data.content)
  }

  const open = !!ref && kind !== "unsupported"
  const canToggleSource = kind === "html"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1100px,92vw)]">
        <DialogHeader className="border-border/70 gap-1 border-b px-5 py-3.5">
          <DialogTitle className="flex min-w-0 items-center gap-2 text-sm">
            <span className="truncate">{ref?.filename ?? "文件"}</span>
            <span className="text-muted-foreground shrink-0 text-[11px] font-normal">{kindLabel(kind)}</span>
          </DialogTitle>
          <DialogDescription className="truncate font-mono text-[11px]">{ref?.path}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1.5 border-b px-4 py-2">
          {canToggleSource && (
            <Button
              variant={showSource ? "secondary" : "ghost"}
              size="sm"
              className="h-7 gap-1.5 rounded-md px-2 text-xs"
              onClick={() => setShowSource((v) => !v)}
            >
              {showSource ? <Eye className="size-3.5" /> : <Code2 className="size-3.5" />}
              {showSource ? "预览" : "源码"}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 rounded-md px-2 text-xs" onClick={copy} disabled={!state.data}>
            <Copy className="size-3.5" />
            复制
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 rounded-md px-2 text-xs" onClick={download} disabled={!state.data}>
            <Download className="size-3.5" />
            下载
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto bg-background">
          {state.loading ? (
            <div className="text-muted-foreground flex h-full min-h-40 items-center justify-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              正在读取沙箱文件…
            </div>
          ) : state.error ? (
            <EmptyState
              icon={<FileWarning className="size-5" />}
              title="读取失败"
              detail={state.error}
            />
          ) : !state.data ? (
            <EmptyState
              icon={<FileWarning className="size-5" />}
              title="暂不支持预览"
              detail={`${ref?.filename ?? "该文件"}的类型无法在页面内渲染，可在沙箱中查看。`}
            />
          ) : (
            <PreviewBody data={state.data} showSource={showSource} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function kindLabel(kind: PreviewKind) {
  if (kind === "html") return "HTML"
  if (kind === "image") return "图片"
  if (kind === "markdown") return "Markdown"
  if (kind === "text") return "文本"
  return "文件"
}

function PreviewBody({ data, showSource }: { data: Loaded; showSource: boolean }) {
  if (!data.content.trim()) {
    return <EmptyState title="文件为空" detail="沙箱中该文件没有内容。" />
  }

  if (data.kind === "html" && !showSource) {
    return (
      <iframe
        title={data.filename}
        // 不给 same-origin：沙箱内脚本无法访问宿主页面
        sandbox="allow-scripts allow-forms allow-popups"
        srcDoc={data.content}
        className="h-full min-h-[60vh] w-full bg-white"
      />
    )
  }

  if (data.kind === "image") {
    // 通道 A 返回 base64；通道 B 的 type=raw 同样是 base64
    const src = `data:${guessMimeType(data.path)};base64,${data.content}`
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <img src={src} alt={data.filename} className="max-h-[70vh] max-w-full object-contain" />
      </div>
    )
  }

  if (data.kind === "markdown" && !showSource) {
    return (
      <div className="mx-auto w-full max-w-3xl px-6 py-5">
        <Markdown content={data.content} />
      </div>
    )
  }

  return (
    <pre className="text-muted-foreground p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap">{data.content}</pre>
  )
}

function EmptyState({ icon, title, detail }: { icon?: React.ReactNode; title: string; detail: string }) {
  return (
    <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">{icon}</div>}
      <p className={cn("text-sm font-medium")}>{title}</p>
      <p className="text-muted-foreground max-w-md text-xs leading-relaxed">{detail}</p>
    </div>
  )
}