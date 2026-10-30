import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { browserApi, type BrowserScript } from "@/lib/browser"
import { useAuth } from "@/lib/auth"
import { computeLineDiff } from "./line-diff"

export function PublishScriptDialog({
  open,
  onOpenChange,
  sessionId,
  onPublished,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId?: string
  onPublished?: () => void
}) {
  const { user } = useAuth()
  const [scripts, setScripts] = useState<BrowserScript[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [existing, setExisting] = useState("")
  const [file, setFile] = useState("")
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [visibility, setVisibility] = useState<"private" | "public">("private")
  const [text, setText] = useState("")
  const [latest, setLatest] = useState<string | null>(null)
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null)
  const [changelog, setChangelog] = useState("")
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    let stopped = false
    setError("")
    setFile("")
    setExisting("")
    setText("")
    setLatest(null)
    setExpectedVersion(null)
    setName("")
    setChangelog("")
    setDescription("")
    setVisibility("private")
    void Promise.all([browserApi.scripts(), sessionId ? browserApi.files(sessionId) : Promise.resolve({ data: [] })])
      .then(([library, sandbox]) => {
        if (stopped) return
        setScripts(library.items.filter((item) => item.ownerId === user?.id))
        setFiles(
          sandbox.data
            .filter((entry) => entry.type !== "directory" && /\.js$/.test(entry.name || entry.path))
            .map((entry) => (entry.name || entry.path).split("/").at(-1)!),
        )
      })
      .catch((cause) => {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      stopped = true
    }
  }, [open, sessionId, user?.id])
  useEffect(() => {
    setLatest(null)
    setExpectedVersion(null)
    if (!existing) return
    let stopped = false
    void browserApi
      .script(existing)
      .then((result) => {
        if (!stopped) {
          setLatest(result.content)
          setExpectedVersion(result.script.version)
        }
      })
      .catch((cause) => {
        if (!stopped) setError(String(cause))
      })
    return () => {
      stopped = true
    }
  }, [existing])
  useEffect(() => {
    if (!file || !sessionId) return
    let stopped = false
    setLoading(true)
    void browserApi
      .file(sessionId, file)
      .then((result) => {
        if (!stopped) setText(result.content)
      })
      .catch((cause) => {
        if (!stopped) setError(String(cause))
      })
      .finally(() => {
        if (!stopped) setLoading(false)
      })
    return () => {
      stopped = true
    }
  }, [file, sessionId])
  const diff = useMemo(() => (latest === null ? null : computeLineDiff(latest, text)), [latest, text])
  const publish = async () => {
    setSaving(true)
    setError("")
    try {
      // 使用已预览的内容发布，避免预览后沙箱文件被 AI 改动而发布另一份内容。
      const source = { content: text }
      if (existing && expectedVersion !== null)
        await browserApi.append(existing, { expectedVersion, source, changelog })
      else await browserApi.publish({ name, description, visibility, source, changelog })
      onPublished?.()
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>发布浏览器脚本</DialogTitle>
          <DialogDescription>将已验证的流程保存为可复用脚本。发布前请移除账号、Cookie 和密钥。</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void publish()
          }}
        >
          <label className="block space-y-2 text-xs font-medium">
            <span>发布目标</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={existing}
              onChange={(e) => setExisting(e.target.value)}
              disabled={saving}
            >
              <option value="">创建新脚本</option>
              {scripts.map((script) => (
                <option key={script.id} value={script.id}>
                  {script.name} · v{script.version}
                </option>
              ))}
            </select>
          </label>
          {!existing && (
            <>
              <label className="block space-y-2 text-xs font-medium">
                <span>脚本名称</span>
                <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
              </label>
              <label className="block space-y-2 text-xs font-medium">
                <span>说明</span>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
              </label>
              <label className="block space-y-2 text-xs font-medium">
                <span>可见范围</span>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value as "private" | "public")}
                >
                  <option value="private">仅自己可见</option>
                  <option value="public">所有登录用户可见</option>
                </select>
              </label>
            </>
          )}
          {sessionId && (
            <label className="block space-y-2 text-xs font-medium">
              <span>从 /workspace/output 选择文件</span>
              <select
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={file}
                onChange={(e) => setFile(e.target.value)}
                disabled={saving}
              >
                <option value="">手动粘贴脚本</option>
                {files.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
              {!files.length && (
                <span className="block font-normal text-muted-foreground">
                  暂无 .js 文件，可让 AI 将流程脚本保存到该目录。
                </span>
              )}
            </label>
          )}
          <label className="block space-y-2 text-xs font-medium">
            <span>脚本内容（最大 256 KiB）</span>
            <Textarea
              className="min-h-48 font-mono text-xs"
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
              disabled={loading || saving}
            />
          </label>
          {diff && (
            <details className="rounded-lg border text-xs">
              <summary className="cursor-pointer p-3">
                版本差异：+{diff.added} / −{diff.removed}
                {diff.equal ? " · 无变化" : ""}
              </summary>
              <pre className="max-h-60 overflow-auto border-t p-3">
                {diff.rows.map((row, index) => (
                  <div
                    key={index}
                    className={
                      row.type === "add"
                        ? "bg-emerald-500/10 text-emerald-700"
                        : row.type === "del"
                          ? "bg-red-500/10 text-red-700"
                          : "text-muted-foreground"
                    }
                  >
                    {row.type === "add" ? "+" : row.type === "del" ? "−" : " "} {row.text}
                  </div>
                ))}
              </pre>
            </details>
          )}
          <label className="block space-y-2 text-xs font-medium">
            <span>版本说明</span>
            <Input value={changelog} onChange={(e) => setChangelog(e.target.value)} maxLength={4000} />
          </label>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={saving || loading || !text.trim() || (!!existing && expectedVersion === null)}>
              {saving ? "正在发布…" : existing ? "发布新版本" : "发布脚本"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
