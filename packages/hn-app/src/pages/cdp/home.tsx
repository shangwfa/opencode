import { useEffect, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"
import { ArrowUp, ChevronDown, Code2, Globe, LoaderCircle, Monitor, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { browserApi, browserPrompt, type BrowserScript } from "@/lib/browser"
import { useProviderList, pickFirstModel } from "@/hooks/use-provider-list"
import { useLocal } from "@/context/local"
import { BrowserNavigationToggle } from "./layout"

export function CdpHome() {
  const [text, setText] = useState("")
  const [scripts, setScripts] = useState<BrowserScript[]>([])
  const [selected, setSelected] = useState("")
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
          const script = query.get("script")
          if (script) setSelected(script)
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
      const prompt = browserPrompt(text, selected ? "/workspace/output/published-script.js" : null)
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
    <div className="cdp-home flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="cdp-page-header flex shrink-0 items-center justify-between border-b px-6">
        <span className="flex items-center gap-3 text-sm font-semibold"><BrowserNavigationToggle /><span className="chat-ai-mark" aria-hidden />自动化工作区</span>
        <span className="cdp-header-note flex items-center gap-1.5 text-xs text-muted-foreground">
          <Monitor className="size-3.5" />
          独立会话沙箱
        </span>
      </header>
      <div className="cdp-home-content mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center px-5 pb-20 pt-12 md:px-10">
        <h1 className="cdp-home-title text-3xl tracking-tight md:text-[36px] md:leading-[1.3]">
          把重复的工作，交给自动化。
        </h1>
        <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
          描述目标，AI 帮你完成网页操作、文件与数据处理。浏览器画面实时可见，需要登录或确认时随时接管。
        </p>
        {selected && (
          <div className="mb-3 mt-7 flex">
            <span className="cdp-script-chip inline-flex max-w-full items-center gap-1.5 rounded-full px-3 py-1 text-xs">
              <Code2 className="size-3.5 shrink-0" />
              <span className="truncate">流程：{scripts.find((script) => script.id === selected)?.name ?? "已选脚本"}</span>
              <button type="button" aria-label="移除流程" className="shrink-0 rounded-full p-0.5 hover:bg-background" onClick={() => setSelected("")}>
                <X className="size-3" />
              </button>
            </span>
          </div>
        )}
        <form
          className="cdp-task-input overflow-hidden rounded-2xl border border-border bg-card transition-shadow focus-within:ring-2 focus-within:ring-ring/10"
          onSubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <Textarea
            autoFocus
            aria-label="浏览器任务"
            placeholder={
              "例如：打开影刀官网，整理产品功能与定价信息…"
            }
            value={text}
            disabled={creating}
            onChange={(event) => setText(event.target.value)}
            className="max-h-56 min-h-20 resize-none rounded-none border-0 bg-transparent px-4 pt-4 pb-2 text-base leading-6 shadow-none focus-visible:ring-0 md:text-[15px] dark:bg-transparent"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault()
                void create()
              }
            }}
          />
          <div className="flex min-h-12 items-center justify-between gap-3 px-3 pb-2.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="选择浏览器任务模型"
                  className="max-w-[80%] gap-2 rounded-full text-[13px] font-normal text-muted-foreground"
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
              <DropdownMenuContent className="chat-menu max-h-80 max-w-sm overflow-y-auto" align="start">
                {providers?.all.flatMap((provider) =>
                  Object.entries(provider.models).map(([id, item]) => (
                    <DropdownMenuItem
                      key={`${provider.id}/${id}`}
                      className={model?.providerID === provider.id && model.modelID === id ? "chat-menu-selected" : undefined}
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
              className="size-9 shrink-0 rounded-full disabled:bg-foreground/10 disabled:text-muted-foreground disabled:opacity-100"
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
          <p className="cdp-input-hint mt-3 text-right text-xs text-muted-foreground">Enter 发送 · Shift + Enter 换行</p>
        )}
        <div className="cdp-shortcuts mt-8 grid gap-3 sm:grid-cols-2">
          <button
            className="group flex items-start gap-3 rounded-xl border border-transparent p-4 text-left transition-colors hover:border-border hover:bg-muted/30"
            onClick={() => {
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
            to="/cdp/apps"
            className="group flex items-start gap-3 rounded-xl border border-transparent p-4 transition-colors hover:border-border hover:bg-muted/30"
          >
            <Code2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="text-[13px] font-medium">复用已完成的流程</span>
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
