"use client";

import {
  type ChatMessage,
  type ChatThread,
  type Phase,
  type TraceItem,
  createOpenCodeService,
} from "@/lib/opencode-adapter";
import { ShadcnAssistantMessage } from "@/components/opencode-assistant-message";
import { shadcnSystemPrompt } from "@/generated/system-prompt";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { MessageSquare, Plus, Send, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const STARTERS = [
  {
    displayText: "Startup dashboard",
    prompt:
      "Build a startup analytics dashboard with tags, tabs for revenue and growth charts, a key metrics table, and a progress bar toward the annual goal.",
  },
  {
    displayText: "Market watch",
    prompt:
      "Fetch stock prices for AAPL, NVDA, GOOGL, and TSLA. Show a market overview with tags, a comparison table, and an alert for the biggest mover.",
  },
  {
    displayText: "Team standup",
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

type ThreadState = {
  messages: ChatMessage[];
  phase: Phase;
  recovering: boolean;
};

export function ChatApp() {
  const service = useMemo(() => createOpenCodeService(shadcnSystemPrompt), []);

  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadStates, setThreadStates] = useState<Record<string, ThreadState>>({});
  const [input, setInput] = useState("");

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

  return (
    <SidebarProvider>
      <div className="flex h-screen w-screen overflow-hidden">
        <Sidebar>
          <SidebarHeader className="px-3 py-2.5">
            <span className="text-sm font-semibold">OpenCode shadcn</span>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <div className="px-2 pb-2">
                  <SidebarMenuButton className="w-full" onClick={createThread}>
                    <Plus className="size-4" />
                    <span>New Chat</span>
                  </SidebarMenuButton>
                </div>
                <ScrollArea className="h-[calc(100vh-8rem)]">
                  <SidebarMenu>
                    {threads.map((thread) => (
                      <SidebarMenuItem key={thread.id}>
                        <SidebarMenuButton
                          isActive={thread.id === selectedThreadId}
                          onClick={() => selectThread(thread.id)}
                        >
                          <MessageSquare className="size-3.5 shrink-0 opacity-60" />
                          <span>{thread.title || "New conversation"}</span>
                        </SidebarMenuButton>
                        <SidebarMenuAction onClick={() => deleteThread(thread.id)}>
                          ×
                        </SidebarMenuAction>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </ScrollArea>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>

        <SidebarInset>
          <div className="flex flex-col h-screen">
            <header className="flex h-12 items-center gap-2 border-b px-4">
              <SidebarTrigger />
              <span className="text-sm font-medium">{threads.find((t) => t.id === selectedThreadId)?.title ?? "New conversation"}</span>
            </header>

            <div ref={scrollRef} className="flex-1 overflow-y-auto">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-6 p-8">
                  <div className="text-center space-y-1">
                    <h2 className="text-2xl font-semibold tracking-tight">OpenCode shadcn</h2>
                    <p className="text-sm text-muted-foreground">Choose a starter or type your query below</p>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-3 max-w-2xl w-full">
                    {STARTERS.map((starter) => (
                      <Card
                        key={starter.displayText}
                        className="cursor-pointer hover:bg-muted/50 transition-colors"
                        onClick={() => sendMessage(starter.prompt)}
                      >
                        <CardContent className="p-4">
                          <span className="text-sm font-medium">{starter.displayText}</span>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
                  {messages.map((message) =>
                    message.role === "user" ? (
                      <div key={message.id} className="flex justify-end">
                        <div className="rounded-2xl bg-primary text-primary-foreground px-4 py-2.5 max-w-[80%] text-sm whitespace-pre-wrap">
                          {message.content}
                        </div>
                      </div>
                    ) : (
                      <ShadcnAssistantMessage
                        key={message.id}
                        message={message}
                        phase={phase}
                        onFollowUp={(text) => sendMessage(text)}
                      />
                    ),
                  )}
                </div>
              )}
            </div>

            {recovering && (
              <div className="fixed bottom-5 right-5 z-50 flex items-center gap-3 rounded-xl border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="size-1.5 rounded-full bg-primary/60 animate-pulse" style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </div>
                <span className="text-sm text-muted-foreground">后台继续生成中</span>
                <Button size="icon" variant="default" className="size-7" onClick={stopRecovery}>
                  <Square className="size-3 fill-current" />
                </Button>
              </div>
            )}

            <div className="border-t bg-background/95 backdrop-blur p-4">
              <div className="max-w-3xl mx-auto flex gap-2 items-end">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your query here"
                  className="min-h-[44px] max-h-32 resize-none"
                  rows={1}
                  disabled={phase !== "idle"}
                />
                <Button
                  size="icon"
                  className="size-11 shrink-0"
                  disabled={phase !== "idle" || !input.trim()}
                  onClick={() => { sendMessage(input); setInput(""); }}
                >
                  {phase !== "idle" ? <Square className="size-4 fill-current" /> : <Send className="size-4" />}
                </Button>
              </div>
            </div>
          </div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
