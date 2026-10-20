/**
 * 需求会话配置（React/zustand 版）。
 * 源：xybot-front-opencode-ui src/features/requirement/config/requirement-chat-config.tsx
 * 纯函数（normalize/read/write/storageKey）1:1 保留；Solid Provider → zustand + React Context。
 */
import { createContext, useContext, useMemo, type ReactNode } from "react"
import { createStore, useStore } from "zustand"

export type RequirementChatConfig = {
  general: {
    autoRecording: boolean;
    artifactGenerationMode: ArtifactGenerationMode;
  };
  preview: {
    autoInjectToken: boolean;
    customToken: string;
    useIpHost: boolean;
  };
};

export type ArtifactGenerationMode = "concise" | "detailed";

export const REQUIREMENT_CHAT_CONFIG_STORAGE_KEY =
  "requirement.chat.config.v1";

export const defaultRequirementChatConfig: RequirementChatConfig = {
  general: {
    autoRecording: true,
    artifactGenerationMode: "concise",
  },
  preview: {
    autoInjectToken: true,
    customToken: "",
    useIpHost: false,
  },
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function normalizeProjectId(projectId: string): string {
  const trimmed = projectId.trim();
  return trimmed || "unknown";
}

export function requirementChatConfigStorageKey(projectId: string): string {
  return `${REQUIREMENT_CHAT_CONFIG_STORAGE_KEY}:${encodeURIComponent(
    normalizeProjectId(projectId),
  )}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeRequirementChatConfig(
  value: unknown,
): RequirementChatConfig {
  if (!isRecord(value)) return defaultRequirementChatConfig;
  const general = isRecord(value.general) ? value.general : {};
  const preview = isRecord(value.preview) ? value.preview : {};

  return {
    general: {
      autoRecording:
        typeof general.autoRecording === "boolean"
          ? general.autoRecording
          : defaultRequirementChatConfig.general.autoRecording,
      artifactGenerationMode:
        general.artifactGenerationMode === "detailed" ||
        general.artifactGenerationMode === "concise"
          ? general.artifactGenerationMode
          : defaultRequirementChatConfig.general.artifactGenerationMode,
    },
    preview: {
      autoInjectToken:
        typeof preview.autoInjectToken === "boolean"
          ? preview.autoInjectToken
          : defaultRequirementChatConfig.preview.autoInjectToken,
      customToken:
        typeof preview.customToken === "string"
          ? preview.customToken
          : defaultRequirementChatConfig.preview.customToken,
      useIpHost:
        typeof preview.useIpHost === "boolean"
          ? preview.useIpHost
          : typeof preview.useProxyUrl === "boolean"
            ? !preview.useProxyUrl
            : defaultRequirementChatConfig.preview.useIpHost,
    },
  };
}

function browserStorage(): StorageLike | undefined {
  if (typeof localStorage === "undefined") return undefined;
  return localStorage;
}

export function readRequirementChatConfig(
  projectId: string,
  storage: StorageLike | undefined = browserStorage(),
): RequirementChatConfig {
  if (!storage) return defaultRequirementChatConfig;
  try {
    const projectKey = requirementChatConfigStorageKey(projectId);
    const raw = storage.getItem(projectKey);
    if (!raw) {
      const legacyRaw = storage.getItem(REQUIREMENT_CHAT_CONFIG_STORAGE_KEY);
      if (!legacyRaw) return defaultRequirementChatConfig;
      const legacyConfig = normalizeRequirementChatConfig(
        JSON.parse(legacyRaw),
      );
      writeRequirementChatConfig(projectId, legacyConfig, storage);
      return legacyConfig;
    }
    return normalizeRequirementChatConfig(JSON.parse(raw));
  } catch {
    return defaultRequirementChatConfig;
  }
}

export function writeRequirementChatConfig(
  projectId: string,
  config: RequirementChatConfig,
  storage: StorageLike | undefined = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      requirementChatConfigStorageKey(projectId),
      JSON.stringify(normalizeRequirementChatConfig(config)),
    );
  } catch {
    // Local storage can be unavailable or full; the in-memory store still works.
  }
}

// ── [MIGRATION] Solid Provider → zustand ──────────────────────────────

export type RequirementChatConfigContextValue = {
  state: RequirementChatConfig;
  projectId: string;
  general: {
    autoRecording: () => boolean;
    setAutoRecording: (value: boolean) => void;
    artifactGenerationMode: () => ArtifactGenerationMode;
    setArtifactGenerationMode: (value: ArtifactGenerationMode) => void;
  };
  preview: {
    autoInjectToken: () => boolean;
    setAutoInjectToken: (value: boolean) => void;
    customToken: () => string;
    setCustomToken: (value: string) => void;
    useIpHost: () => boolean;
    setUseIpHost: (value: boolean) => void;
  };
};

export function createRequirementChatConfigStore(projectId: string) {
  const pid = normalizeProjectId(projectId);
  const store = createStore<RequirementChatConfig>(() =>
    readRequirementChatConfig(pid),
  );
  // 持久化：任意状态变化写回 storage（对齐源 createEffect）
  const persist = (config: RequirementChatConfig) =>
    writeRequirementChatConfig(pid, config);
  store.subscribe((state, prev) => {
    if (state !== prev) persist(state);
  });

  const ctx: RequirementChatConfigContextValue = {
    get state() {
      return store.getState();
    },
    projectId: pid,
    general: {
      autoRecording: () => store.getState().general.autoRecording,
      setAutoRecording(value) {
        store.setState((s) => ({
          general: { ...s.general, autoRecording: value },
        }));
      },
      artifactGenerationMode: () => store.getState().general.artifactGenerationMode,
      setArtifactGenerationMode(value) {
        store.setState((s) => ({
          general: { ...s.general, artifactGenerationMode: value },
        }));
      },
    },
    preview: {
      autoInjectToken: () => store.getState().preview.autoInjectToken,
      setAutoInjectToken(value) {
        store.setState((s) => ({
          preview: { ...s.preview, autoInjectToken: value },
        }));
      },
      customToken: () => store.getState().preview.customToken,
      setCustomToken(value) {
        store.setState((s) => ({
          preview: { ...s.preview, customToken: value },
        }));
      },
      useIpHost: () => store.getState().preview.useIpHost,
      setUseIpHost(value) {
        store.setState((s) => ({
          preview: { ...s.preview, useIpHost: value },
        }));
      },
    },
  };
  return ctx;
}

const RequirementChatConfigReactContext =
  createContext<RequirementChatConfigContextValue | null>(null);

export function RequirementChatConfigProvider({
  projectId,
  children,
}: {
  projectId: string
  children: ReactNode
}) {
  const value = useMemo(() => createRequirementChatConfigStore(projectId), [projectId])
  return (
    <RequirementChatConfigReactContext.Provider value={value}>
      {children}
    </RequirementChatConfigReactContext.Provider>
  )
}

export function useRequirementChatConfig() {
  const ctx = useContext(RequirementChatConfigReactContext);
  if (!ctx) {
    throw new Error(
      "useRequirementChatConfig must be used within RequirementChatConfigProvider",
    );
  }
  return ctx;
}

/** 供非组件代码订阅单个字段 */
export function useRequirementChatConfigState<T>(
  store: { getState: () => RequirementChatConfig; subscribe: unknown },
  selector: (s: RequirementChatConfig) => T,
): T {
  return useStore(store as never, selector)
}
