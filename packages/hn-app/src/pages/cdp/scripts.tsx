import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router"
import { ArrowLeft, ArrowUpRight, Code2, Globe, LockKeyhole, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { browserApi, type BrowserScript, type BrowserVersion } from "@/lib/browser"
import { useAuth } from "@/lib/auth"
import { PublishScriptDialog } from "@/features/browser-cdp/publish-script-dialog"
import { BrowserNavigationToggle } from "./layout"

export function CdpScripts() {
  const [scripts, setScripts] = useState<BrowserScript[]>([])
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [publish, setPublish] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await browserApi.scripts()
      setScripts(result.items)
      setError("")
    } catch (cause) {
      setError(String(cause))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const filtered = scripts.filter((script) =>
    `${script.name} ${script.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  return (
    <div className="cdp-collection flex min-h-0 flex-1 flex-col overflow-y-auto p-5 md:p-8">
      <header className="mb-7 flex items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2"><BrowserNavigationToggle /><h1 className="text-xl font-semibold tracking-tight">脚本库</h1></div>
          <p className="mt-2 text-sm text-muted-foreground">把成功执行的流程，变成下一次工作的起点。</p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => setPublish(true)}>
          <Plus className="size-4" />
          发布脚本
        </Button>
      </header>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="搜索脚本"
        placeholder="搜索脚本名称或说明…"
        className="mb-6 max-w-sm"
      />
      {error && (
        <div role="alert" className="mb-4 flex items-center gap-3 text-sm text-destructive">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          正在加载脚本…
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map((script) => (
            <Link
              key={script.id}
              to={`/cdp/scripts/${script.id}`}
              className="cdp-script-card group rounded-xl border p-5 transition-colors hover:bg-muted/30"
            >
              <div className="flex items-center gap-3">
                <Code2 className="size-4 text-muted-foreground" />
                <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{script.name}</h2>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                  v{script.version}
                </span>
                <ArrowUpRight className="size-4 text-muted-foreground" />
              </div>
              <p className="mt-3 line-clamp-2 min-h-10 text-xs leading-5 text-muted-foreground">
                {script.description || "暂无说明"}
              </p>
              <div className="mt-4 flex items-center justify-between border-t pt-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  {script.visibility === "public" ? <Globe className="size-3" /> : <LockKeyhole className="size-3" />}
                  {script.visibility === "public" ? "公开" : "私有"}
                </span>
                <span>{new Date(script.timeUpdated).toLocaleDateString()}</span>
              </div>
            </Link>
          ))}
          {!filtered.length && (
            <p className="col-span-full py-16 text-center text-sm text-muted-foreground">
              {query ? "没有匹配的脚本" : "还没有脚本，完成浏览器任务后可以发布可复用流程。"}
            </p>
          )}
        </div>
      )}
      <PublishScriptDialog open={publish} onOpenChange={setPublish} onPublished={() => void load()} />
    </div>
  )
}

export function CdpScriptDetail() {
  const { scriptId = "" } = useParams()
  const { user } = useAuth()
  const [result, setResult] = useState<Awaited<ReturnType<typeof browserApi.script>> | null>(null)
  const [version, setVersion] = useState<BrowserVersion | null>(null)
  const [error, setError] = useState("")
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [visibility, setVisibility] = useState<"private" | "public">("private")
  const [busy, setBusy] = useState(false)
  const currentId = useRef(scriptId)
  currentId.current = scriptId
  const load = useCallback(async () => {
    try {
      const res = await browserApi.script(scriptId)
      if (currentId.current !== scriptId) return
      setResult(res)
      setName(res.script.name)
      setDescription(res.script.description)
      setVisibility(res.script.visibility)
      setVersion(null)
      setError("")
    } catch (cause) {
      if (currentId.current === scriptId) setError(String(cause))
    }
  }, [scriptId])
  useEffect(() => {
    setResult(null)
    void load()
  }, [load])
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError("")
    try {
      await fn()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="cdp-collection flex min-h-0 flex-1 flex-col overflow-y-auto p-5 md:p-8">
      <div className="mb-6 flex items-center gap-2"><BrowserNavigationToggle /><Link to="/cdp/scripts" className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
        <ArrowLeft className="size-3" />
        返回脚本库
      </Link></div>
      {error && (
        <div role="alert" className="mb-4 text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            重新加载
          </Button>
        </div>
      )}
      {result && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold">{result.script.name}</h1>
              <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">
                {result.script.description || "暂无说明"}
              </p>
            </div>
            <Button size="sm" asChild>
              <Link to={`/cdp?script=${encodeURIComponent(scriptId)}`}>
                执行流程
                <ArrowUpRight className="ml-2 size-3.5" />
              </Link>
            </Button>
          </div>
          {result.script.ownerId === user?.id && (
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing((value) => !value)}>
                编辑信息
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("删除脚本？已发布的版本将不可再访问。"))
                    void action(async () => {
                      await browserApi.deleteScript(scriptId)
                      window.location.hash = "#/cdp/scripts"
                    })
                }}
              >
                <Trash2 className="mr-2 size-3.5" />
                删除脚本
              </Button>
            </div>
          )}
          {editing && (
            <form
              className="mt-4 space-y-3 rounded-xl border p-4"
              onSubmit={(e) => {
                e.preventDefault()
                void action(async () => {
                  await browserApi.update(scriptId, { name, description, visibility })
                  setEditing(false)
                  await load()
                })
              }}
            >
              <Input
                aria-label="脚本名称"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
              />
              <Input
                aria-label="脚本说明"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={4000}
              />
              <select
                aria-label="可见范围"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={visibility}
                onChange={(e) => setVisibility(e.target.value as "private" | "public")}
              >
                <option value="private">仅自己可见</option>
                <option value="public">所有登录用户可见</option>
              </select>
              <Button className="ml-3" size="sm" disabled={busy}>
                保存
              </Button>
            </form>
          )}
          <div className="mb-3 mt-7 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-medium">脚本内容</h2>
            <select
              aria-label="脚本版本"
              value={version?.version ?? result.script.version}
              className="h-8 rounded-md border bg-background px-2 text-xs"
              disabled={busy}
              onChange={(e) =>
                void action(async () => {
                  const res = await browserApi.version(scriptId, Number(e.target.value))
                  if (currentId.current === scriptId) setVersion(res)
                })
              }
            >
              {result.versions.map((item) => (
                <option key={item.version} value={item.version}>
                  v{item.version} · {new Date(item.timeCreated).toLocaleDateString()} {item.changelog}
                </option>
              ))}
            </select>
          </div>
          <pre className="min-h-40 overflow-x-auto rounded-xl border bg-muted/20 p-5 text-xs leading-6">
            <code>{version?.content ?? result.content}</code>
          </pre>
          {(version?.changelog ?? result.versions[0]?.changelog) && (
            <p className="mt-3 text-xs text-muted-foreground">
              版本说明：{version?.changelog ?? result.versions[0]?.changelog}
            </p>
          )}
        </>
      )}
    </div>
  )
}
