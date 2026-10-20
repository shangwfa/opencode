import type { Event } from "@/types/opencode";

export type RawGlobalEventDebugEntry = {
  id: string;
  at: number;
  directory: string;
  sessionID?: string;
  payload: Event;
};

export type EventSessionMeta = {
  sessionID?: string;
  messageID?: string;
  partID?: string;
};

type AnyRecord = Record<string, any>;

export const MAX_GLOBAL_EVENT_DEBUG_ENTRIES = 2000;

export function extractGlobalEventSessionMeta(
  payload: { type: string; properties?: unknown },
): EventSessionMeta {
  const properties = payload.properties as AnyRecord | undefined;
  if (!properties || typeof properties !== "object") return {};

  switch (payload.type) {
    case "message.updated":
      return {
        sessionID: properties.sessionID ?? properties.info?.sessionID,
        messageID: properties.info?.id,
      };
    case "message.part.updated":
      return {
        sessionID: properties.sessionID ?? properties.part?.sessionID,
        messageID: properties.part?.messageID,
        partID: properties.part?.id,
      };
    case "message.part.delta":
      return {
        sessionID: properties.sessionID,
        messageID: properties.messageID,
        partID: properties.partID,
      };
    case "message.removed":
    case "message.part.removed":
      return {
        sessionID: properties.sessionID,
        messageID: properties.messageID,
        partID: properties.partID,
      };
    case "session.status":
    case "session.error":
    case "session.diff":
    case "session.idle":
    case "session.compacted":
    case "todo.updated":
      return { sessionID: properties.sessionID };
    case "session.created":
    case "session.updated":
    case "session.deleted":
      return { sessionID: properties.info?.id };
    case "permission.asked":
    case "permission.updated":
      return {
        sessionID: properties.sessionID,
        messageID: properties.messageID,
      };
    case "permission.replied":
      return { sessionID: properties.sessionID };
    case "question.asked":
      return { sessionID: properties.sessionID };
    case "question.replied":
    case "question.rejected":
      return { sessionID: properties.sessionID };
    default:
      return {};
  }
}

export function isGlobalEventForSession(
  entry: Pick<RawGlobalEventDebugEntry, "payload" | "sessionID">,
  sessionID: string | undefined,
) {
  if (!sessionID) return false;
  const meta = extractGlobalEventSessionMeta(entry.payload);
  return (meta.sessionID ?? entry.sessionID) === sessionID;
}

export function appendGlobalEventDebugEntry(
  entries: readonly RawGlobalEventDebugEntry[],
  entry: RawGlobalEventDebugEntry,
  limit = MAX_GLOBAL_EVENT_DEBUG_ENTRIES,
) {
  const next = [...entries, entry];
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}
