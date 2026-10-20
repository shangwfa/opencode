/**
 * 需求对话页（React 版，接通真实数据流）。
 * 数据：GET /session/{id}/message + GET /event SSE（DataProvider）
 * 发送：sendFollowupDraft → POST /session/{id}/prompt_async
 * 产物：GET /file/content（fetchArtifact 接通）
 * 停止：POST /session/{id}/abort
 */
import { useMemo, useState } from "react"
import { useNavigate, useParams, useSearchParams } from "react-router"
import { FileText, PanelRight } from "lucide-react"
import { resolveFlow, isKnownWorkflowId } from "@/features/requirement/flows"
import { createStageMachine } from "@/features/requirement/stage-machine"
import type { StageArtifact } from "@/features/requirement/flows/config"
import { StagePeekBanner, RollbackStageDialog, StageStepper } from "@/components/requirement/stage-stepper"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { SessionTimeline } from "@/components/session/session-timeline"
import { FilePreviewDialog } from "@/components/session/file-preview-dialog"
import { ImageLightbox, type ImagePreviewTarget } from "@/components/session/image-lightbox"
import { Composer } from "@/components/prompt-input/composer"
import { useToast } from "@/components/toast"
import { ServerProvider, useSDK } from "@/context/sdk"
import { DataProvider, useData } from "@/context/data"
import { LocalProvider, useLocal } from "@/context/local"
import { PromptControllerProvider, usePromptController } from "@/context/prompt-store"
import { sendFollowupDraft, abortSession } from "@/components/prompt-input/submit"
import { withDraftText } from "@/components/prompt-input/draft-text"
import { useTurnPhase } from "@/hooks/use-turn-phase"
import { tokenBreakdownFromSession } from "@/components/session/session-token-usage"
import { fileContent } from "@/lib/rest"
import { sessionSource, usingBaseServer } from "@/lib/session-source"
import { useSessionBridge } from "@/hooks/use-session-bridge"
import { pickAvailableAgent, useAvailableAgents } from "@/hooks/use-available-agents"
import { useProviderList, pickFirstModel } from "@/hooks/use-provider-list"
import { useArtifactPanelCollapsed } from "@/hooks/use-artifact-panel"

