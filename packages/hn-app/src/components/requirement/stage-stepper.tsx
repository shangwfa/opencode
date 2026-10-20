import type { JSX } from "react"
import { CheckIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export type StageStepState = "done" | "current" | "upcoming" | "viewing" | "skipped"

/** 纯函数自源 StageStepper.tsx 原样移植 */
export function stageStepState(
  index: number,
  current: number,
  viewing?: number,
  isSkipped?: boolean,
): StageStepState {
  if (isSkipped) return "skipped"
  if (viewing !== undefined && index === viewing && index !== current) return "viewing"
  if (index < current) return "done"
  if (index === current) return "current"
  return "upcoming"
}

function stageStepLine(done: boolean, _skipped?: boolean) {
  return done ? "bg-foreground/70" : "bg-border"
}

function stageStepLabelClass(state: StageStepState) {
  if (state === "skipped") return "text-muted-foreground/50"
  if (state === "upcoming") return "text-muted-foreground/70"
  return "text-foreground"
}

export function StageStepCircle(props: {
  index: number
  state: StageStepState
  compact?: boolean
  children?: JSX.Element
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full font-medium tabular-nums transition-colors duration-300",
        !props.compact && "size-[18px] shrink-0 text-[10px]",
        props.compact && "size-4 shrink-0 text-[10px]",
        (props.state === "done" || props.state === "current") && "bg-foreground text-background",
        props.state === "viewing" && "bg-card text-foreground ring-1 ring-border",
        props.state === "skipped" && "bg-card text-muted-foreground/50 ring-1 ring-border",
        props.state === "upcoming" && "bg-card text-muted-foreground/70 ring-1 ring-border",
      )}
    >
      {props.children ?? (props.state === "done" ? <CheckIcon className="size-2.5" /> : props.index + 1)}
    </div>
  )
}

export function StageStepper(props: {
  steps: { id?: string; label: string; canBack?: boolean; onBack?: () => void }[]
  current: number
  viewing?: number
  skippedIndices?: Set<number>
  ariaLabel: string
  compact?: boolean
  node?: (index: number, state: StageStepState) => JSX.Element
}) {
  const last = Math.max(props.steps.length - 1, 0)
  const scrollable = props.steps.length > 4

  return (
    <div
      data-component="stage-stepper"
      className={cn("mx-auto w-full", scrollable && "overflow-x-auto", !props.compact && "max-w-4xl")}
      role="list"
      aria-label={props.ariaLabel}
    >
      <div className={cn("flex items-center", scrollable ? "min-w-max px-1" : "w-full")}>
        {props.steps.map((step, index) => {
          const isSkipped = props.skippedIndices?.has(index) ?? false
          const state = stageStepState(index, props.current, props.viewing, isSkipped)
          const leftDone = index > 0 && index <= props.current && !isSkipped
          const rightDone = index < props.current && !isSkipped
          return (
            <div key={step.id ?? index} className={cn("flex items-center", scrollable ? "shrink-0" : "min-w-0 flex-1")}>
              <div
                aria-hidden
                className={cn(
                  "h-px flex-1 rounded-full transition-colors duration-300",
                  index === 0 && "invisible",
                  !props.compact ? "min-w-3" : "min-w-1.5",
                  index > 0 && stageStepLine(leftDone),
                )}
              />
              {step.canBack ? (
                <button
                  type="button"
                  className={cn(
                    "flex shrink-0 cursor-pointer items-center rounded-md border-0 bg-transparent transition-colors hover:bg-accent",
                    !props.compact ? "gap-1.5 px-2 py-0.5" : "gap-1 px-1.5 py-0",
                  )}
                  aria-current={state === "current" ? "step" : undefined}
                  onClick={() => step.onBack?.()}
                >
                  {props.node?.(index, state) ?? (
                    <StageStepCircle index={index} state={state} compact={props.compact} />
                  )}
                  <span
                    className={cn(
                      "whitespace-nowrap font-medium transition-colors duration-300",
                      !props.compact ? "text-xs" : "text-[11px]",
                      stageStepLabelClass(state),
                    )}
                  >
                    {step.label}
                  </span>
                </button>
              ) : (
                <div
                  className={cn("flex shrink-0 items-center px-2", !props.compact ? "gap-1.5" : "gap-1")}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  {props.node?.(index, state) ?? (
                    <StageStepCircle index={index} state={state} compact={props.compact} />
                  )}
                  <span
                    className={cn(
                      "whitespace-nowrap font-medium transition-colors duration-300",
                      !props.compact ? "text-xs" : "text-[11px]",
                      stageStepLabelClass(state),
                    )}
                  >
                    {step.label}
                  </span>
                </div>
              )}
              <div
                aria-hidden
                className={cn(
                  "h-px flex-1 rounded-full transition-colors duration-300",
                  index === last && "invisible",
                  !props.compact ? "min-w-3" : "min-w-1.5",
                  index < last && stageStepLine(rightDone),
                )}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function StagePeekBanner(props: {
  viewLabel: string
  workingLabel: string
  onBackToWorking: () => void
  onRollback: () => void
  rollbackDisabled?: boolean
}) {
  return (
    <div className="bg-muted/60 flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          查看「<span className="text-foreground">{props.viewLabel}</span>」
        </span>
        <span className="opacity-60">·</span>
        <span className="truncate">
          当前工作：<span className="text-foreground">{props.workingLabel}</span>
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          className="text-primary px-1.5 py-0.5 text-xs font-medium hover:underline disabled:text-muted-foreground/60 disabled:no-underline disabled:cursor-not-allowed"
          disabled={props.rollbackDisabled}
          onClick={props.onRollback}
        >
          回退到「{props.viewLabel}」编辑
        </button>
        <Button variant="secondary" size="sm" onClick={props.onBackToWorking}>
          回到当前阶段
        </Button>
      </div>
    </div>
  )
}

export function RollbackStageDialog(props: {
  stageLabel: string
  open: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={props.open} onOpenChange={(v) => !v && props.onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>回退到「{props.stageLabel}」编辑</DialogTitle>
          <DialogDescription className="text-left">
            回退后，当前及后续阶段的产物可能需要重新生成或再次确认。已确认的后续阶段进度将被清除，对话记录不受影响。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onCancel}>
            取消
          </Button>
          <Button onClick={props.onConfirm}>确认回退</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
