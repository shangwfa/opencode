import { useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import { ChevronDown, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SessionDrafts } from "./session-drafts"
import { InstructionDrafts } from "./instruction-drafts"

/**
 * 统一「沉淀应用」入口。
 * 本轮任务结束后才由外层渲染；默认只有一条紧凑引导条，点击展开后再选择沉淀方式：
 * 固定流程为主（推荐，运行不调用模型），旧版业务步骤为次级选项。避免在探索阶段就把两张展开卡铺满对话流。
 * 带 ?draft= 深链（如旧应用升级候选）时直接展开固定流程，保留原有入口。
 *
 * 固定流程面板始终挂载（收起时仅视觉隐藏）：它会轮询沙箱里的应用请求标记并自动导入草稿，
 * 一旦卸载就不再导入，用户会误以为「AI 说沉淀了但没沉淀」。
 */
export function AppDistill({ sessionId, onOpenFile }: { sessionId: string; onOpenFile?: (path: string) => void }) {
  const [search] = useSearchParams()
  const [open, setOpen] = useState(() => !!search.get("draft"))
  const [mode, setMode] = useState<"fixed" | "legacy">("fixed")
  const [draftCount, setDraftCount] = useState(0)
  // 只自动展开一次，之后尊重用户手动收起。
  const autoOpened = useRef(false)
  useEffect(() => {
    if (autoOpened.current || draftCount === 0) return
    autoOpened.current = true
    setOpen(true)
  }, [draftCount])
  return (
    <section aria-label="沉淀应用" className="mx-auto my-4 w-full max-w-3xl">
      <div className={cn("rounded-xl border bg-card shadow-xs transition-colors", open ? "p-4" : "flex flex-wrap items-center justify-between gap-3 px-4 py-3")}>
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="size-4 shrink-0 text-indigo-500" />
          <p className="truncate text-sm">
            {draftCount > 0 ? `已生成 ${draftCount} 个应用草稿，测试通过后可创建应用。` : "本轮任务已完成，可沉淀为可重复运行的自动化应用。"}
          </p>
        </div>
        <Button size="sm" variant={open ? "ghost" : "outline"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : draftCount > 0 ? "查看草稿" : "沉淀应用"}
          <ChevronDown className={cn("ms-1.5 size-4 transition-transform", open && "rotate-180")} />
        </Button>
        {open && (
          <div className="mt-3 flex w-full gap-1 border-t pt-3 text-xs" role="tablist" aria-label="沉淀方式">
            <button type="button" role="tab" aria-selected={mode === "fixed"} className={cn("rounded-md px-2.5 py-1", mode === "fixed" ? "bg-indigo-50 font-medium text-indigo-700" : "text-muted-foreground")} onClick={() => setMode("fixed")}>固定流程 · 推荐</button>
            <button type="button" role="tab" aria-selected={mode === "legacy"} className={cn("rounded-md px-2.5 py-1", mode === "legacy" ? "bg-amber-50 font-medium text-amber-800" : "text-muted-foreground")} onClick={() => setMode("legacy")}>旧版业务步骤</button>
          </div>
        )}
      </div>
      {/* 固定流程面板常驻，仅视觉隐藏；否则收起状态下不再自动导入草稿。 */}
      <div className={cn(!open && "hidden")}>
        <SessionDrafts key={sessionId} sessionId={sessionId} onDrafts={(count) => setDraftCount(count)} />
      </div>
      {open && mode === "legacy" && (
        <InstructionDrafts key={`instructions-${sessionId}`} sessionId={sessionId} onOpenFile={onOpenFile} />
      )}
      {open && mode === "legacy" && <p className="mx-auto mt-1 max-w-3xl px-1 text-[11px] leading-5 text-muted-foreground">旧版每次运行仍逐步调用 AI，速度取决于模型；新应用建议优先用固定流程。</p>}
    </section>
  )
}
