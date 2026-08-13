"use client";

import { BuiltinActionType, type ActionEvent, Renderer } from "@openuidev/react-lang";
import {
  aggregateStats,
  type ChatMessage,
  type Phase,
  normalizeOpenUiCode,
  type TraceItem,
} from "@/lib/opencode-adapter";
import { shadcnChatLibrary } from "@/lib/shadcn-genui";
import { ChevronRight, CircleAlert, Clock3 } from "lucide-react";
import { useCallback, useState } from "react";

function ThinkingBlock({ reasoning, traces, isStreaming }: { reasoning: string; traces: TraceItem[]; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveExpanded = isStreaming ? true : expanded;
  const items = traces.filter((item) => item.kind !== "stats");
  const stats = aggregateStats(traces);
  const hasStats = stats.steps > 0;
  const hasContent = Boolean(reasoning.trim()) || items.length > 0 || hasStats || isStreaming;
  if (!hasContent) return null;
  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={effectiveExpanded}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        <ChevronRight className={`size-4 transition-transform ${effectiveExpanded ? "rotate-90" : ""}`} />
        <span className="font-medium text-foreground">{isStreaming ? "正在思考" : "已深度思考"}</span>
        <Clock3 className="ml-auto size-4 opacity-60" />
      </button>
      {effectiveExpanded && (
        <div className="border-t border-border px-4 py-4 text-sm leading-6 text-muted-foreground">
          {reasoning.trim() && (
            <div className="border-l-2 border-border pl-3 whitespace-pre-wrap">{reasoning.trim()}</div>
          )}
          {items.length > 0 && (
            <div className={`grid gap-2 ${reasoning.trim() ? "mt-4" : ""}`}>
              {items.map((item) => (
                <TraceRow key={item.id} item={item} />
              ))}
            </div>
          )}
          {hasStats && (
            <div className="mt-3 text-xs text-muted-foreground/80">
              {`输入 ${stats.tokens.input.toLocaleString()} · 输出 ${stats.tokens.output.toLocaleString()} · 推理 ${stats.tokens.reasoning.toLocaleString()} · 缓存读取 ${stats.tokens.cacheRead.toLocaleString()} · ${stats.steps} 个步骤`}
            </div>
          )}
          {isStreaming && !reasoning.trim() && items.length === 0 && !hasStats && (
            <div className="text-muted-foreground">正在等待 OpenCode 返回执行进度…</div>
          )}
        </div>
      )}
    </div>
  );
}

function TraceRow({ item }: { item: TraceItem }) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(item.input || item.output || item.error);
  const status = item.status === "completed" ? "完成" : item.status === "error" ? "失败" : item.status === "running" ? "执行中" : item.status === "pending" ? "准备中" : "";
  const dotClass = item.status === "error" ? "bg-destructive" : item.status === "completed" ? "bg-green-600" : "bg-muted-foreground";
  return (
    <div className="overflow-hidden rounded-lg bg-background/70">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((value) => !value)}
        aria-expanded={hasDetails ? open : undefined}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted-foreground ${hasDetails ? "hover:bg-muted/60" : ""}`}
      >
        <span className={`size-1.5 rounded-full ${dotClass}`} />
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {status && <span className="text-xs">{status}</span>}
        {hasDetails && <ChevronRight className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} />}
      </button>
      {open && (
        <div className="max-h-72 overflow-auto px-4 pb-3 pl-8 text-xs text-muted-foreground">
          {item.input && <TraceDetail label="输入" value={JSON.stringify(item.input, null, 2)} />}
          {item.output && <TraceDetail label="结果" value={item.output} />}
          {item.error && <TraceDetail label="错误" value={item.error} />}
        </div>
      )}
    </div>
  );
}

function TraceDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-2">
      <div className="mb-1 text-muted-foreground/80">{label}</div>
      <pre className="whitespace-pre-wrap break-words font-mono leading-5">{value}</pre>
    </div>
  );
}

export function ShadcnAssistantMessage({
  message,
  phase,
  onFollowUp,
}: {
  message: ChatMessage;
  phase: Phase;
  onFollowUp: (text: string) => void;
}) {
  const isGenerating = message.status === "generating";
  const isRecovering = message.recovering ?? false;
  const isThinking = (isGenerating && phase === "thinking") || isRecovering;
  const isRendering = isGenerating && phase === "rendering";
  const isStreaming = isRendering || isRecovering;

  const reasoning = message.reasoning ?? "";
  const traces = message.traces ?? [];
  const code = message.code ? normalizeOpenUiCode(message.code) : "";

  const handleAction = useCallback((event: ActionEvent) => {
    if (event.type === BuiltinActionType.OpenUrl) {
      const url = event.params?.url;
      if (typeof url === "string") window.open(url, "_blank");
      return;
    }
    if (event.type !== BuiltinActionType.ContinueConversation) return;
    onFollowUp(event.humanFriendlyMessage ?? "");
  }, [onFollowUp]);

  return (
    <>
      <ThinkingBlock reasoning={reasoning} traces={traces} isStreaming={isThinking} />
      {code ? (
        <Renderer response={code} library={shadcnChatLibrary} isStreaming={isStreaming} onAction={handleAction} />
      ) : message.error && !isGenerating && !isRecovering && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4" />
          <span>{message.error}</span>
        </div>
      )}
    </>
  );
}
