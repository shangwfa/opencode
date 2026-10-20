import { describe, expect, it, vi } from "vitest";
import {
  defaultRequirementChatConfig,
  normalizeRequirementChatConfig,
  readRequirementChatConfig,
  REQUIREMENT_CHAT_CONFIG_STORAGE_KEY,
  requirementChatConfigStorageKey,
  writeRequirementChatConfig,
} from "./requirement-chat-config";

function storage(initial?: Record<string, string>) {
  const data = new Map<string, string>();
  for (const [key, value] of Object.entries(initial ?? {})) {
    data.set(key, value);
  }
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    data,
  };
}

describe("requirement chat config", () => {
  it("uses enabled defaults", () => {
    expect(normalizeRequirementChatConfig(undefined)).toEqual(
      defaultRequirementChatConfig,
    );
    expect(readRequirementChatConfig("project-a", storage())).toEqual({
      general: { autoRecording: true, artifactGenerationMode: "concise" },
      preview: { autoInjectToken: true, customToken: "", useIpHost: false },
    });
  });

  it("fills missing localStorage fields with defaults", () => {
    expect(
      readRequirementChatConfig(
        "project-a",
        storage({
          [requirementChatConfigStorageKey("project-a")]: JSON.stringify({
            general: { autoRecording: false },
          }),
        }),
      ),
    ).toEqual({
      general: { autoRecording: false, artifactGenerationMode: "concise" },
      preview: { autoInjectToken: true, customToken: "", useIpHost: false },
    });
  });

  it("falls back to concise mode for an invalid stored value", () => {
    expect(
      normalizeRequirementChatConfig({
        general: {
          autoRecording: true,
          artifactGenerationMode: "expanded",
        },
      }),
    ).toMatchObject({
      general: { autoRecording: true, artifactGenerationMode: "concise" },
    });
  });

  it("normalizes before writing", () => {
    const s = storage();

    writeRequirementChatConfig(
      "project-a",
      {
        general: {
          autoRecording: false,
          artifactGenerationMode: "detailed",
        },
        preview: {
          autoInjectToken: true,
          customToken: "custom-token",
          useIpHost: true,
        },
      },
      s,
    );

    expect(s.setItem).toHaveBeenCalledWith(
      requirementChatConfigStorageKey("project-a"),
      JSON.stringify({
        general: {
          autoRecording: false,
          artifactGenerationMode: "detailed",
        },
        preview: {
          autoInjectToken: true,
          customToken: "custom-token",
          useIpHost: true,
        },
      }),
    );
  });

  it("keeps configs isolated by project id", () => {
    const s = storage();

    writeRequirementChatConfig(
      "project-a",
      {
        general: {
          autoRecording: false,
          artifactGenerationMode: "detailed",
        },
        preview: {
          autoInjectToken: true,
          customToken: "token-a",
          useIpHost: true,
        },
      },
      s,
    );
    writeRequirementChatConfig(
      "project-b",
      {
        general: { autoRecording: true, artifactGenerationMode: "concise" },
        preview: {
          autoInjectToken: false,
          customToken: "token-b",
          useIpHost: false,
        },
      },
      s,
    );

    expect(readRequirementChatConfig("project-a", s)).toEqual({
      general: {
        autoRecording: false,
        artifactGenerationMode: "detailed",
      },
      preview: {
        autoInjectToken: true,
        customToken: "token-a",
        useIpHost: true,
      },
    });
    expect(readRequirementChatConfig("project-b", s)).toEqual({
      general: { autoRecording: true, artifactGenerationMode: "concise" },
      preview: {
        autoInjectToken: false,
        customToken: "token-b",
        useIpHost: false,
      },
    });
  });

  it("migrates legacy config into the current project key", () => {
    const s = storage({
      [REQUIREMENT_CHAT_CONFIG_STORAGE_KEY]: JSON.stringify({
        general: { autoRecording: false },
        preview: { autoInjectToken: false },
      }),
    });

    expect(readRequirementChatConfig("project-a", s)).toEqual({
      general: { autoRecording: false, artifactGenerationMode: "concise" },
      preview: { autoInjectToken: false, customToken: "", useIpHost: false },
    });
    expect(s.setItem).toHaveBeenCalledWith(
      requirementChatConfigStorageKey("project-a"),
      JSON.stringify({
        general: { autoRecording: false, artifactGenerationMode: "concise" },
        preview: {
          autoInjectToken: false,
          customToken: "",
          useIpHost: false,
        },
      }),
    );
  });

  it("migrates old proxy url config to the ip host setting", () => {
    expect(
      normalizeRequirementChatConfig({
        preview: { useProxyUrl: true },
      }),
    ).toMatchObject({
      preview: { useIpHost: false },
    });
    expect(
      normalizeRequirementChatConfig({
        preview: { useProxyUrl: false },
      }),
    ).toMatchObject({
      preview: { useIpHost: true },
    });
  });
});
