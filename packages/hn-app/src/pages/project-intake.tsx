/**
 * 项目接入入口页（React 版，替代原骨架页）。
 *
 * 流程（对齐源 requirements → createProjectIntake → ProjectIntakeSessionPage）：
 * 1. 填写接入信息（工作目录 / 需求标题）→ POST harness `/opencode/project-intake` 创建 master session
 * 2. 成功即跳转到 `/project-intake/:dir/:sessionId`，右侧状态看板自动轮询创建进度
 *
 * 数据源说明：harness 由 `window.YD.BOSS_API_URL` 指向（`…/boss/api/v3/harness`）。
 * 本地未配置/不可达时，这里会给出明确原因并允许直接创建空会话进行对话（看板显示错误态）。
 */
import { useState } from "react"
import { useNavigate } from "react-router"
import { FolderInput, Loader2, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { useToast } from "@/components/toast"
import { sessionCreate } from "@/lib/rest"
import { hnApi } from "@/lib/base-api"
import { usingBaseServer } from "@/lib/session-source"
import { createProjectIntake, type CreateProjectIntakeBody } from "@/api/project-intake/createIntake"
import { requirementApiBase } from "@/api/requirement/client"

export function ProjectIntakePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [directory, setDirectory] = useState("")
  const [title, setTitle] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const harnessReady = !!requirementApiBase
  const gatewayReady = usingBaseServer()

  const start = async () => {
    const dir = directory.trim() || "/workspace"
    setBusy(true)
    setError("")
    try {
      let sid: string
      if (gatewayReady) {
        // 网关模式：需求 + 会话都落在 hn-base-server（带归属与权限）
        const requirement = await hnApi.createRequirement({
          title: title.trim() || "项目接入",
        })
        const created = await hnApi.createSession({
          requirementId: requirement.id,
          title: "项目接入对话",
          directory: dir,
        })
        sid = created.session.id
      } else if (harnessReady) {
        // 源 body 不含 directory：目录由后续 master session 的工作区决定，
        // 这里仅透传标题与来源标记（保持与源请求体一致）
        const body: CreateProjectIntakeBody = {
          ...(title.trim() ? { title: title.trim() } : {}),
          source: "hn-app",
        }
        const created = await createProjectIntake(body)
        sid = created.masterSessionId
      } else {
        // 都没有：退化为普通会话（看板会显示未配置提示）
        const created = (await sessionCreate({ directory: dir })) as { id: string }
        sid = created.id
        toast({
          title: "未配置接入服务",
          description: "已创建普通会话（window.YD.BOSS_API_URL 未配置，项目创建进度不可用）",
        })
      }
      navigate(`/project-intake/${encodeURIComponent(dir)}/${encodeURIComponent(sid)}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      toast({ variant: "destructive", title: "创建失败", description: message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <header className="mb-6">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight">项目接入</h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            录入项目需求，确认后自动创建子 session 并建立仓库 ↔ 应用映射
          </p>
        </header>

        <Card className="gap-0 py-0">
          <div className="space-y-4 p-5">
            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium">工作目录</span>
              <input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
                placeholder="/workspace"
                className="border-input focus-visible:border-foreground/25 focus-visible:ring-ring/20 h-9 w-full rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:ring-2"
              />
              <span className="text-muted-foreground text-xs">沙箱内的工作区路径，默认为 /workspace</span>
            </label>

            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium">需求标题（可选）</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：接入订单中心需求"
                className="border-input focus-visible:border-foreground/25 focus-visible:ring-ring/20 h-9 w-full rounded-lg border bg-transparent px-3 text-sm outline-none focus-visible:ring-2"
              />
            </label>

            {!gatewayReady && !harnessReady && (
              <div className="bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span>
                  未配置接入服务（<code>window.YD.BOSS_API_URL</code>），无法创建确认任务；仍可创建普通会话进行对话。
                </span>
              </div>
            )}

            {error && (
              <div className="bg-destructive/10 text-destructive rounded-lg px-3 py-2 text-xs break-all">{error}</div>
            )}

            <div className="flex items-center gap-3">
              <Button onClick={() => void start()} disabled={busy} className="gap-2">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderInput className="size-4" />}
                {busy ? "创建中…" : "开始接入"}
              </Button>
              <span className="text-muted-foreground text-xs">创建后进入对话，右侧展示子任务创建进度</span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}