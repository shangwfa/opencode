/**
 * 项目接入会话页（React 版）。
 * 源：xybot-front-opencode-ui src/pages/project-intake/ProjectIntakeSessionPage.tsx（Solid）
 * 布局：左侧对话（复用通用 SessionTimeline + Composer，agent 锁定 intake 系列），
 *      右侧项目状态看板（ProjectIntakeStatusBoard）。
 * 与源差异（按本项目能力裁剪）：去掉 staff 头像 / 主题切换 / 需求标题 popover / 子代理导航覆写。
 */
import { useParams } from "react-router"
import { FolderInput, Loader2 } from "lucide-react"
import { ServerProvider, useSDK } from "@/context/sdk"
import { DataProvider, useData } from "@/context/data"
import { LocalProvider, useLocal } from "@/context/local"
import { PromptControllerProvider, usePromptController } from "@/context/prompt-store"
import { SessionTimeline } from "@/components/session/session-timeline"
import { Composer } from "@/components/prompt-input/composer"
import { sendFollowupDraft, abortSession } from "@/components/prompt-input/submit"
import { useTurnPhase } from "@/hooks/use-turn-phase"
import { useProviderList, pickFirstModel } from "@/hooks/use-provider-list"
import { sessionSource, usingBaseServer } from "@/lib/session-source"
import { useSessionBridge } from "@/hooks/use-session-bridge"
import { useToast } from "@/components/toast"
import { withDraftText } from "@/components/prompt-input/draft-text"
import { ProjectIntakeStatusBoard } from "./ProjectIntakeStatusBoard"
import { DEFAULT_PROJECT_INTAKE_AGENT } from "./projectIntakeAgents"

export function ProjectIntakeSessionPage() {
  const { dir, sessionId } = useParams()
  const bridge = useSessionBridge(sessionId)
  return (
    <ServerProvider directory={dir}>
      <DataProvider bridge={bridge}>
        <LocalProvider>
          <PromptControllerProvider>
            <div className="flex h-full min-h-0">
              <div className="flex min-w-0 flex-1 flex-col">
                <ProjectIntakeChatCore sessionId={sessionId} />
              </div>
              {/* 网关模式没有 intake confirm-job 概念，隐藏状态看板 */}
              {!usingBaseServer() && <ProjectIntakeStatusBoard sessionId={sessionId} directory={dir} />}
            </div>
          </PromptControllerProvider>
        </LocalProvider>
      </DataProvider>
    </ServerProvider>
  )
}

function ProjectIntakeChatCore({ sessionId }: { sessionId?: string }) {
  const { directory } = useSDK()
  const data = useData()
  const local = useLocal()
  const prompt = usePromptController()
  const toast = useToast()
  const { providers } = useProviderList()

  const sid = sessionId ?? ""
  const messages = data.state.message[sid] ?? []
  const parts = data.state.part
  const working = data.state.session_status[sid]?.type === "busy"
  const turnPhase = useTurnPhase({ messages, parts, working })

  // intake 会话固定使用 intake agent（源 matchProjectIntakeAgent 的取值）
  const agent = DEFAULT_PROJECT_INTAKE_AGENT
  const modelRef = local.model.current() ?? pickFirstModel(providers)

  const handleSubmit = async ({ text, clear }: { text: string; clear: () => void }) => {
    if (!sid) {
      toast({ title: "缺少会话", description: "请从项目接入入口创建会话后再发送" })
      return
    }
    if (!modelRef) {
      toast({ title: "缺少模型", description: "请先选择模型" })
      return
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
          sessionID: sid,
          sessionDirectory: directory || "",
          prompt: prompt.current(),
          context: prompt.context.items(),
          agent,
          model: modelRef,
        },
        optimisticBusy: true,
      })
      clear()
    } catch (err) {
      toast({
        variant: "destructive",
        title: "发送失败",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header 与右侧看板 h-14 + border-b 对齐，横线跨列连成一条 */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium">项目录入会话</span>
          {directory && (
            <span className="text-muted-foreground truncate text-xs">{directory}</span>
          )}
        </div>
        <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
          {working ? (
            <>
              <Loader2 className="size-3 animate-spin" />
              {turnPhase.phaseLabel}
            </>
          ) : (
            <span className="rounded bg-muted/60 px-1.5 py-0.5 text-[10px]">{agent}</span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {messages.length === 0 ? (
          <IntakeEmptyState />
        ) : (
          <SessionTimeline
            messages={messages}
            parts={parts}
            working={working}
            phaseLabel={turnPhase.phaseLabel}
          />
        )}
      </div>
        <Composer
          sessionId={sid || undefined}
          directory={directory || undefined}
          working={working}
          agent={agent}
          onAgentChange={() => undefined}
          model={modelRef}
          onModelChange={(m) => local.model.set(m)}
          onAbort={() => {
            if (usingBaseServer()) void sessionSource().abort(sid)
            else void abortSession(sid, { directory: directory || undefined })
          }}
          onSubmit={handleSubmit}
          prompt={prompt}
        />
    </div>
  )
}

/** 会话无消息时的引导（对齐源项目 intake 会话首屏语义） */
function IntakeEmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-lg">
        <FolderInput className="size-5" />
      </div>
      <div className="space-y-1.5">
        <p className="text-[15px] font-medium">录入项目需求</p>
        <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
          描述要接入的代码仓库、业务应用与需求范围；解析完成后确认清单，即可批量创建子 session。
        </p>
      </div>
    </div>
  )
}