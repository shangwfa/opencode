"use client";

import {
  type ChatMessage,
  type ChatThread,
  type Phase,
  type TraceItem,
  createOpenCodeService,
} from "@/lib/opencode-adapter";
import { AntdAssistantMessage } from "@/components/opencode-assistant-message";
import { antdSystemPrompt } from "@/generated/system-prompt";
import { Button, Input, Layout, Card, Typography, Tooltip, Flex, Space, Row, Col } from "antd";
import {
  PlusOutlined,
  SendOutlined,
  StopOutlined,
  DeleteOutlined,
  MessageOutlined,
  ThunderboltOutlined,
  BarChartOutlined,
  TeamOutlined,
} from "@ant-design/icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const { Sider, Content } = Layout;
const { Text, Title } = Typography;

const STARTERS = [
  {
    icon: <BarChartOutlined />,
    title: "Startup dashboard",
    desc: "Analytics with charts & metrics",
    prompt:
      "Build a startup analytics dashboard with tags, tabs for revenue and growth charts, a key metrics table, and a progress bar toward the annual goal.",
  },
  {
    icon: <ThunderboltOutlined />,
    title: "Market watch",
    desc: "Stock comparison with alerts",
    prompt:
      "Fetch stock prices for AAPL, NVDA, GOOGL, and TSLA. Show a market overview with tags, a comparison table, and an alert for the biggest mover.",
  },
  {
    icon: <TeamOutlined />,
    title: "Team standup",
    desc: "Sprint board with progress",
    prompt:
      "Generate a team standup board with a sprint progress bar, task table, warning alert for blockers, and an accordion for yesterday, today, and blockers.",
  },
];

function upsertTrace(traces: TraceItem[], item: TraceItem): TraceItem[] {
  const idx = traces.findIndex((t) => t.id === item.id);
  if (idx >= 0) {
    const next = [...traces];
    next[idx] = item;
    return next;
  }
  return [...traces, item];
}

function displayTitle(title: string | undefined) {
  if (!title || title.startsWith("New session")) return "新会话";
  return title;
}

type ThreadState = {
  messages: ChatMessage[];
  phase: Phase;
  recovering: boolean;
};

