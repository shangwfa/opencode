import { useEffect, useState } from "react"
import { Link } from "react-router"
import { ArrowRight, BookOpen, FileText, Layers, Plus, RefreshCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { hnApi } from "@/lib/base-api"

/** 总览：只展示已接通的数据；未接入的模块不占位。 */
type Overview = {
  baseCount: number
  documentCount: number
  publishedCount: number
  pendingCount: number
  failedCount: number
  recent: Array<{ baseId: string; baseName: string; id: string; name: string; status: string; publishedAt: string | null; updatedAt: string }>
}

export function KnowledgeOverviewPage() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true
    hnApi
      .knowledgeOverview()
      .then((result) => {
        if (active) setData(result.overview)
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "加载失败")
      })
    return () => {
      active = false
    }
  }, [])

  const stats = [
    { label: "知识库", value: data?.baseCount, icon: BookOpen },
    { label: "文档", value: data?.documentCount, icon: FileText },
    { label: "已发布", value: data?.publishedCount, icon: Layers },
    { label: "处理中", value: data?.pendingCount, icon: RefreshCw },
    { label: "处理失败", value: data?.failedCount, icon: TriangleAlert },
  ]

  return (
    <div className="mx-auto max-w-6xl px-8 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-semibold">知识</h1>
          <p className="text-muted-foreground mt-1 text-xs">文档库与结构化数据源；RAG / GraphRAG / LLM-Wiki 按库启用。</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" asChild><Link to="/knowledge/bases">全部知识库</Link></Button>
          <Button size="sm" asChild><Link to="/knowledge/bases"><Plus className="mr-1 size-3" />新建知识库</Link></Button>
        </div>
      </div>

      {error ? <p role="alert" className="text-destructive mt-4 text-xs">{error}</p> : null}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((item) => (
          <div key={item.label} className="rounded-xl border bg-card px-3 py-3">
            <p className="text-muted-foreground flex items-center gap-1 text-[11px]"><item.icon className="size-3" />{item.label}</p>
            <p className="mt-1 text-lg font-semibold">{item.value ?? "—"}</p>
          </div>
        ))}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3"><h2 className="text-[13px] font-medium">最近文档</h2></div>
          {!data ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">加载中…</p>
          ) : data.recent.length === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">还没有文档。创建知识库后在文档库中编写并发布。</p>
          ) : (
            <ul className="divide-y">
              {data.recent.map((doc) => (
                <li key={`${doc.baseId}:${doc.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{doc.name}</span>
                    <span className="text-muted-foreground ml-2">{doc.baseName}</span>
                  </span>
                  <span className="text-muted-foreground shrink-0">{doc.publishedAt ? "已发布" : "草稿"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-xl border bg-card">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-[13px] font-medium">需要关注</h2>
            <Button size="sm" variant="ghost" asChild><Link to="/knowledge/tasks">任务中心<ArrowRight className="ml-1 size-3" /></Link></Button>
          </div>
          {!data ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">加载中…</p>
          ) : data.pendingCount + data.failedCount === 0 ? (
            <p className="text-muted-foreground px-4 py-8 text-center text-xs">没有处理中或失败的知识。</p>
          ) : (
            <ul className="divide-y">
              {data.failedCount ? <li className="text-destructive px-4 py-2.5 text-xs">{data.failedCount} 篇文档知识处理失败</li> : null}
              {data.pendingCount ? <li className="px-4 py-2.5 text-xs">{data.pendingCount} 篇文档正在处理</li> : null}
            </ul>
          )}
        </section>
      </div>

      <section className="mt-5 rounded-xl border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-[13px] font-medium">我的知识库</h2>
          <Button size="sm" variant="ghost" asChild><Link to="/knowledge/bases">查看全部<ArrowRight className="ml-1 size-3" /></Link></Button>
        </div>
        {!data ? (
          <p className="text-muted-foreground px-4 py-8 text-center text-xs">加载中…</p>
        ) : data.baseCount === 0 ? (
          <p className="text-muted-foreground px-4 py-8 text-center text-xs">暂无知识库。<Link className="text-primary underline-offset-2 hover:underline" to="/knowledge/bases">创建第一个知识库</Link></p>
        ) : (
          <p className="text-muted-foreground px-4 py-8 text-center text-xs">共 {data.baseCount} 个知识库、{data.documentCount} 篇文档。<Link className="text-primary underline-offset-2 hover:underline" to="/knowledge/bases">查看全部</Link></p>
        )}
      </section>
    </div>
  )
}
