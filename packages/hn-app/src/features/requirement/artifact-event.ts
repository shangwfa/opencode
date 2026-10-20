/**
 * [DYNAMIC-HARNESS] ArtifactEvent 类型与 JSONL 解析。
 *
 * 对应文档 §7：agent 每次写/明显更新阶段产物时 append 一行 JSONL 到
 * `analysis/{reqId}/events/artifact-events.jsonl`。
 */

import type { ArtifactKind, StageConfig } from "./flows/config";

export type ArtifactEventType = "artifact" | "commitMsg";

export type ArtifactEvent = {
  id: string;
  /** 事件类型，缺省为 "artifact"；"commitMsg" 表示代码提交信息，仅需 agent/message/createdAt */
  type?: ArtifactEventType;
  stageId: string;
  agent: string;
  artifactPath: string;
  artifactKind: ArtifactKind;
  title: string;
  summary?: string;
  checksum?: string;
  causedByMessageId?: string;
  createdAt: string;
  /** [DYNAMIC-HARNESS] type="commitMsg" 时承载 commit message 文本 */
  message?: string;
};

function compareEventTime(a: ArtifactEvent, b: ArtifactEvent) {
  const aTime = Date.parse(a.createdAt);
  const bTime = Date.parse(b.createdAt);
  if (!Number.isNaN(aTime) && !Number.isNaN(bTime)) return aTime - bTime;
  return a.createdAt.localeCompare(b.createdAt);
}

/**
 * 解析 artifact-events.jsonl 原始文本。
 *
 * - 每行一个 JSON 对象，空行跳过
 * - 无效行（解析失败或缺字段）跳过，不抛错
 * - 返回按 createdAt 升序排列的事件列表
 */
export function parseArtifactEventsJsonl(raw: string): ArtifactEvent[] {
  const lines = raw.split("\n");
  const events: ArtifactEvent[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const event = normalizeArtifactEvent(obj);
    if (event) events.push(event);
  }
  return events.sort(compareEventTime);
}

/**
 * 校验并规范化单个 event 对象。
 *
 * - type="commitMsg"（或缺省 "artifact"）：commitMsg 仅要求 id/agent/message/createdAt
 * - artifact：必填 id/stageId/agent/artifactPath/artifactKind/title/createdAt
 */
function normalizeArtifactEvent(obj: unknown): ArtifactEvent | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.agent !== "string" || typeof o.createdAt !== "string") {
    return undefined;
  }
  const type: ArtifactEventType =
    o.type === "commitMsg" ? "commitMsg" : "artifact";

  if (type === "commitMsg") {
    if (typeof o.message !== "string") return undefined;
    return {
      id: o.id,
      type,
      stageId: "",
      agent: o.agent,
      artifactPath: "",
      artifactKind: "build_log",
      title: "",
      createdAt: o.createdAt,
      message: o.message,
      causedByMessageId:
        typeof o.causedByMessageId === "string"
          ? o.causedByMessageId
          : undefined,
    };
  }

  if (
    typeof o.stageId !== "string" ||
    typeof o.artifactPath !== "string" ||
    typeof o.artifactKind !== "string" ||
    typeof o.title !== "string"
  ) {
    return undefined;
  }
  return {
    id: o.id,
    type,
    stageId: o.stageId,
    agent: o.agent,
    artifactPath: o.artifactPath,
    artifactKind: o.artifactKind as ArtifactKind,
    title: o.title,
    summary: typeof o.summary === "string" ? o.summary : undefined,
    checksum: typeof o.checksum === "string" ? o.checksum : undefined,
    causedByMessageId:
      typeof o.causedByMessageId === "string"
        ? o.causedByMessageId
        : undefined,
    createdAt: o.createdAt,
  };
}

/** 取事件列表中最新一条 commitMsg 的 message（用于提交代码弹窗预填） */
export function latestCommitMessage(
  events: readonly ArtifactEvent[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "commitMsg" && e.message?.trim()) {
      return e.message.trim();
    }
  }
  return undefined;
}

