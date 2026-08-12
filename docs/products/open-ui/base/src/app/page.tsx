"use client";
import "@openuidev/react-ui/components.css";
import "@openuidev/react-ui/styles/index.css";

import { AgentInterface, MarkDownRenderer } from "@openuidev/react-ui";
import { type AssistantMessage } from "@openuidev/react-headless";
import { Renderer } from "@openuidev/react-lang";
import { openuiLibrary, openuiPromptOptions } from "@openuidev/react-ui/genui-lib";
import { generateSystemPrompt } from "@openuidev/lang-core";
import remarkGfm from "remark-gfm";
import librarySpec from "@/generated/spec.json";
import { createOpenCodeAdapter, normalizeOpenUiCode, parseThinking, RENDER_BOUNDARY, TRAILING_TRACE_BOUNDARY, type TraceItem } from "@/lib/opencode-adapter";
import { useState } from "react";

let systemPrompt: string;
try {
  systemPrompt = [
    "# OpenUI response instructions",
    "",
    "You are the dedicated openui agent. You may use the same tools and permission policy as the build agent to research or modify projects.",
    "Tool calls and intermediate reasoning are not part of the final answer format.",
    "After completing any required work, translate the result into openui-lang. The final user-visible answer must start with `root =`.",
    "If work created files or ran commands, represent the outcome using OpenUI Cards, Steps, CodeBlock, or other components instead of prose.",
    "The final user-visible answer must contain only openui-lang statements. Never include markdown, project paths, shell commands, build logs, status reports, or prose summaries in the final answer.",
    "Follow component signatures exactly. Stack's second argument is direction (`row` or `column`), not gap. For a vertical stack with gap `m`, write `Stack(children, \"column\", \"m\")`.",
    "",
    generateSystemPrompt({ library: librarySpec as any, promptOptions: openuiPromptOptions }),
  ].join("\n");
} catch { systemPrompt = "Respond with: root = Stack([TextContent(\"hello\")])"; }

const openuiLibraryWithGfm = {
  ...openuiLibrary,
  components: {
    ...openuiLibrary.components,
    MarkDownRenderer: {
      ...openuiLibrary.components.MarkDownRenderer,
      component: (props: { props: { textMarkdown: string; variant?: "clear" | "card" | "sunk" } }) => (
        <MarkDownRenderer
          textMarkdown={props.props.textMarkdown}
          variant={props.props.variant}
          options={{ remarkPlugins: [remarkGfm] }}
        />
      ),
    },
  },
};

