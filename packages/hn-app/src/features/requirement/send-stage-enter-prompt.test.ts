import { describe, expect, test, vi } from "vitest";
import { sendStageEnterPrompt } from "./send-stage-enter-prompt";

describe("sendStageEnterPrompt", () => {
  test("sends the generation mode as a hidden snapshot", async () => {
    const promptAsync = vi.fn(async (_request?: unknown) => undefined);

    await sendStageEnterPrompt({
      entry: {
        sessionId: "session-1",
        agent: "dyn-build",
        text: "开始代码实施。",
        artifactGenerationMode: "detailed",
      },
      client: {
        provider: { list: vi.fn(async () => ({ data: [] })) },
        session: { promptAsync },
      },
      resolveModel: vi.fn(async () => ({
        providerID: "provider",
        modelID: "model",
      })),
    });

    expect(promptAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        messageID: expect.stringMatching(/^msg_/),
      }),
    );
    const request = promptAsync.mock.calls[0]![0] as {
      parts: { type: string; text: string; synthetic?: boolean }[]
      messageID: string
    }
    expect(request.parts[0]).toEqual({ type: "text", text: "开始代码实施。" });
    expect(request.parts[1]).toEqual({
      type: "text",
      text: expect.stringMatching(
        /^\[Artifact Generation Context\]\nartifactGenerationMode: detailed\nartifactCausedByMessageId: msg_/,
      ),
      synthetic: true,
    });
    expect(request.parts[1].text).toContain(
      `artifactCausedByMessageId: ${request.messageID}`,
    );
  });
});