/** 过滤掉 commitMsg 类型，仅保留产物事件（用于时间线展示） */
export function filterArtifactEvents(
  events: readonly ArtifactEvent[],
): ArtifactEvent[] {
  return events.filter((e) => e.type !== "commitMsg");
}

/**
 * 从事件列表中过滤出「未被 dismiss」的事件（用于 ArtifactCard 展示）。
 * 第一版不做 dismiss，但排除 commitMsg 类型。
 */
export function filterVisibleEvents(
  events: readonly ArtifactEvent[],
): ArtifactEvent[] {
  return filterArtifactEvents(events);
}

/**
 * 根据事件定位对应阶段。
 * 优先匹配 stageId；若 agent 写入的 stageId 与前端配置不一致，则回退到 agent 名匹配。
 */
export function resolveEventStage(
  event: ArtifactEvent,
  stages: readonly StageConfig[],
): StageConfig | undefined {
  return (
    stages.find((s) => s.id === event.stageId) ??
    stages.find((s) => s.agent === event.agent)
  );
}

/**
 * 按 causedByMessageId 或 createdAt 将事件插入到消息列表的正确位置。
 * 返回 (messageId, events[]) 的映射，未匹配到 messageId 的事件归入 null key。
 */
export function groupEventsByMessage(
  events: readonly ArtifactEvent[],
  messageIds: readonly string[],
): Map<string | null, ArtifactEvent[]> {
  const idSet = new Set(messageIds);
  const result = new Map<string | null, ArtifactEvent[]>();
  for (const event of events) {
    const key =
      event.causedByMessageId && idSet.has(event.causedByMessageId)
        ? event.causedByMessageId
        : null;
    const list = result.get(key) ?? [];
    list.push(event);
    result.set(key, list);
  }
  return result;
}

export type MessageLike = {
  id: string;
  role?: "user" | "assistant";
  time: { created: number; completed?: number };
  agent?: string;
  parentID?: string;
};

/**
 * [DYNAMIC-HARNESS] 把 artifact events 分配到对应用户消息之后。
 *
 * 分配规则（与文档 §7 一致，并针对 agent 不写 causedByMessageId / createdAt 错误做了回退）：
 * 1. 优先按 causedByMessageId 匹配用户消息
 * 2. causedByMessageId 指向 assistant 消息时，取其 parentID（用户消息）
 * 3. causedByMessageId 不存在/不匹配时，按 event.agent 匹配最近同 agent 的 assistant 消息，取其 parentID
 * 4. 仍无法定位时，按 createdAt 找到最近的前一条用户消息
 * 5. 最后无法定位的事件归入 null key（文档要求插入到最新一轮对话之后）
 */