function ThinkingBlock({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveExpanded = isStreaming ? true : expanded;
  const thinking = parseThinking(content);
  if (!content?.trim()) return null;
  return (
    <div
      style={{
        marginBottom: 12,
        border: "1px solid #e6e8eb",
        borderRadius: 12,
        overflow: "hidden",
        background: "#fbfbfc",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={effectiveExpanded}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "10px 14px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: 14,
          color: "#343a40",
          fontFamily: "inherit",
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          style={{ flexShrink: 0, transform: effectiveExpanded ? "rotate(90deg)" : "none", transition: "transform 0.2s" }}
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span style={{ fontWeight: 600 }}>{isStreaming ? "正在思考" : "已深度思考"}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{ flexShrink: 0, opacity: 0.6 }}
        >
          <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20" />
          <path d="M12 6v6l4 2" />
        </svg>
      </button>
      {effectiveExpanded && (
        <div
          style={{
            padding: "14px 16px 16px",
            borderTop: "1px solid #e5e7eb",
            color: "#60646c",
            fontSize: 14,
            lineHeight: 1.65,
          }}
        >
          {thinking.reasoning && (
            <div style={{ paddingLeft: 12, borderLeft: "2px solid #d7dade" }}>
              <MarkDownRenderer textMarkdown={thinking.reasoning} />
            </div>
          )}
          {thinking.items.some((item) => item.kind !== "stats") && (
            <div style={{ display: "grid", gap: 6, marginTop: thinking.reasoning ? 14 : 0 }}>
              {thinking.items.filter((item) => item.kind !== "stats").map((item) => (
                <TraceRow key={item.id} item={item} />
              ))}
            </div>
          )}
          {thinking.items.some((item) => item.kind === "stats") && (
            <div style={{ marginTop: 12, color: "#9a9fa7", fontSize: 12 }}>
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
  return (
    <div style={{ borderRadius: 8, background: "#f3f4f5", overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => hasDetails && setOpen((value) => !value)}
        aria-expanded={hasDetails ? open : undefined}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "8px 10px",
          border: 0,
          background: "transparent",
          color: "#555b63",
          cursor: hasDetails ? "pointer" : "default",
          textAlign: "left",
          font: "inherit",
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: 999, background: item.status === "error" ? "#d65c5c" : item.status === "completed" ? "#52a36b" : "#9aa0a8", flexShrink: 0 }} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{item.title}</span>
        {status && <span style={{ color: "#92979f", fontSize: 12 }}>{status}</span>}
        {hasDetails && <span style={{ color: "#a2a6ad", transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>›</span>}
      </button>
      {open && (
        <div style={{ padding: "2px 12px 12px 26px", color: "#727780", fontSize: 12, overflow: "auto", maxHeight: 280 }}>
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
    <div style={{ marginTop: 8 }}>
      <div style={{ marginBottom: 4, color: "#999ea6" }}>{label}</div>
      <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", font: "12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace" }}>{value}</pre>
    </div>
  );
}

const CustomAssistantMessage = ({ message, isStreaming }: { message: AssistantMessage; isStreaming: boolean }) => {
  const content = message.content ?? "";
  const boundaryIndex = content.indexOf(RENDER_BOUNDARY);
  const trailingTraceIndex = content.indexOf(TRAILING_TRACE_BOUNDARY);
  const lineStartMatch = /(^|\n)root\s*=/.exec(content);
  let rootIndex = boundaryIndex >= 0
    ? boundaryIndex + RENDER_BOUNDARY.length
    : lineStartMatch ? lineStartMatch.index + lineStartMatch[1].length : -1;
  if (rootIndex === -1 && !isStreaming) {
    const looseMatches = [...content.matchAll(/root\s*=\s*(Stack|Card|TextContent|Form|Tabs|Carousel|Table|Accordion|Modal)\s*\(/g)];
    if (looseMatches.length > 0) rootIndex = looseMatches[looseMatches.length - 1]!.index!;
  }
  const leadingThinking = rootIndex === -1 ? content : content.slice(0, boundaryIndex >= 0 ? boundaryIndex : rootIndex).trim();
  const trailingThinking = trailingTraceIndex >= 0
    ? content.slice(trailingTraceIndex + TRAILING_TRACE_BOUNDARY.length).trim()
    : "";
  const thinking = [leadingThinking, trailingThinking].filter(Boolean).join("\n\n");
  const code = rootIndex >= 0
    ? normalizeOpenUiCode(content.slice(rootIndex, trailingTraceIndex >= 0 ? trailingTraceIndex : undefined))
    : "";
  return (
    <>
      <ThinkingBlock content={thinking} isStreaming={isStreaming} />
      {code ? (
        <Renderer
          response={code}
          library={openuiLibraryWithGfm}
          isStreaming={isStreaming}
        />
      ) : !isStreaming && (
        <div
          style={{
            border: "1px solid #f0caca",
            background: "#fff7f7",
            color: "#8f3a3a",
            borderRadius: 10,
            padding: "12px 14px",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          模型响应没有生成有效的 OpenUI 界面。请重新发送，或在原需求后补充“请只输出 openui-lang”。
        </div>
      )}
    </>
  );
};

const adapter = createOpenCodeAdapter(systemPrompt);

export default function Home() {
  return (
    <div style={{ height: "100vh", width: "100vw", overflow: "hidden" }}>
      <AgentInterface
        llm={adapter.llm as any}
        storage={adapter.storage}
        componentLibrary={openuiLibraryWithGfm}
        agentName="OpenUI"
        components={{ AssistantMessage: CustomAssistantMessage }}
      />
    </div>
  );
}
