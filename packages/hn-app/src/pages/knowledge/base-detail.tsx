import { useEffect, useState } from "react"
import { Link, useParams } from "react-router"
import { ArrowLeft, Search, ExternalLink, BookOpen, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  CAPABILITY_LABELS,
  DETAIL_TAB_LABELS,
  detailTabs,
  type DetailTab,
  SOURCE_LABELS,
} from "@/lib/knowledge"
import { cn } from "@/lib/utils"
import { hnApi, type HnKnowledgeBase, type HnKnowledgeDocument } from "@/lib/base-api"

/** 文档写作由独立 hn-docs 承担，工作台展示知识资产和派生状态。 */
export function KnowledgeBaseDetailPage() {
  const { baseId = "" } = useParams()
  const [base, setBase] = useState<HnKnowledgeBase | null>(null)
  const [documents, setDocuments] = useState<HnKnowledgeDocument[]>([])
  const [editorUrl, setEditorUrl] = useState("")
  const [error, setError] = useState("")
  const [refresh, setRefresh] = useState(0)
  const source = base?.settings?.sourceType ?? "documents"
  const capabilities = base?.settings?.capabilities ?? ["rag"]
  const tabs = detailTabs(source, capabilities)
  const [tab, setTab] = useState<DetailTab>("docs")
  const [docQuery, setDocQuery] = useState("")

  useEffect(() => {
    let active = true
    setError("")
    setBase(null)
    setDocuments([])
    setEditorUrl("")
    Promise.all([hnApi.knowledgeBase(baseId), hnApi.knowledgeDocuments(baseId)])
      .then(([result, docs]) => {
        if (!active) return
        setBase(result.base)
        setEditorUrl(result.editorUrl)
        setDocuments(docs.documents)
      }).catch((error) => { if (active) setError(error instanceof Error ? error.message : "加载失败") })
    return () => { active = false }
  }, [baseId, refresh])

  // 从独立编辑器返回时刷新文档与处理状态。
  useEffect(() => {
    const reload = () => setRefresh((value) => value + 1)
    window.addEventListener("focus", reload)
    return () => window.removeEventListener("focus", reload)
  }, [])

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/knowledge/bases" className="text-muted-foreground inline-flex items-center gap-1 text-[11px] hover:underline">
            <ArrowLeft className="size-3" />知识库
          </Link>
          <h1 className="mt-1 text-[15px] font-semibold">{base?.name ?? "知识库"}</h1>
          <p className="text-muted-foreground mt-1 text-xs">知识管理 · 本页查看处理状态与检索配置，文档写作在原文档库中完成。</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {SOURCE_LABELS[source]} · 已配置 {capabilities.map((capability) => CAPABILITY_LABELS[capability]).join(" / ") || "无后处理"}
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}><RefreshCw className="mr-1 size-3" />刷新</Button>
          {source === "documents" && editorUrl ? <Button size="sm" asChild><a href={editorUrl} target="_blank" rel="noreferrer"><BookOpen className="mr-1 size-3" />打开文档库 <ExternalLink className="ml-1 size-3" /></a></Button> : null}
        </div>
      </div>

      {error ? <p role="alert" className="text-destructive mt-4 text-xs">{error}</p> : null}
      {capabilities.some((item) => item !== "rag") ? <p className="text-muted-foreground mt-3 text-xs">图谱、Wiki 与结构化数据处理配置已保存，本期尚未接通发布派生。</p> : null}

      <div className="mt-4 flex gap-1 border-b">
        {tabs.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTab(item)}
            className={cn(
              "border-b-2 px-3 py-2 text-xs",
              tab === item ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {item === "docs" ? "文档与处理状态" : DETAIL_TAB_LABELS[item]}
          </button>
        ))}
      </div>

      {tab === "docs" ? (
        <div className="mt-4 grid gap-4">
          <aside className="rounded-xl border bg-card">
            <div className="border-b p-3">
              <div className="relative">
                <Search className="text-muted-foreground absolute left-2.5 top-2.5 size-3" />
                <Input className="h-8 pl-8 text-xs" placeholder="搜索文档…" value={docQuery} onChange={(event) => setDocQuery(event.target.value)} />
              </div>
            </div>
            {!base && !error ? <p className="p-4 text-xs">加载中…</p> : null}
            {base && source === "structured" ? <p className="text-muted-foreground p-4 text-xs">此库为结构化数据源，数据表导入尚未接入。</p> : null}
            {base && source === "documents" && documents.length === 0 ? <div className="px-4 py-12 text-center"><p className="text-sm">还没有文档</p><p className="text-muted-foreground mt-2 text-xs">点击「打开文档库」，在原文档页面新建和编写文档。</p></div> : null}
            {documents.filter((doc) => doc.name.includes(docQuery.trim())).map((doc) => (
              <div key={doc.id} className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs">
                <span className="min-w-40 font-medium">{doc.name}</span>
                <span className="text-muted-foreground">写作：{!doc.publishedAt ? "草稿" : doc.hasDraft ? "有未发布修改" : "已发布"}</span>
                <span className="text-muted-foreground">知识处理：{doc.publishedAt && !capabilities.includes("rag") ? "未启用 RAG 派生" : documentProcessingLabel(doc.status)}</span>
                <a href={doc.editorUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">查看原文 <ExternalLink className="size-3" /></a>
              </div>
            ))}
          </aside>
        </div>
      ) : null}

      {tab === "recall" ? (
        <div className="mt-4 rounded-xl border bg-card p-4">
          <div className="flex gap-2">
            <Input placeholder="检索调试接入中" disabled />
            <Button size="sm" disabled title="检索调试尚未接入"><Search className="mr-1 size-3" />接入中</Button>
          </div>
          <div className="text-muted-foreground mt-3 flex flex-wrap gap-2 text-[11px]">
            {["vector", "keyword", "hybrid", "metadata"].map((mode) => (
              <span key={mode} className="rounded border px-2 py-0.5">{mode}</span>
            ))}
            <span className="rounded border px-2 py-0.5">HyDE</span>
            <span className="rounded border px-2 py-0.5">多查询</span>
            <span className="rounded border px-2 py-0.5">rerank: llm</span>
          </div>
          <p className="text-muted-foreground mt-6 text-center text-xs">
            Top-K 命中卡片、管线耗时与 rerank 前后对比将在此展示（细节交互后续调整）。
          </p>
        </div>
      ) : null}

      {tab === "graph" ? <Placeholder text="图谱画布（邻域展开 / 路径查询 / 溯源跳原文）" /> : null}
      {tab === "wiki" ? <Placeholder text="Wiki（概念树 / 概念详情 / 修订 diff）" /> : null}
      {tab === "tasks" ? <Placeholder text="本库任务（同步 / 编译 / 向量化）" action={<Button size="sm" variant="outline" asChild><Link to="/knowledge/tasks">任务中心</Link></Button>} /> : null}
    </div>
  )
}

function documentProcessingLabel(status: string) {
  return ({ draft: "未入库", published: "等待处理", processing: "处理中", indexed: "已就绪", failed: "处理失败" } as Record<string, string>)[status] ?? "状态未知"
}

function Placeholder({ text, action }: { text: string; action?: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-xl border bg-card px-6 py-16 text-center">
      <p className="text-muted-foreground text-xs">{text}</p>
      {action ? <div className="mt-4">{action}</div> : null}
      <p className="text-muted-foreground/70 mt-2 text-[11px]">页面结构已就位，数据与交互后续接入。</p>
    </div>
  )
}
