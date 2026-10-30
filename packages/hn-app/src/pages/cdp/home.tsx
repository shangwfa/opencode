import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { ArrowUp, ChevronDown, Code2, Globe, LoaderCircle, Monitor, ScanEye, Workflow } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { browserApi, browserPrompt, type BrowserScript } from "@/lib/browser"
import { useProviderList, pickFirstModel } from "@/hooks/use-provider-list"
import { useLocal } from "@/context/local"

export function CdpHome() {
  const [text, setText] = useState("")
  const [review, setReview] = useState(false)
  const [scripts, setScripts] = useState<BrowserScript[]>([])
  const [selected, setSelected] = useState("")
  const [picker, setPicker] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState("")
  const busy = useRef(false)
  const navigate = useNavigate()
  const [query] = useSearchParams()
  const { providers } = useProviderList()
  const local = useLocal()
  const stored = local.model.current()
  const model =
    stored && providers?.all.find((p) => p.id === stored.providerID)?.models[stored.modelID]
      ? stored
      : pickFirstModel(providers)
  useEffect(() => {
    let disposed = false
    void browserApi
      .scripts()
      .then(({ items }) => {
        if (!disposed) {
          setScripts(items)
          if (query.get("script")) {
            setPicker(true)
            setSelected(query.get("script")!)
          }
        }
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      disposed = true
    }
  }, [query])
  const create = async () => {
    if (busy.current || (!text.trim() && !selected) || !model) return
    busy.current = true
    setCreating(true)
    setError("")
    try {
      const result = await browserApi.create({
        title: (text.trim() || scripts.find((script) => script.id === selected)?.name || "执行浏览器流程").slice(
          0,
          200,
        ),
        ...(selected ? { scriptId: selected } : {}),
      })
      // 脚本由服务端物化到固定路径；首条消息直接引用它。
      const prompt = browserPrompt(text, review, selected ? "/workspace/output/published-script.js" : null)
      navigate(`/cdp/session/${result.session.id}`, {
        state: { prompt, model },
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      busy.current = false
      setCreating(false)
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
        <span className="text-[13px] font-medium">浏览器工作区</span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          独立会话沙箱
        </span>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 pb-20 pt-12 md:px-10">
        <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border bg-muted/30">
          <Monitor className="size-6" strokeWidth={1.5} />
        </div>
        <h1 className="text-3xl font-semibold tracking-tight md:text-[38px] md:leading-[1.2]">
          让浏览器替你完成工作。
        </h1>
        <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
          描述目标，AI 在真实浏览器中操作。你可以实时观察，在登录或确认操作时随时接管。
        </p>
        <div className="mb-4 mt-9 flex flex-wrap gap-2">
          <Button
            variant={picker ? "secondary" : "outline"}
            size="sm"
            className="gap-2 rounded-full"
            onClick={() => {
              setPicker((v) => !v)
              if (picker) setSelected("")
            }}
          >
            <Workflow className="size-3.5" />
            执行流程
          </Button>
          <Button
            variant={review ? "secondary" : "outline"}
            size="sm"
            className="gap-2 rounded-full"
            aria-pressed={review}
            onClick={() => setReview((v) => !v)}
          >
            <ScanEye className="size-3.5" />
            UI 走查
          </Button>
          {review && <span className="self-center px-1 text-xs text-muted-foreground">检查页面、交互与响应式体验</span>}
        </div>
        {picker && (
          <div className="mb-3 rounded-xl border p-3">
            <label className="text-xs font-medium" htmlFor="cdp-script">
              选择已发布流程
            </label>
            <select
              id="cdp-script"
              className="mt-2 h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">不使用脚本</option>
              {scripts.map((script) => (
                <option key={script.id} value={script.id}>
                  {script.name} · v{script.version}
                </option>
              ))}
            </select>
            {!scripts.length && (
              <p className="mt-2 text-xs text-muted-foreground">
                暂无已发布脚本。完成一次任务后，可以将流程发布到脚本库。
              </p>
            )}
          </div>
        )}
        <form
          className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/20"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Textarea
            autoFocus
            aria-label="浏览器任务"
            placeholder={
              review ? "输入页面地址，说明你想重点检查的内容…" : "例如：打开影刀官网，整理产品功能与定价信息…"
            }
            value={text}
            disabled={creating}
            onChange={(event) => setText(event.target.value)}
            className="min-h-32 resize-none rounded-none border-0 p-5 text-sm shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void create()
              }
            }}
          />
          <div className="flex min-h-16 items-center justify-between gap-3 px-4 pb-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-w-[80%] gap-2 text-xs"
                  disabled={creating}
                >
                  <span className="truncate">
                    {model
                      ? (providers?.all.find((p) => p.id === model.providerID)?.models[model.modelID]?.name ??
                        model.modelID)
                      : "选择模型"}
                  </span>
                  <ChevronDown className="size-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="max-h-80 max-w-sm overflow-y-auto" align="start">
                {providers?.all.flatMap((provider) =>
                  Object.entries(provider.models).map(([id, item]) => (
                    <DropdownMenuItem
                      key={`${provider.id}/${id}`}
                      onSelect={() => local.model.set({ providerID: provider.id, modelID: id })}
                    >
                      {provider.name} / {item.name || id}
                    </DropdownMenuItem>
                  )),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="submit"
              size="icon"
              aria-label="开始浏览器任务"
              className="size-10 shrink-0 rounded-full"
              disabled={creating || (!text.trim() && !selected) || !model}
            >
              {creating ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-5" />}
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="mt-3 break-words text-sm text-destructive">
            {error}
          </p>
        )}
        {creating ? (
          <p role="status" className="mt-3 text-xs text-muted-foreground">
            正在创建会话和准备浏览器，首次启动可能需要稍等…
          </p>
        ) : (
          <p className="mt-3 text-right text-xs text-muted-foreground">Enter 发送 · Shift + Enter 换行</p>
        )}
        <div className="mt-10 grid gap-3 sm:grid-cols-2">
          <button
            className="group flex items-start gap-3 rounded-xl border border-transparent p-4 text-left transition-colors hover:border-border hover:bg-muted/30"
            onClick={() => {
              setReview(false)
              setText("打开 https://example.com，整理页面的主要信息，并提供截图作为依据。")
            }}
          >
            <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="text-[13px] font-medium">浏览与信息整理</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                访问网页，提取信息，留下执行依据。
              </span>
            </span>
          </button>
          <Link
            to="/cdp/scripts"
            className="group flex items-start gap-3 rounded-xl border border-transparent p-4 transition-colors hover:border-border hover:bg-muted/30"
          >
            <Code2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="text-[13px] font-medium">把流程变成脚本</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                复用已验证的操作，不必每次重新描述。
              </span>
            </span>
          </Link>
        </div>
      </div>
    </div>
  )
}