export function assignArtifactEventsToMessages<T extends MessageLike>(
  events: readonly ArtifactEvent[],
  messages: readonly T[] | undefined | null,
): Map<string | null, ArtifactEvent[]> {
  const safeMessages = messages ?? [];
  const userMessages = safeMessages.filter(
    (m) => !m.role || m.role === "user",
  );
  const assistantMessages = safeMessages.filter(
    (m): m is T & { role: "assistant"; parentID: string } =>
      m.role === "assistant" && !!m.parentID,
  );
  const userMessageIds = new Set(userMessages.map((m) => m.id));
  const allMessageIds = new Set(safeMessages.map((m) => m.id));
  const byMessage = new Map<string | null, ArtifactEvent[]>();
  const trailing: ArtifactEvent[] = [];
  const timezoneOffsets = [0, 8 * 60 * 60 * 1000, -8 * 60 * 60 * 1000];
  const reasonableTimeWindow = 15 * 60 * 1000;

  // 先按 createdAt 排序，保证按时间顺序分配
  const sorted = [...events].sort(compareEventTime);

  const ordinalFallback = new Map<ArtifactEvent, T & { role: "assistant"; parentID: string }>();
  const agents = new Set(sorted.filter((event) => !event.causedByMessageId).map((event) => event.agent));
  for (const agent of agents) {
    const agentEvents = sorted.filter(
      (event) => !event.causedByMessageId && event.agent === agent,
    );
    const agentAssistants = assistantMessages
      .filter((message) => message.agent === agent)
      .sort((a, b) => a.time.created - b.time.created);
    let assistantIndex = agentAssistants.length - 1;
    for (let eventIndex = agentEvents.length - 1; eventIndex >= 0 && assistantIndex >= 0; eventIndex -= 1) {
      ordinalFallback.set(agentEvents[eventIndex], agentAssistants[assistantIndex]);
      assistantIndex -= 1;
    }
  }

  const append = (messageId: string, event: ArtifactEvent) => {
    const list = byMessage.get(messageId) ?? [];
    list.push(event);
    byMessage.set(messageId, list);
  };

  for (const event of sorted) {
    // 1. 优先 causedByMessageId 匹配用户消息
    if (
      event.causedByMessageId &&
      userMessageIds.has(event.causedByMessageId)
    ) {
      append(event.causedByMessageId, event);
      continue;
    }

    // 2. causedByMessageId 指向 assistant 消息时，取 parentID
    if (event.causedByMessageId && allMessageIds.has(event.causedByMessageId)) {
      const assistant = assistantMessages.find(
        (m) => m.id === event.causedByMessageId,
      );
      if (assistant && userMessageIds.has(assistant.parentID)) {
        append(assistant.parentID, event);
        continue;
      }
    }

    // 3. 按 event.agent 匹配最近的同 agent assistant 消息，取 parentID
    // 这能修复 causedByMessageId 为空且 createdAt 错误时的定位问题
    if (assistantMessages.length > 0 && event.agent) {
      const eventTime = Date.parse(event.createdAt);
      let bestAssistant:
        | (T & { role: "assistant"; parentID: string })
        | undefined;
      let bestDelta = Infinity;
      for (const am of assistantMessages) {
        if (am.agent !== event.agent) continue;
        const t = am.time.completed ?? am.time.created;
        for (const offset of timezoneOffsets) {
          const delta = Number.isNaN(eventTime)
            ? Infinity
            : Math.abs(t - (eventTime + offset));
          if (delta < bestDelta) {
            bestDelta = delta;
            bestAssistant = am;
          }
        }
      }
      if (
        bestAssistant &&
        bestDelta <= reasonableTimeWindow &&
        userMessageIds.has(bestAssistant.parentID)
      ) {
        append(bestAssistant.parentID, event);
        continue;
      }

      const ordinalAssistant = ordinalFallback.get(event);
      if (ordinalAssistant && userMessageIds.has(ordinalAssistant.parentID)) {
        append(ordinalAssistant.parentID, event);
        continue;
      }
    }

    // 4. 按 createdAt 找最近的前一条用户消息
    const eventTime = Date.parse(event.createdAt);
    if (!Number.isNaN(eventTime) && userMessages.length > 0) {
      let targetId: string | null = null;
      let bestDelta = Infinity;
      for (const msg of userMessages) {
        for (const offset of timezoneOffsets) {
          const candidateEventTime = eventTime + offset;
          if (msg.time.created > candidateEventTime) continue;
          const delta = candidateEventTime - msg.time.created;
          if (delta < bestDelta) {
            bestDelta = delta;
            targetId = msg.id;
          }
        }
      }
      if (targetId && bestDelta <= reasonableTimeWindow) {
        append(targetId, event);
        continue;
      }
    }

    // 5. 无法定位，归入 trailing
    trailing.push(event);
  }

  // trailing 放入 null key
  if (trailing.length > 0) {
    byMessage.set(null, trailing);
  }

  return byMessage;
}
