"use client";

import { useTheme } from "@/hooks/use-system-theme";
import { ShadcnAssistantMessage } from "@/components/opencode-assistant-message";
import { createOpenCodeAdapter } from "@/lib/opencode-adapter";
import { shadcnChatLibrary } from "@/lib/shadcn-genui";
import { shadcnSystemPrompt } from "@/generated/system-prompt";
import { AgentInterface } from "@openuidev/react-ui";
import { useMemo } from "react";

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
      />
    </div>
  );
}