function RequirementChatInner() {
  const { dir, repo, sessionId } = useParams()
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const toast = useToast()
  const [previewHref, setPreviewHref] = useState<string | undefined>(undefined)
  const { collapsed: artifactCollapsed, toggle: toggleArtifactPanel } = useArtifactPanelCollapsed()
  const [imageTarget, setImageTarget] = useState<ImagePreviewTarget>(undefined)
  const { baseUrl: _baseUrl, directory } = useSDK()
  const data = useData()
  const local = useLocal()
  const { providers } = useProviderList()
  const prompt = usePromptController()

  const workflowId = search.get("workflow") ?? "default"
  const reqId = search.get("reqId") ?? undefined
  const flow = useMemo(
    () => resolveFlow({ workflowId: isKnownWorkflowId(workflowId) ? workflowId : "default", reqId }),
    [workflowId, reqId],
  )

  const sid = sessionId ?? ""
  const messages = data.state.message[sid] ?? []
  const parts = data.state.part
  const status = data.state.session_status[sid] ?? { type: "idle" as const }
  const working = status.type !== "idle"

  const machine = useMemo(
    () =>
      createStageMachine({
        stages: () => flow.stages,
        flow,
        // 产物同步：GET /file/content（REST）
        fetchArtifact: async (index: number): Promise<StageArtifact | undefined> => {
          const stage = flow.stages[index]
          const artifactPath = stage?.artifactPath
          if (!artifactPath?.trim()) return undefined
          const resolvedPath = reqId ? artifactPath.replaceAll("{reqId}", reqId) : artifactPath
          try {
            const res = await fileContent(resolvedPath, { directory: dir || directory || undefined })
            if (res.type !== "text" || !res.content?.trim()) return undefined
            return { stage: stage.id, path: resolvedPath, content: res.content }
          } catch {
            return undefined
          }
        },
        fetchSuggestStep: async () => null,
        onToast: toast,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flow, reqId, dir, directory],
  )

  // 首次进入加载消息
  useMemo(() => {
    if (sid) void data.loadMessages(sid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid])

  const workingIndex = machine.use((s) => s.workingIndex)
  const viewingIndex = machine.use((s) => s.viewIndex)
  const artifacts = machine.use((s) => s.artifacts)
  const skipped = machine.use((s) => s.skippedStageIds)
  const syncing = machine.use((s) => s.syncing)

  const stage = flow.stages[workingIndex]
  const artifact = artifacts.find((a) => a.stage === stage?.id)
  const confirmed = !!artifacts.find((a) => a.stage === stage?.id)?.confirmedAt
  const isPeeking = viewingIndex !== workingIndex
  const peekStage = flow.stages[viewingIndex]

  const lastAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant"),
    [messages],
  )
  const usage = tokenBreakdownFromSession(lastAssistant as never)
  const modelRef = local.model.current() ?? pickFirstModel(providers)
  const contextPercent =
    usage && modelRef
      ? (() => {
          const provider = (lastAssistant as unknown as { providerID?: string })?.providerID
          void provider
          return undefined // 百分比需模型 context 上限，由模型选择时确定；此处先展示 token 总量占比缺省
        })() ?? undefined
      : undefined

  const turnPhase = useTurnPhase({
    working,
    messages,
    parts,
  })

  const availableAgents = useAvailableAgents()
  // 阶段 agent（如 specer）由 harness 注入；本地不存在时回退 build，避免卡在“思考中”
  const agent = pickAvailableAgent(local.agent.current() ?? stage?.agent, availableAgents)
  const onModelChange = (m: { providerID: string; modelID: string }) => local.model.set(m)

  const handleSubmit = async ({ text, clear }: { text: string; clear: () => void }) => {
    if (!modelRef) {
      toast({ title: "缺少模型", description: "请先在下方选择模型" })
      return
    }
    // 无会话：先创建（对齐源「对话式创建需求」的自动建会话语义）
    let targetSid = sid
    if (!targetSid) {
      try {
        const created = await sessionSource().create({ directory: dir || directory || undefined })
        targetSid = created.id
      } catch (err) {
        toast({
          variant: "destructive",
          title: "创建会话失败",
          description: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }
    prompt.set(withDraftText(prompt.current(), text))
    try {
      await sendFollowupDraft({
        client: {
          promptAsync: (targetID, body) => sessionSource().sendMessage(targetID, body),
          command: () => {
            throw new Error("网关模式暂不支持会话命令，请直连或去掉命令前缀")
          },
        },
        data: {
          optimisticAdd: data.optimisticAdd,
          optimisticRemove: data.optimisticRemove,
          setSessionStatus: data.setSessionStatus,
        },
        draft: {
          // 必须用 targetSid：无会话时会先创建，旧 sid 为空会导致消息发不出去
          sessionID: targetSid,
          sessionDirectory: dir || directory || "",
          prompt: prompt.current(),
          context: prompt.context.items(),
          agent,
          model: modelRef,
        },
        optimisticBusy: true,
      })
      clear()
      if (targetSid !== sid) {
        const query = search.toString()
        navigate(`/requirement-chat/${repo ?? "-"}/${targetSid}${query ? `?${query}` : ""}`, { replace: true })
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: "发送失败",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      {!flow.hideStageBar && (
        <div className="flex h-14 shrink-0 items-center border-b px-4">
          <StageStepper
            ariaLabel="研发阶段"
            current={workingIndex}
            viewing={isPeeking ? viewingIndex : undefined}
            skippedIndices={new Set(
              flow.stages.map((s, i) => (skipped.includes(s.id) ? i : -1)).filter((i) => i >= 0),
            )}
            steps={flow.stages.map((s, i) => ({
              id: s.id,
              label: s.label,
              canBack: i < workingIndex,
              onBack: () => machine.jumpAdvance(i),
            }))}
          />
        </div>
      )}

      {isPeeking && peekStage && stage && (
        <StagePeekBanner
          viewLabel={peekStage.label}
          workingLabel={stage.label}
          onBackToWorking={machine.resetView}
          onRollback={() => machine.jumpAdvance(viewingIndex)}
          rollbackDisabled={viewingIndex >= workingIndex}
        />
      )}

      <FilePreviewDialog
        href={previewHref}
        directory={dir || directory || undefined}
        sessionId={sid || undefined}
        onOpenChange={(open) => {
          if (!open) setPreviewHref(undefined)
        }}
      />
      <ImageLightbox target={imageTarget} onOpenChange={(open) => !open && setImageTarget(undefined)} />

      <div className="flex min-h-0 flex-1 gap-4 p-4">
        <Card className="flex min-w-0 flex-1 flex-col gap-0 py-0">
          <CardHeader className="h-14 flex-row items-center gap-2 border-b px-5">
            {/* 右侧面板收起后，入口留在内容卡片 header 内，避免按钮游离在面板外 */}
            {artifactCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="展开阶段产物"
                title="展开阶段产物（⌘.）"
                onClick={toggleArtifactPanel}
                className="text-muted-foreground hover:text-foreground size-8 shrink-0"
              >
                <PanelRight className="size-4" />
              </Button>
            )}
            <CardTitle className="flex items-center gap-2 text-sm">
              {stage?.label ?? "会话"}
              <Badge variant="secondary" className="text-[11px] font-normal">
                {stage?.agent ?? agent}
              </Badge>
              {syncing && <Badge variant="outline">同步中…</Badge>}
              {working && <Badge variant="outline">{turnPhase.phaseLabel}</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-0 flex-1 flex-col p-0">
            <ScrollArea className="min-h-0 flex-1">
              <SessionTimeline
                messages={messages}
                parts={parts}
                working={working}
                phaseLabel={turnPhase.phaseLabel}
                onFileLink={setPreviewHref}
                onImagePreview={setImageTarget}
                className="min-h-full"
              />
            </ScrollArea>
            <Composer
              sessionId={sid || undefined}
              directory={dir || directory || undefined}
              working={working}
              agent={agent}
              onAgentChange={(a) => local.agent.set(a)}
              model={modelRef}
              onModelChange={onModelChange}
              contextPercent={contextPercent}
              onAbort={() => {
                if (usingBaseServer()) void sessionSource().abort(sid)
                else void abortSession(sid, { directory: dir || directory || undefined })
              }}
              onSubmit={handleSubmit}
              prompt={prompt}
            />
          </CardContent>
        </Card>

        {!artifactCollapsed && (
        <Card className="hidden w-[34%] shrink-0 flex-col gap-0 py-0 lg:flex">
          <CardHeader className="h-14 flex-row items-center gap-2 px-5">
            <CardTitle className="text-sm">阶段产物</CardTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label="收起阶段产物"
              title="收起阶段产物（⌘.）"
              onClick={toggleArtifactPanel}
              className="text-muted-foreground hover:text-foreground ml-auto -mr-1 size-8"
            >
              <PanelRight className="size-4" />
            </Button>
          </CardHeader>
          <CardContent className="min-h-0 flex-1 px-5 py-4">
            <ScrollArea className="h-full">
              {artifact?.content ? (
                <pre className="text-[13px] leading-relaxed whitespace-pre-wrap">{artifact.content}</pre>
              ) : (
                <div className="text-muted-foreground space-y-2 text-[13px]">
                  {stage?.artifactPath ? (
                    <>
                      <div className="flex items-center gap-1.5 text-xs">
                        <FileText className="size-3.5 shrink-0" />
                        <code className="truncate">{stage.artifactPath}</code>
                      </div>
                      <p>尚未同步内容，点击「同步产物」从沙箱读取。</p>
                    </>
                  ) : (
                    <p>当前阶段无产物。</p>
                  )}
                </div>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
        )}
      </div>

      <RollbackStageDialog
        open={false}
        stageLabel={peekStage?.label ?? ""}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </div>
  )
}

export function RequirementChatPage() {
  const { dir, sessionId } = useParams()
  const bridge = useSessionBridge(sessionId)
  return (
    <ServerProvider directory={dir}>
      <DataProvider bridge={bridge}>
        <RequirementChatInner />
      </DataProvider>
    </ServerProvider>
  )
}
