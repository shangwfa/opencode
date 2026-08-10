import { useCallback, useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react'
import type { AgentFile } from '../lib/api'
import { api } from '../lib/api'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

interface Props {
  agentId: string
  onCountChange?: (count: number) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
}

function isTextLike(name: string): boolean {
  return /\.(txt|md|json|csv|tsv|xml|ya?ml|html?|js|ts|py|sh|log)$/i.test(name)
}

function FileIcon({ name }: { name: string }) {
  const cls = 'size-4 shrink-0'
  if (isImage(name)) return <FileImage className={cn(cls, 'text-emerald-500')} />
  if (/\.(json)$/i.test(name)) return <FileJson className={cn(cls, 'text-yellow-500')} />
  if (/\.(csv|tsv|xlsx?)$/i.test(name))
    return <FileSpreadsheet className={cn(cls, 'text-green-600')} />
  if (/\.(html?|js|ts|py|sh|css)$/i.test(name))
    return <FileCode className={cn(cls, 'text-orange-500')} />
  if (/\.(txt|md|log)$/i.test(name)) return <FileText className={cn(cls, 'text-blue-500')} />
  return <File className={cn(cls, 'text-muted-foreground')} />
}

export default function FilesPanel({ agentId, onCountChange }: Props) {
  const [files, setFiles] = useState<AgentFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<AgentFile | null>(null)
  const [preview, setPreview] = useState<{ kind: 'text' | 'image' | 'html'; data: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.listFiles(agentId)
      setFiles(list)
      onCountChange?.(list.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [agentId, onCountChange])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function openFile(file: AgentFile) {
    setSelected(file)
    setPreview(null)
    setPreviewLoading(true)
    try {
      const { contentBase64 } = await api.readFile(agentId, file.path)
      if (isImage(file.name)) {
        const ext = file.name.split('.').pop()?.toLowerCase()
        const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
        setPreview({ kind: 'image', data: `data:${mime};base64,${contentBase64}` })
      } else if (/\.html?$/i.test(file.name)) {
        const html = new TextDecoder().decode(
          Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0)),
        )
        setPreview({ kind: 'html', data: html })
      } else if (isTextLike(file.name)) {
        const text = new TextDecoder().decode(
          Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0)),
        )
        setPreview({ kind: 'text', data: text })
      } else {
        setPreview(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSelected(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function downloadFile(file: AgentFile) {
    const { contentBase64 } = await api.readFile(agentId, file.path)
    const bytes = Uint8Array.from(atob(contentBase64), (c) => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes]))
    const a = document.createElement('a')
    a.href = url
    a.download = file.name
    a.click()
    URL.revokeObjectURL(url)
  }

  const groups = files.reduce<Record<string, AgentFile[]>>((acc, file) => {
    const dir = file.path.split('/').slice(2, -1).join('/') || '.'
    acc[dir] = acc[dir] ?? []
    acc[dir].push(file)
    return acc
  }, {})
  const groupNames = Object.keys(groups).sort((a, b) => (a === '.' ? 1 : b === '.' ? -1 : a.localeCompare(b)))

  if (selected) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Button variant="ghost" size="icon-sm" onClick={() => setSelected(null)}>
            <X />
          </Button>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected.path}</span>
          <span className="text-xs text-muted-foreground">{formatSize(selected.size)}</span>
          <Button variant="ghost" size="icon-sm" onClick={() => downloadFile(selected)}>
            <Download />
          </Button>
        </div>
        <div className={cn('flex-1 overflow-auto', preview?.kind === 'html' ? '' : 'p-3')}>
          {previewLoading && (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
          {!previewLoading && preview?.kind === 'image' && (
            <img src={preview.data} alt={selected.name} className="mx-auto max-w-full" />
          )}
          {!previewLoading && preview?.kind === 'html' && (
            <iframe
              srcDoc={preview.data}
              sandbox="allow-scripts"
              title={selected.name}
              className="h-full w-full bg-white"
            />
          )}
          {!previewLoading && preview?.kind === 'text' && (
            <pre className="font-mono text-xs whitespace-pre-wrap break-all">{preview.data}</pre>
          )}
          {!previewLoading && !preview && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <FileText className="size-8" />
              <p>此文件类型不支持预览</p>
              <Button variant="outline" size="sm" onClick={() => downloadFile(selected)}>
                <Download />
                下载文件
              </Button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">/workspace</span>
        <Button variant="ghost" size="icon-sm" onClick={refresh} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {loading && files.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="p-4 text-center text-xs text-muted-foreground">{error}</p>
        ) : files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <FolderOpen className="size-8" />
            <p className="text-sm">暂无文件</p>
            <p className="text-xs">AI 生成的文件会显示在这里</p>
          </div>
        ) : (
          groupNames.map((dir) => {
            const groupFiles = groups[dir]
            const isCollapsed = collapsed[dir] ?? false
            return (
              <div key={dir}>
                {dir !== '.' && (
                  <button
                    onClick={() =>
                      setCollapsed((prev) => ({ ...prev, [dir]: !isCollapsed }))
                    }
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium hover:bg-accent/50"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    )}
                    <FolderOpen className="size-4 text-orange-400" />
                    {dir}
                  </button>
                )}
                {!isCollapsed &&
                  groupFiles.map((file) => (
                    <div
                      key={file.path}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-accent/50',
                        dir !== '.' && 'ml-5',
                      )}
                    >
                      <button
                        onClick={() => openFile(file)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <FileIcon name={file.name} />
                        <span className="truncate text-sm">{file.name}</span>
                      </button>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatSize(file.size)}
                      </span>
                      <button
                        onClick={() => downloadFile(file)}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      >
                        <Download className="size-3.5" />
                      </button>
                    </div>
                  ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
