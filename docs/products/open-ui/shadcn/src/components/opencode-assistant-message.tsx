"use client";

import { type AssistantMessage } from "@openuidev/react-headless";
import { Renderer } from "@openuidev/react-lang";
import { normalizeOpenUiCode, parseThinking, RENDER_BOUNDARY, SESSION_PENDING_MARKER, TRAILING_TRACE_BOUNDARY, type TraceItem } from "@/lib/opencode-adapter";
import { shadcnChatLibrary } from "@/lib/shadcn-genui";
import { ChevronRight, CircleAlert, Clock3 } from "lucide-react";
import { useState } from "react";

function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveExpanded = isStreaming ? true : expanded;
  const thinking = parseThinking(content);
  if (!content?.trim()) return null;
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
          {thinking.reasoning && (
            <div className="border-l-2 border-border pl-3 whitespace-pre-wrap">{thinking.reasoning}</div>
          )}
          {thinking.items.some((item) => item.kind !== "stats") && (
            <div className={`grid gap-2 ${thinking.reasoning ? "mt-4" : ""}`}>
              {thinking.items.filter((item) => item.kind !== "stats").map((item) => (
                <TraceRow key={item.id} item={item} />
              ))}
            </div>
          )}
          {thinking.items.some((item) => item.kind === "stats") && (
            <div className="mt-3 text-xs text-muted-foreground/80">
              {thinking.items.filter((item) => item.kind === "stats").map((item) => `${item.title}${item.output ? ` · ${item.output}` : ""}`).join(" · ")}
            </div>
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

export function ShadcnAssistantMessage({ message, isStreaming }: { message: AssistantMessage; isStreaming: boolean }) {
  const isRecovering = (message.content ?? "").includes(SESSION_PENDING_MARKER);
  const content = (message.content ?? "").replace(SESSION_PENDING_MARKER, "");
  const boundaryIndex = content.indexOf(RENDER_BOUNDARY);
  const trailingTraceIndex = content.indexOf(TRAILING_TRACE_BOUNDARY);
  const lineStartMatch = /(^|\n)root\s*=/.exec(content);
  let rootIndex = boundaryIndex >= 0
    ? boundaryIndex + RENDER_BOUNDARY.length
    : lineStartMatch ? lineStartMatch.index + lineStartMatch[1].length : -1;
  if (rootIndex === -1 && !isStreaming) {
    const looseMatches = [...content.matchAll(/root\s*=\s*Card\s*\(/g)];
    if (looseMatches.length > 0) rootIndex = looseMatches[looseMatches.length - 1]!.index!;
  }
  const leadingThinking = rootIndex === -1 ? content : content.slice(0, boundaryIndex >= 0 ? boundaryIndex : rootIndex).trim();
  const trailingThinking = trailingTraceIndex >= 0
    ? content.slice(trailingTraceIndex + TRAILING_TRACE_BOUNDARY.length).trim()
    : "";
  const thinking = [leadingThinking, trailingThinking].filter(Boolean).join("\n\n");
  const parsedThinking = parseThinking(thinking);
  const isPending = parsedThinking.items.some((item) => item.status === "pending" || item.status === "running");
  const code = rootIndex >= 0
    ? normalizeOpenUiCode(content.slice(rootIndex, trailingTraceIndex >= 0 ? trailingTraceIndex : undefined))
    : "";
  return (
    <>
      <ThinkingBlock content={thinking} isStreaming={isStreaming || isPending || isRecovering} />
      {code && !isStreaming && !isRecovering ? (
        <Renderer response={code} library={shadcnChatLibrary} isStreaming={false} />
      ) : !isStreaming && !isPending && !isRecovering && (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4" />
          <span>模型响应没有生成有效的 OpenUI 界面。请重新发送，或在原需求后补充“请只输出 openui-lang”。</span>
        </div>
      )}
    </>
  );
}
