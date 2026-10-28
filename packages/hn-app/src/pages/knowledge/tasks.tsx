import { RefreshCw, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"

const TYPES = ["doc-platform-sync", "yydoc-sync", "wiki-compile", "graph-ingest", "vectorize"] as const

/** 任务中心：同步/编译/向量化任务。数据接线后续补。 */
export function KnowledgeTasksPage() {
  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[15px] font-semibold">任务中心</h1>
          <p className="text-muted-foreground mt-1 text-xs">同步、编译、图谱摄取与向量化任务；失败可重试。</p>
        </div>
        <Button size="sm" variant="outline"><RefreshCw className="mr-1 size-3" />刷新</Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-[11px]">
        <span className="rounded border px-2 py-0.5">全部类型</span>
        {TYPES.map((type) => <span key={type} className="text-muted-foreground rounded border px-2 py-0.5">{type}</span>)}
      </div>

      <div className="mt-4 rounded-xl border bg-card">
        <div className="flex items-center gap-2 px-6 py-14 text-center">
          <TriangleAlert className="text-muted-foreground size-4" />
          <p className="text-muted-foreground text-xs">暂无任务记录。发布文档、启用 GraphRAG/Wiki 或上传文档后，任务将在这里显示进度与失败明细。</p>
        </div>
      </div>
    </div>
  )
}