export function ChatApp() {
  const service = useMemo(() => createOpenCodeService(antdSystemPrompt), []);

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadStates, setThreadStates] = useState<Record<string, ThreadState>>({});
  const [input, setInput] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);

  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const threadStatesRef = useRef(threadStates);
  threadStatesRef.current = threadStates;
  const scrollRef = useRef<HTMLDivElement>(null);

  const current = selectedThreadId ? threadStates[selectedThreadId] : undefined;
  const messages = current?.messages ?? [];
  const phase = current?.phase ?? "idle";
  const recovering = current?.recovering ?? false;

  const loadThreads = useCallback(async () => {
    try { setThreads(await service.listThreads()); } catch {}
  }, [service]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  const updateAssistant = useCallback((threadId: string, assistantId: string, updater: (m: ChatMessage) => ChatMessage) => {
    setThreadStates((prev) => {
      const state = prev[threadId];
      if (!state) return prev;
      return {
        ...prev,
        [threadId]: { ...state, messages: state.messages.map((m) => (m.id === assistantId ? updater(m) : m)) },
      };
    });
  }, []);

  const setThreadPhase = useCallback((threadId: string, phase: Phase) => {
    setThreadStates((prev) => {
      const state = prev[threadId];
      if (!state) return prev;
      return { ...prev, [threadId]: { ...state, phase } };
    });
  }, []);

  const setThreadRecovering = useCallback((threadId: string, recovering: boolean) => {
    setThreadStates((prev) => {
      const state = prev[threadId];
      if (!state) return prev;
      return { ...prev, [threadId]: { ...state, recovering } };
    });
  }, []);

  const startResume = useCallback((threadId: string, assistantId: string, streamingStarted: boolean) => {
    const controller = new AbortController();
    controllersRef.current.set(threadId, controller);
    service.resumeSession(threadId, streamingStarted, {
      onReasoning: (delta) =>
        updateAssistant(threadId, assistantId, (m) => ({ ...m, reasoning: (m.reasoning ?? "") + delta })),
      onTrace: (item) =>
        updateAssistant(threadId, assistantId, (m) => ({ ...m, traces: upsertTrace(m.traces ?? [], item) })),
      onRenderStart: () => {
        updateAssistant(threadId, assistantId, (m) => ({ ...m, code: "" }));
        setThreadPhase(threadId, "rendering");
      },
      onRenderDelta: (delta) =>
        updateAssistant(threadId, assistantId, (m) => ({ ...m, code: (m.code ?? "") + delta })),
      onDone: (finalMessages) => {
        setThreadStates((prev) => {
          const state = prev[threadId];
          if (!state) return prev;
          return { ...prev, [threadId]: { ...state, messages: finalMessages, recovering: false, phase: "idle" } };
        });
      },
      onTitle: (title) =>
        setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t))),
    }, controller.signal).catch(() => {
      service.getMessages(threadId).then((msgs) => {
        setThreadStates((prev) => {
          const state = prev[threadId];
          if (!state) return prev;
          return { ...prev, [threadId]: { ...state, messages: msgs, recovering: false, phase: "idle" } };
        });
      }).catch(() => {
        setThreadRecovering(threadId, false);
        setThreadPhase(threadId, "idle");
      });
    }).finally(() => {
      if (controllersRef.current.get(threadId) === controller) controllersRef.current.delete(threadId);
      loadThreads();
    });
  }, [service, updateAssistant, setThreadPhase, setThreadRecovering, loadThreads]);

  const selectThread = useCallback(async (threadId: string) => {
    setSelectedThreadId(threadId);
    if (threadStatesRef.current[threadId]) return;
    const msgs = await service.getMessages(threadId).catch(() => []);
    if (threadStatesRef.current[threadId]) return;
    setThreadStates((prev) => ({ ...prev, [threadId]: { messages: msgs, phase: "idle", recovering: false } }));
    const activeAssistant = msgs.findLast((m) => m.role === "assistant" && m.recovering);
    if (!activeAssistant) return;
    setThreadRecovering(threadId, true);
    setThreadPhase(threadId, "thinking");
    startResume(threadId, activeAssistant.id, Boolean(activeAssistant.code));
  }, [service, startResume, setThreadRecovering, setThreadPhase]);

  const stopRecovery = useCallback(async () => {
    if (!selectedThreadId) return;
    const threadId = selectedThreadId;
    controllersRef.current.get(threadId)?.abort();
    controllersRef.current.delete(threadId);
    await service.abortSession(threadId);
    const msgs = await service.getMessages(threadId).catch(() => null);
    if (msgs) {
      setThreadStates((prev) => ({ ...prev, [threadId]: { messages: msgs, phase: "idle", recovering: false } }));
    }
  }, [selectedThreadId, service]);

  const createThread = useCallback(async () => {
    const thread = await service.createThread();
    setThreads((prev) => [thread, ...prev]);
    setSelectedThreadId(thread.id);
    setThreadStates((prev) => ({ ...prev, [thread.id]: { messages: [], phase: "idle", recovering: false } }));
  }, [service]);

  const deleteThread = useCallback(async (threadId: string) => {
    controllersRef.current.get(threadId)?.abort();
    controllersRef.current.delete(threadId);
    await service.deleteThread(threadId);
    setThreads((prev) => prev.filter((t) => t.id !== threadId));
    setThreadStates((prev) => {
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
    if (selectedThreadId === threadId) setSelectedThreadId(null);
  }, [service, selectedThreadId]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;

    let threadId = selectedThreadId;
    if (!threadId) {
      const thread = await service.createThread();
      setThreads((prev) => [thread, ...prev]);
      threadId = thread.id;
      setSelectedThreadId(threadId);
      setThreadStates((prev) => ({ ...prev, [thread.id]: { messages: [], phase: "idle", recovering: false } }));
    }
    if (!threadId) return;

    const state = threadStatesRef.current[threadId];
    if (state && state.phase !== "idle") return;

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      reasoning: "",
      traces: [],
      code: null,
      status: "generating",
      recovering: false,
    };
    setThreadStates((prev) => {
      const s = prev[threadId];
      return {
        ...prev,
        [threadId]: {
          messages: [...(s?.messages ?? []), userMessage, assistantMessage],
          phase: "thinking",
          recovering: false,
        },
      };
    });

    const controller = new AbortController();
    controllersRef.current.set(threadId, controller);

    try {
      await service.sendMessage(threadId, text, {
        onReasoning: (delta) =>
          updateAssistant(threadId, assistantId, (m) => ({ ...m, reasoning: (m.reasoning ?? "") + delta })),
        onTrace: (item) =>
          updateAssistant(threadId, assistantId, (m) => ({ ...m, traces: upsertTrace(m.traces ?? [], item) })),
        onRenderStart: () => {
          updateAssistant(threadId, assistantId, (m) => ({ ...m, code: "" }));
          setThreadPhase(threadId, "rendering");
        },
        onRenderDelta: (delta) =>
          updateAssistant(threadId, assistantId, (m) => ({ ...m, code: (m.code ?? "") + delta })),
        onIdle: () =>
          updateAssistant(threadId, assistantId, (m) => ({ ...m, status: "done" })),
        onTitle: (title) =>
          setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, title } : t))),
      }, controller.signal);
    } catch {
    } finally {
      setThreadPhase(threadId, "idle");
      if (controllersRef.current.get(threadId) === controller) controllersRef.current.delete(threadId);
      loadThreads();
    }
  }, [service, selectedThreadId, updateAssistant, setThreadPhase, loadThreads]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
      setInput("");
    }
  };

  const sendDisabled = phase !== "idle" || !input.trim();

  return (
    <Layout style={{ height: "100vh", overflow: "hidden" }}>
      <Sider
        width={264}
        collapsedWidth={0}
        collapsed={collapsed}
        theme="light"
        style={{ borderRight: "1px solid var(--ant-color-border-secondary)" }}
        trigger={null}
      >
        <Flex align="center" gap={8} style={{ padding: "14px 16px", borderBottom: "1px solid var(--ant-color-border-secondary)" }}>
          <MessageOutlined style={{ color: "var(--app-primary)", fontSize: 16 }} />
          <Text strong style={{ fontSize: 15, letterSpacing: "-0.01em" }}>OpenCode antd</Text>
        </Flex>
        <div style={{ padding: 12 }}>
          <Button
            type="primary"
            block
            icon={<PlusOutlined />}
            onClick={createThread}
            style={{ borderRadius: 8, height: 36, fontWeight: 500 }}
          >
            New Chat
          </Button>
        </div>
        <div style={{ overflow: "auto", height: "calc(100vh - 112px)", padding: "0 8px" }}>
          {threads.length === 0 ? (
            <Flex justify="center" style={{ padding: "24px 16px" }}>
              <Text type="secondary" style={{ fontSize: 12 }}>暂无会话</Text>
            </Flex>
          ) : (
            threads.map((thread) => (
              <Flex
                key={thread.id}
                align="center"
                justify="space-between"
                onClick={() => selectThread(thread.id)}
                style={{
                  padding: "8px 12px",
                  marginBottom: 2,
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 13,
                  background: selectedThreadId === thread.id ? "var(--app-primary-bg)" : hoveredThreadId === thread.id ? "var(--ant-color-fill-secondary)" : "transparent",
                  color: selectedThreadId === thread.id ? "var(--app-primary)" : "var(--ant-color-text)",
                  transition: "background 0.15s",
                }}
                onMouseEnter={() => setHoveredThreadId(thread.id)}
                onMouseLeave={() => setHoveredThreadId(null)}
              >
                <Text
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                    color: "inherit",
                  }}
                >
                  {displayTitle(thread.title)}
                </Text>
                <Tooltip title="删除">
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    danger
                    style={{
                      opacity: hoveredThreadId === thread.id ? 1 : 0,
                      transition: "opacity 0.15s",
                    }}
                    onMouseEnter={() => setHoveredThreadId(thread.id)}
                    onMouseLeave={() => setHoveredThreadId(null)}
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteThread(thread.id);
                    }}
                  />
                </Tooltip>
              </Flex>
            ))
          )}
        </div>
      </Sider>
      <Layout>
        <Flex
          align="center"
          gap={8}
          style={{ height: 48, padding: "0 16px", borderBottom: "1px solid var(--ant-color-border-secondary)" }}
        >
          <Button
            type="text"
            icon={<MessageOutlined />}
            onClick={() => setCollapsed(!collapsed)}
            size="small"
          />
          <Text strong style={{ fontSize: 14 }}>
            {threads.find((t) => t.id === selectedThreadId)
              ? displayTitle(threads.find((t) => t.id === selectedThreadId)!.title)
              : "New conversation"}
          </Text>
        </Flex>

        <div ref={scrollRef} style={{ flex: 1, overflow: "auto", background: "var(--ant-color-bg-layout)" }}>
          {messages.length === 0 ? (
            <Flex vertical align="center" justify="center" style={{ height: "100%", padding: 32 }} gap={40}>
              <Flex vertical align="center" gap={16}>
                <Flex
                  align="center"
                  justify="center"
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: 16,
                    background: "var(--app-primary-bg)",
                  }}
                >
                  <MessageOutlined style={{ fontSize: 24, color: "var(--app-primary)" }} />
                </Flex>
                <Title level={3} style={{ margin: 0, textAlign: "center" }}>OpenCode antd</Title>
                <Text type="secondary">选择一个场景开始，或直接输入您的问题</Text>
              </Flex>
              <Row gutter={[12, 12]} style={{ maxWidth: 640, width: "100%" }}>
                {STARTERS.map((starter) => (
                  <Col span={8} key={starter.title}>
                    <Card
                      hoverable
                      size="small"
                      onClick={() => sendMessage(starter.prompt)}
                      style={{ borderRadius: 12, height: "100%" }}
                      styles={{ body: { padding: 16 } }}
                    >
                      <Flex vertical gap={4}>
                        <Text style={{ fontSize: 20, color: "var(--app-primary)", marginBottom: 4 }}>
                          {starter.icon}
                        </Text>
                        <Text strong style={{ fontSize: 13 }}>{starter.title}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>{starter.desc}</Text>
                      </Flex>
                    </Card>
                  </Col>
                ))}
              </Row>
            </Flex>
          ) : (
            <Space orientation="vertical" size={24} style={{ maxWidth: 960, margin: "0 auto", padding: "24px 32px 40px", display: "flex" }}>
              {messages.map((message) =>
                message.role === "user" ? (
                  <Flex key={message.id} justify="flex-end">
                    <div style={{
                      background: "var(--app-primary)",
                      color: "#fff",
                      borderRadius: "16px 16px 4px 16px",
                      padding: "10px 16px",
                      maxWidth: "75%",
                      fontSize: 14,
                      lineHeight: 1.6,
                      whiteSpace: "pre-wrap",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.06)",
                    }}>
                      {message.content}
                    </div>
                  </Flex>
                ) : (
                  <AntdAssistantMessage
                    key={message.id}
                    message={message}
                    phase={phase}
                    onFollowUp={(text) => sendMessage(text)}
                  />
                ),
              )}
            </Space>
          )}
        </div>

        {recovering && (
          <Flex
            align="center"
            gap={10}
            style={{
              position: "fixed",
              bottom: 96,
              right: 24,
              zIndex: 1000,
              background: "var(--ant-color-bg-elevated)",
              border: "1px solid var(--ant-color-border)",
              borderRadius: 24,
              padding: "8px 16px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
              backdropFilter: "blur(12px)",
            }}
          >
            <span style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--app-primary)",
              animation: "pulse 1.2s ease-in-out infinite",
            }} />
            <Text type="secondary" style={{ fontSize: 12 }}>后台继续生成中</Text>
            <Button size="small" type="text" danger icon={<StopOutlined />} onClick={stopRecovery} />
          </Flex>
        )}

        <div style={{ borderTop: "1px solid var(--ant-color-border-secondary)", background: "var(--ant-color-bg-container)", padding: "12px 16px 16px" }}>
          <div style={{ maxWidth: 960, margin: "0 auto" }}>
            <div className="chat-input-box">
              <Input.TextArea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入您的问题，Enter 发送，Shift+Enter 换行"
                autoSize={{ minRows: 1, maxRows: 6 }}
                disabled={phase !== "idle"}
                variant="borderless"
                style={{ padding: "4px 0", resize: "none", fontSize: 14 }}
              />
              <Button
                type="primary"
                shape="circle"
                icon={phase !== "idle" ? <StopOutlined /> : <SendOutlined />}
                disabled={sendDisabled}
                onClick={() => { sendMessage(input); setInput(""); }}
                style={{ flexShrink: 0 }}
              />
            </div>
            <Flex justify="center" style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                OpenCode 可能会出错，请核实重要信息
              </Text>
            </Flex>
          </div>
        </div>
      </Layout>
    </Layout>
  );
}