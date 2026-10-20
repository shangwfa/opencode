import type { ModelRef } from "./flows/config";
import { pickModel } from "@/context/requirement-sync/shared";
import type { ArtifactGenerationMode } from "./config/requirement-chat-config";
import { buildArtifactGenerationContext } from "./artifact-generation-context";
import { Identifier } from "@/utils/id";

type SendStageEnterPromptInput = {
  sessionId: string;
  agent: string;
  text: string;
  model?: ModelRef;
  artifactGenerationMode: ArtifactGenerationMode;
};

type SdkClient = {
  provider: { list: () => Promise<{ data: unknown }> };
  session: {
    promptAsync: (p: {
      sessionID: string;
      agent: string;
      model: ModelRef;
      messageID?: string;
      parts: { type: "text"; text: string; synthetic?: boolean }[];
    }) => Promise<unknown>;
  };
};

export async function sendStageEnterPrompt(input: {
  entry: SendStageEnterPromptInput;
  client: SdkClient;
  resolveModel: (hint?: ModelRef) => Promise<ModelRef>;
}) {
  const sid = input.entry.sessionId.trim();
  const text = input.entry.text.trim();
  if (!sid || !text) return;
  const picked = await input.resolveModel(input.entry.model);
  const messageID = Identifier.ascending("message");
  await input.client.session.promptAsync({
    sessionID: sid,
    agent: input.entry.agent,
    model: picked,
    messageID,
    parts: [
      { type: "text" as const, text },
      {
        type: "text" as const,
        text: buildArtifactGenerationContext(
          input.entry.artifactGenerationMode,
          messageID,
        ),
        synthetic: true,
      },
    ],
  });
}

export type { SendStageEnterPromptInput, SdkClient as StageEnterSdkClient };
