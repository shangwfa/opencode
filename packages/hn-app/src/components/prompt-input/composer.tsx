/**
 * composer（React + shadcn 版）。
 * 源：prompt-input.tsx + ChatArea composer 区域的 chat 必需面：
 * 输入框、附件、agent/model 选择（模型列表 = 已连接 provider 全量 + 各 provider 免费模型，来自 GET /provider）、
 * 上下文用量圈、发送/停止互切。
 */
import { useMemo, useRef, useState } from "react"
import { useStore } from "zustand"
import { Plus, Square, ArrowUp, ChevronDown, X, Loader2, ImageOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { usePromptAttachments } from "./attachments"
import type { PromptController } from "@/context/prompt-store"
import type { ImageAttachmentPart } from "@/context/prompt"
import { ACCEPTED_IMAGE_TYPES } from "@/constants/file-picker"
import {
  useProviderList,
  selectAvailableModels,
  type AvailableGroup,
} from "@/hooks/use-provider-list"

function ModelTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-secondary text-secondary-foreground shrink-0 rounded px-1.5 py-0.5 text-[10px]">
      {children}
    </span>
  )
}

export type ComposerSubmitInput = {
  text: string
  clear: () => void
}

const KNOWN_AGENTS = ["build", "plan", "general"] as const
const AGENT_LABELS: Record<string, string> = { build: "执行", plan: "规划", general: "通用" }

