import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router"
import { BookOpen, Database, ExternalLink, Loader2, Plus, Search, Table2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { hnApi } from "@/lib/base-api"
import {
  CAPABILITY_LABELS,
  SOURCE_LABELS,
  defaultCapabilities,
  filterBases,
  selectableCapabilities,
  type KnowledgeBaseSummary,
  type KnowledgeCapability,
  type KnowledgeSourceType,
} from "@/lib/knowledge"

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** 工作台统一建库；文档写作直接进入原 hn-docs，知识管理为独立次级入口。 */
export function KnowledgeBasesPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [sourceFilter, setSourceFilter] = useState<KnowledgeSourceType | "all">("all")
  const [bases, setBases] = useState<KnowledgeBaseSummary[]>([])
  const [wizard, setWizard] = useState(false)
  const [sourceType, setSourceType] = useState<KnowledgeSourceType>("documents")
  const [capabilities, setCapabilities] = useState<KnowledgeCapability[]>(defaultCapabilities("documents"))
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [chunkSize, setChunkSize] = useState("800")
  const [chunkOverlap, setChunkOverlap] = useState("120")
  const [wizardError, setWizardError] = useState("")
  const [listError, setListError] = useState("")
  const [loading, setLoading] = useState(true)
  const visible = useMemo(() => filterBases(bases, { query, sourceType: sourceFilter }), [bases, query, sourceFilter])

  const load = async () => {
    try {
      setListError("")
      const result = await hnApi.knowledgeBases()
      setBases(
        result.bases.map((item) => ({
          id: item.id,
          editorUrl: item.editorUrl,
          name: item.name,
          description: item.description,
          sourceType: item.settings?.sourceType ?? "documents",
          capabilities: item.settings?.capabilities ?? ["rag"],
          documentCount: item.documentCount ?? 0,
          publishedCount: item.publishedCount ?? 0,
          failedCount: item.failedCount ?? 0,
          pendingCount: item.pendingCount ?? 0,
          chunkCount: 0,
          status: "ready",
          timeUpdated: Date.now(),
        })),
      )
    } catch (error) {
      setListError(messageOf(error))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openWizard = () => {
    setSourceType("documents")
    setCapabilities(defaultCapabilities("documents"))
    setName("")
    setChunkSize("800")
    setChunkOverlap("120")
    setWizardError("")
    setWizard(true)
  }
  const switchSource = (type: KnowledgeSourceType) => {
    setSourceType(type)
    setCapabilities(defaultCapabilities(type))
  }
  const create = async () => {
    const size = Number(chunkSize)
    const overlap = Number(chunkOverlap)
    if (sourceType === "documents" && (!Number.isInteger(size) || size < 1 || size > 100_000 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size)) {
      setWizardError("块长应为 1–100000 的整数，重叠应小于块长且不小于 0")
      return
    }
    setBusy(true)
    setWizardError("")
    try {
      const result = await hnApi.createKnowledgeBase({
        name: name.trim(),
        sourceType,
        capabilities,
        chunkStrategy: "semantic-markdown",
        chunkSize: size,
        chunkOverlap: overlap,
      })
      setWizard(false)
      if (sourceType === "documents" && result.editorUrl) window.location.assign(result.editorUrl)
      else navigate(`/knowledge/bases/${encodeURIComponent(result.base.id)}`)
    } catch (error) {
      setWizardError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-semibold">知识库</h1>
          <p className="text-muted-foreground mt-1 text-xs">打开文档库进行写作；知识管理用于查看配置、检索与处理状态。</p>
        </div>
        <Button size="sm" onClick={openWizard}><Plus className="mr-1 size-3" />新建知识库</Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="text-muted-foreground absolute left-2.5 top-2.5 size-3.5" />
          <Input className="pl-8" placeholder="搜索知识库…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <select
          aria-label="数据源筛选"
          className="bg-background h-9 rounded-md border px-2 text-xs"
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.target.value as KnowledgeSourceType | "all")}
        >
          <option value="all">全部数据源</option>
          <option value="documents">文档库</option>
          <option value="structured">结构化数据</option>
        </select>
      </div>

      {listError ? <p role="alert" className="text-destructive mt-4 text-xs">{listError}</p> : null}
      {loading ? <p className="text-muted-foreground mt-8 text-xs">正在加载知识库…</p> : visible.length === 0 && !listError ? (
        <div className="mt-10 rounded-xl border bg-card px-6 py-16 text-center">
          <p className="text-sm font-medium">{bases.length ? "没有匹配的知识库" : "暂无知识库"}</p>
          <p className="text-muted-foreground mt-1 text-xs">{bases.length ? "请调整关键词或数据源筛选。" : "在工作台创建知识库后，直接进入原文档页面开始写作。"}</p>
          {bases.length ? <Button size="sm" variant="outline" className="mt-4" onClick={() => { setQuery(""); setSourceFilter("all") }}>清除筛选</Button> : <Button size="sm" className="mt-4" onClick={openWizard}><Plus className="mr-1 size-3" />创建第一个知识库</Button>}
        </div>
      ) : (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((base) => (
            <article key={base.id} className="rounded-xl border bg-card p-4">
              <div className="flex items-center gap-2">
                {base.sourceType === "documents" ? <BookOpen className="size-4" /> : <Table2 className="size-4" />}
                {base.sourceType === "documents" && base.editorUrl ? <a href={base.editorUrl} target="_blank" rel="noreferrer" className="text-[13px] font-medium hover:underline" title="在新标签页打开文档库">{base.name}</a> : <Link to={`/knowledge/bases/${base.id}`} className="text-[13px] font-medium hover:underline">{base.name}</Link>}
              </div>
              <p className="text-muted-foreground mt-1 line-clamp-2 text-[11px]">{base.description ?? ""}</p>
              <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span>{SOURCE_LABELS[base.sourceType]}</span>
                <span>文档 {base.documentCount ?? 0}</span>
                {base.pendingCount ? <span className="text-amber-700">处理中 {base.pendingCount}</span> : null}
                {base.failedCount ? <span className="text-destructive">失败 {base.failedCount}</span> : null}
                {base.capabilities.length ? <span>已启用 {base.capabilities.map((capability) => CAPABILITY_LABELS[capability]).join("、")}</span> : <span>未启用后处理</span>}
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
                {base.sourceType === "documents" && base.editorUrl ? <Button size="sm" asChild><a href={base.editorUrl} target="_blank" rel="noreferrer">打开文档库 <ExternalLink className="ml-1 size-3" /></a></Button> : <span className="text-muted-foreground text-[11px]">数据表导入接入中</span>}
                <Link to={`/knowledge/bases/${base.id}`} className="text-muted-foreground text-xs hover:text-foreground hover:underline">知识管理</Link>
              </div>
            </article>
          ))}
        </div>
      )}

      <Dialog open={wizard} onOpenChange={setWizard}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>创建知识库</DialogTitle>
            <DialogDescription>① 选数据源 → ② 配置 → ③ 启用检索与后处理能力。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-xs">
            <fieldset className="space-y-2">
              <legend className="font-medium">① 数据源</legend>
              {([["documents", BookOpen, "编写/上传详细文档"], ["structured", Database, "表格 + 字段 + 向量列"]] as const).map(([type, Icon, hint]) => (
                <label key={type} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${sourceType === type ? "border-primary" : ""}`}>
                  <input type="radio" name="sourceType" checked={sourceType === type} onChange={() => switchSource(type)} />
                  <span><Icon className="mr-1 inline size-3" />{SOURCE_LABELS[type]}<span className="text-muted-foreground ml-2">{hint}</span></span>
                </label>
              ))}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="font-medium">② 数据源配置</legend>
              <Input placeholder="知识库名称" value={name} onChange={(event) => setName(event.target.value)} />
              {sourceType === "documents" ? (
                <div className="text-muted-foreground grid grid-cols-3 gap-2">
                  <label>切分策略<select className="bg-background mt-1 h-8 w-full rounded-md border px-1"><option>语义切分</option></select></label>
                  <label>块长<Input type="number" min={1} max={100000} className="mt-1 h-8" value={chunkSize} onChange={(event) => setChunkSize(event.target.value)} /></label>
                  <label>重叠<Input type="number" min={0} className="mt-1 h-8" value={chunkOverlap} onChange={(event) => setChunkOverlap(event.target.value)} /></label>
                </div>
              ) : (
                <p className="text-muted-foreground">字段 schema 创建后在库内配置（后续接入）。</p>
              )}
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="font-medium">③ 检索与后处理</legend>
              {selectableCapabilities(sourceType).map((item) => (
                <label key={item.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={capabilities.includes(item.id)}
                    disabled={item.required}
                    onChange={(event) =>
                      setCapabilities((current) =>
                        event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {CAPABILITY_LABELS[item.id]}{item.required ? "（默认启用）" : ""}
                </label>
              ))}
            </fieldset>
          </div>
          <DialogFooter>
            {wizardError ? <p role="alert" className="text-destructive mr-auto text-xs">{wizardError}</p> : null}
            <Button variant="outline" onClick={() => setWizard(false)}>取消</Button>
            <Button disabled={busy || !name.trim()} onClick={() => void create()}>
              {busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
