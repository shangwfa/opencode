"use client";

import { BuiltinActionType, type ActionEvent, Renderer } from "@openuidev/react-lang";
import {
  aggregateStats,
  type ChatMessage,
  type Phase,
  normalizeOpenUiCode,
  type TraceItem,
} from "@/lib/opencode-adapter";
import { antdChatLibrary } from "@/lib/antd-genui";
import { Typography, Flex } from "antd";
import {
  RightOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
} from "@ant-design/icons";
import { useCallback, useState } from "react";

const { Text } = Typography;

function ThinkingBlock({ reasoning, traces, isStreaming }: { reasoning: string; traces: TraceItem[]; isStreaming?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const effectiveExpanded = isStreaming ? true : expanded;
  const items = traces.filter((item) => item.kind !== "stats");
  const stats = aggregateStats(traces);
  const hasStats = stats.steps > 0;
  const hasContent = Boolean(reasoning.trim()) || items.length > 0 || hasStats || isStreaming;
  if (!hasContent) return null;

  return (
    <div style={{
      marginBottom: 12,
      borderRadius: 12,
      border: "1px solid var(--ant-color-border-secondary)",
      overflow: "hidden",
      background: "var(--ant-color-fill-quaternary)",
    }}>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={effectiveExpanded}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 14px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
          fontSize: 13,
          color: "var(--ant-color-text-secondary)",
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = "var(--ant-color-fill-tertiary)"}
        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
      >
        <RightOutlined
          style={{
            fontSize: 11,
            transition: "transform 0.2s",
            transform: effectiveExpanded ? "rotate(90deg)" : undefined,
          }}
        />
        <Text strong style={{ fontSize: 13, color: "var(--ant-color-text)" }}>
          {isStreaming ? "正在思考" : "已深度思考"}
        </Text>
        <ClockCircleOutlined style={{ marginLeft: "auto", opacity: 0.5, fontSize: 12 }} />
      </button>
      {effectiveExpanded && (
        <div style={{
          borderTop: "1px solid var(--ant-color-border-secondary)",
          padding: "12px 16px",
          fontSize: 13,
          lineHeight: 1.75,
          color: "var(--ant-color-text-secondary)",
          background: "var(--ant-color-bg-container)",
        }}>
          {reasoning.trim() && (
            <div style={{
              borderLeft: "2px solid var(--app-primary)",
              paddingLeft: 12,
              whiteSpace: "pre-wrap",
              marginBottom: items.length > 0 ? 12 : 0,
            }}>
              {reasoning.trim()}
            </div>
          )}
          {items.length > 0 && (
            <Flex vertical gap={4}>
              {items.map((item) => (
                <TraceRow key={item.id} item={item} />
              ))}
            </Flex>
          )}
          {hasStats && (
            <div style={{
              marginTop: 10,
              paddingTop: 8,
              borderTop: "1px dashed var(--ant-color-border-secondary)",
              fontSize: 12,
              color: "var(--ant-color-text-tertiary)",
            }}>
              {`输入 ${stats.tokens.input.toLocaleString()} · 输出 ${stats.tokens.output.toLocaleString()} · 推理 ${stats.tokens.reasoning.toLocaleString()} · 缓存读取 ${stats.tokens.cacheRead.toLocaleString()} · ${stats.steps} 个步骤`}
            </div>
          )}
          {isStreaming && !reasoning.trim() && items.length === 0 && !hasStats && (
            <Text type="secondary" style={{ fontSize: 13 }}>正在等待 OpenCode 返回执行进度…</Text>
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
  const isError = item.status === "error";

  return (
    <div style={{ borderRadius: 8, background: "var(--ant-color-fill-secondary)", overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => hasDetails && setOpen(!open)}
        aria-expanded={hasDetails ? open : undefined}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          border: "none",
          background: "transparent",
          cursor: hasDetails ? "pointer" : "default",
          fontSize: 13,
          color: "var(--ant-color-text-secondary)",
        }}
      >
        <span style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isError ? "var(--ant-color-error)" : item.status === "completed" ? "var(--ant-color-success)" : "var(--ant-color-text-tertiary)",
          display: "inline-block",
          flexShrink: 0,
        }} />
        <Text style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 13,
          color: "var(--ant-color-text)",
        }}>
          {item.title}
        </Text>
        {status && <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>{status}</Text>}
        {hasDetails && (
          <RightOutlined style={{
            fontSize: 11,
            transition: "transform 0.2s",
            transform: open ? "rotate(90deg)" : undefined,
            flexShrink: 0,
          }} />
        )}
      </button>
      {open && (
        <Flex vertical style={{ maxHeight: 288, overflow: "auto", padding: "0 12px 10px 26px", fontSize: 12, color: "var(--ant-color-text-secondary)" }}>
          {item.input && <TraceDetail label="输入" value={JSON.stringify(item.input, null, 2)} />}
          {item.output && <TraceDetail label="结果" value={item.output} />}
          {item.error && <TraceDetail label="错误" value={item.error} />}
        </Flex>
      )}
    </div>
  );
}

function TraceDetail({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      <pre style={{
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: "SF Mono, Monaco, monospace",
        fontSize: 12,
        lineHeight: 1.5,
        margin: "4px 0 0",
        padding: 8,
        background: "var(--ant-color-fill-tertiary)",
        borderRadius: 6,
      }}>{value}</pre>
    </div>
  );
}

export function AntdAssistantMessage({
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
        <Renderer response={code} library={antdChatLibrary} isStreaming={isStreaming} onAction={handleAction} />
      ) : message.error && !isGenerating && !isRecovering && (
        <Flex align="flex-start" gap={8} style={{
          borderRadius: 12,
          border: "1px solid var(--ant-color-error-border)",
          background: "var(--ant-color-error-bg)",
          padding: "10px 14px",
          fontSize: 13,
          color: "var(--ant-color-error)",
        }}>
          <CloseCircleOutlined style={{ marginTop: 2, flexShrink: 0 }} />
          <span>{message.error}</span>
        </Flex>
      )}
    </>
  );
}