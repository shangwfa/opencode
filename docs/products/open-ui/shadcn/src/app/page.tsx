"use client";

import { useTheme } from "@/hooks/use-system-theme";
import { ShadcnAssistantMessage } from "@/components/opencode-assistant-message";
import { createOpenCodeAdapter, SESSION_PENDING_MARKER } from "@/lib/opencode-adapter";
import { shadcnChatLibrary } from "@/lib/shadcn-genui";
import { shadcnSystemPrompt } from "@/generated/system-prompt";
import type { ChatStorage } from "@openuidev/react-headless";
import { useThread, useThreadList } from "@openuidev/react-headless";
import { AgentInterface } from "@openuidev/react-ui";
import { useEffect, useMemo, useRef } from "react";

export default function Page() {
  const mode = useTheme();
  const adapter = useMemo(() => createOpenCodeAdapter(shadcnSystemPrompt), []);

  return (
    <div className="h-screen w-screen overflow-hidden relative">
      <AgentInterface
        llm={adapter.llm as any}
        storage={adapter.storage}
        componentLibrary={shadcnChatLibrary}
        agentName="OpenCode shadcn"
        theme={{ mode }}
        components={{ AssistantMessage: ShadcnAssistantMessage }}
        scrollVariant="always"
        starterVariant="short"
        starters={[
          {
            displayText: "Startup dashboard",
            prompt: "Build a startup analytics dashboard with tags, tabs for revenue and growth charts, a key metrics table, and a progress bar toward the annual goal.",
          },
          {
            displayText: "Market watch",
            prompt: "Fetch stock prices for AAPL, NVDA, GOOGL, and TSLA. Show a market overview with tags, a comparison table, and an alert for the biggest mover.",
          },
          {
            displayText: "Team standup",
            prompt: "Generate a team standup board with a sprint progress bar, task table, warning alert for blockers, and an accordion for yesterday, today, and blockers.",
          },
        ]}
      >
        <SessionRecovery storage={adapter.storage} />
      </AgentInterface>
    </div>
  );
}

function SessionRecovery({ storage }: { storage: ChatStorage }) {
  const selectedThreadId = useThreadList((state) => state.selectedThreadId);
  const messages = useThread((state) => state.messages);
  const isRunning = useThread((state) => state.isRunning);
  const setMessages = useThread((state) => state.setMessages);
  const selectedThreadRef = useRef(selectedThreadId);
  selectedThreadRef.current = selectedThreadId;
  const isRecovering = messages.some((message) => message.role === "assistant" && message.content?.includes(SESSION_PENDING_MARKER));

  useEffect(() => {
    if (!selectedThreadId || isRunning || !isRecovering) return;
    let active = true;
    const refresh = async () => {
      while (active && selectedThreadRef.current === selectedThreadId) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!active || selectedThreadRef.current !== selectedThreadId) return;
        const next = await storage.thread.getMessages(selectedThreadId);
        if (!active || selectedThreadRef.current !== selectedThreadId) return;
        setMessages(next);
        const pending = next.some((message) => message.role === "assistant" && message.content?.includes(SESSION_PENDING_MARKER));
        if (!pending) return;
      }
    };
    refresh().catch(() => {});
    return () => {
      active = false;
    };
  }, [isRecovering, isRunning, selectedThreadId, setMessages, storage]);

  return null;
}