export function Composer(props: {
  sessionId?: string
  directory?: string
  working: boolean
  agent: string
  onAgentChange: (agent: string) => void
  /** 当前模型（providerID/modelID）；未选择时由页面侧自动挑可用模型 */
  model?: { providerID: string; modelID: string }
  onModelChange: (model: { providerID: string; modelID: string }) => void
  contextPercent?: number
  onAbort: () => void
  onSubmit: (input: { text: string; clear: () => void }) => void | Promise<void>
  prompt: PromptController
  t?: (key: string) => string
}) {
  const [value, setValue] = useState("")
  const [dragging, setDragging] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { providers } = useProviderList()
  // 附件（含粘贴图片）存在于 prompt store：选稳定引用（selector 返回新数组会让 zustand
  // 判定 getSnapshot 未缓存而陷入无限循环），再本地派生图片列表
  const promptParts = useStore(props.prompt.store, (s) => s.parts)
  const images = useMemo(
    () => promptParts.filter((p): p is ImageAttachmentPart => p.type === "image"),
    [promptParts],
  )

  const attachments = usePromptAttachments({
    // 编辑器节点：attachments 依赖它算光标位置，缺失会直接拒绝添加
    editor: () => editorRef.current ?? undefined,
    isDialogActive: () => false,
    setDraggingType: (type) => setDragging(type === "image"),
    focusEditor: () => editorRef.current?.focus(),
    addPart: () => false,
    prompt: props.prompt,
    sessionId: props.sessionId,
    directory: props.directory,
    t: props.t ?? ((key) => key),
  })

  const percent = Math.min(100, Math.max(0, Math.round(props.contextPercent ?? 0)))
  const modelLabel = props.model?.modelID ?? "选择模型"
  const hasAttachments = images.length > 0

  const doSubmit = async () => {
    if (props.working) {
      props.onAbort()
      return
    }
    const text = value
    if (!text.trim() && !hasAttachments) return
    await props.onSubmit({
      text,
      clear: () => {
        setValue("")
        props.prompt.reset()
        editorRef.current?.focus()
      },
    })
  }

  const modelGroups = selectAvailableModels(providers)

  return (
    <div data-slot="chat-composer" className="relative shrink-0 px-3 pt-2 pb-3 sm:px-5 sm:pb-5">
      {/* 内容渐隐，避免消息与输入框硬切 */}
      <div
        aria-hidden
        className="from-background pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b to-transparent"
      />
      <div className="mx-auto w-full max-w-3xl">
        <div
          data-slot="chat-composer-surface"
          className={cn(
            "bg-muted/30 rounded-[20px] border border-foreground/10 transition-[border-color,background-color] focus-within:border-foreground/25 focus-within:bg-card motion-reduce:transition-none",
            dragging && "border-ring ring-2 ring-ring/30",
          )}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            setDragging(false)
            const files = Array.from(e.dataTransfer?.files ?? [])
            if (files.length > 0) {
              e.preventDefault()
              void attachments.addAttachments(files)
            }
          }}
        >
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-4 pt-3">
              {images.map((image) => (
                <div
                  key={image.id}
                  className="group relative size-14 shrink-0 overflow-hidden rounded-lg border bg-muted"
                  title={`${image.filename}${image.dataUrl ? "" : "（未内联，发送时使用上传链接）"}`}
                >
                  {image.dataUrl ? (
                    <img src={image.dataUrl} alt={image.filename} className="size-full object-cover" />
                  ) : (
                    <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-0.5 text-[9px]">
                      <ImageOff className="size-3.5" />
                      <span className="px-1 text-center leading-tight">{image.mime.replace("image/", "") || "图片"}</span>
                    </div>
                  )}
                  {/* 状态角标：上传中 / 失败，都不占额外位置 */}
                  {attachments.uploading && !image.uploadError && (
                    <span className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-background/70 py-px">
                      <Loader2 className="size-2.5 animate-spin" />
                    </span>
                  )}
                  {image.uploadError && (
                    <span
                      className="absolute inset-x-0 bottom-0 bg-destructive/90 py-px text-center text-[9px] text-destructive-foreground"
                      title="上传失败，将以内联方式发送"
                    >
                      内联发送
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={`移除 ${image.filename}`}
                    className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-background/90 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                    onClick={() => attachments.removeAttachment(image.id)}
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <Textarea
            ref={editorRef}
            aria-label="消息内容"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault()
                void doSubmit()
              }
            }}
            onPaste={(e) => {
              // 粘贴图片走 attachments（dataUrl → prompt image part → 发送时转 file part）
              void attachments.handlePaste(e.nativeEvent)
            }}
            placeholder="输入消息，开始协作…"
            className="max-h-52 min-h-[60px] resize-none rounded-t-[20px] rounded-b-none border-0 bg-transparent px-4 pt-4 pb-2 text-base leading-6 shadow-none placeholder:text-muted-foreground focus-visible:ring-0 md:text-[15px] dark:bg-transparent"
          />
          <div className="flex min-w-0 items-center gap-1 px-2.5 pb-2.5">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(",")}
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                e.target.value = ""
                if (files.length > 0) void attachments.addAttachments(files)
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-9 shrink-0 rounded-full"
              aria-label="添加图片"
              title="添加图片"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="size-[18px]" />
            </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="选择 Agent"
                title={`当前模式：${props.agent || "build"}`}
                className="text-muted-foreground hover:text-foreground h-9 shrink-0 gap-1 rounded-full px-2 text-[13px] font-normal"
              >
                <span>{AGENT_LABELS[props.agent || "build"] ?? props.agent}</span>
                <ChevronDown className="size-3 opacity-50" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="chat-menu min-w-32">
              <DropdownMenuLabel>工作模式</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {KNOWN_AGENTS.map((agent) => (
                <DropdownMenuItem
                  key={agent}
                  className={cn(agent === props.agent && "chat-menu-selected")}
                  onClick={() => props.onAgentChange(agent)}
                >
                  <span>{AGENT_LABELS[agent]}</span>
                  <span className="text-muted-foreground ml-auto text-xs">{agent}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="min-w-0 flex-1" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-label="选择模型"
                title={modelLabel}
                className="text-muted-foreground hover:text-foreground h-9 min-w-0 max-w-52 gap-1 rounded-full px-2 text-[13px] font-normal"
              >
                <span className="truncate">{modelLabel}</span>
                <ChevronDown className="size-3 shrink-0 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="chat-menu max-h-80 min-w-64 overflow-y-auto">
              {!providers ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">加载中…</div>
              ) : modelGroups.length === 0 ? (
                <div className="text-muted-foreground px-2 py-3 text-xs">
                  暂无可用模型（未连接 Provider 且无免费模型）
                </div>
              ) : (
                modelGroups.flatMap((group: AvailableGroup) => {
                  const items = group.models.map((model) => {
                    const modelID = (model.id as string) ?? ""
                    const selected =
                      props.model?.providerID === group.provider.id && props.model?.modelID === modelID
                    return (
                      <DropdownMenuItem
                        key={`${group.provider.id}/${modelID}`}
                        className={cn("gap-2", selected && "chat-menu-selected")}
                        onClick={() => props.onModelChange({ providerID: group.provider.id, modelID })}
                      >
                        <span className="min-w-0 flex-1 truncate">{model.displayName || modelID}</span>
                        {model.latest && <ModelTag>最新</ModelTag>}
                        {model.free && <ModelTag>免费</ModelTag>}
                      </DropdownMenuItem>
                    )
                  })
                  return [
                    <DropdownMenuLabel key={`${group.provider.id}-label`} title={group.provider.name}>
                      {group.connected ? group.provider.id : "OpenCode 提供的免费模型"}
                      {group.connected && (
                        <span className="text-muted-foreground ml-1.5 text-[10px] font-normal">已连接</span>
                      )}
                    </DropdownMenuLabel>,
                    ...items,
                    <DropdownMenuSeparator key={`${group.provider.id}-sep`} />,
                  ]
                })
              )}
            </DropdownMenuContent>
          </DropdownMenu>

            {props.contextPercent !== undefined && <ContextUsageRing percent={percent} />}

            {props.working ? (
              <Button
                size="icon"
                variant="secondary"
                className="text-foreground ml-1 size-9 shrink-0 rounded-full"
                aria-label="停止生成"
                title="停止"
                onClick={() => props.onAbort()}
              >
                <Square className="size-3 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="ml-1 size-9 shrink-0 rounded-full shadow-none disabled:bg-foreground/10 disabled:text-muted-foreground disabled:opacity-100"
                aria-label="发送消息"
                disabled={!value.trim() && !hasAttachments}
                onClick={() => void doSubmit()}
                title="发送"
              >
                <ArrowUp className="size-[18px]" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ContextUsageRing({ percent }: { percent: number }) {
  const C = 2 * Math.PI * 11
  return (
    <div className="relative size-7 shrink-0" title={`上下文用量 ${percent}%`} aria-label={`上下文用量 ${percent}%`}>
      <svg viewBox="0 0 28 28" className="size-7 -rotate-90">
        <circle cx="14" cy="14" r="11" fill="none" strokeWidth="2.5" className="stroke-muted" />
        <circle
          cx="14"
          cy="14"
          r="11"
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className={cn("stroke-primary transition-[stroke-dasharray]", percent > 80 && "stroke-destructive")}
          strokeDasharray={`${(percent / 100) * C} ${C}`}
        />
      </svg>
      <span className="text-muted-foreground absolute inset-0 flex items-center justify-center text-[9px] font-medium">
        {percent}%
      </span>
    </div>
  )
}
