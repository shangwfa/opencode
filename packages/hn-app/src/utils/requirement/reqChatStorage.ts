export function queryParam(raw: string | string[] | undefined) {
  if (Array.isArray(raw)) return raw[0]?.trim() ?? "";
  return (raw ?? "").trim();
}

const stageKey = (sessionId: string) => `req-chat-stage:${sessionId.trim()}`;
const reqIdKey = (sessionId: string) => `req-chat-reqid:${sessionId.trim()}`;

export function storeReqChatWorkingIndex(sessionId: string, index: number) {
  if (!Number.isInteger(index) || index < 0) return;
  sessionStorage.setItem(
    stageKey(sessionId),
    JSON.stringify({ workingIndex: index }),
  );
}

export function readReqChatWorkingIndex(sessionId: string) {
  const raw = sessionStorage.getItem(stageKey(sessionId));
  if (!raw) return undefined;
  try {
    const body = JSON.parse(raw) as { workingIndex?: number };
    const n = body.workingIndex;
    if (typeof n === "number" && Number.isInteger(n) && n >= 0) return n;
  } catch {}
  return undefined;
}

export function clearReqChatStageStorage(sessionId: string) {
  sessionStorage.removeItem(stageKey(sessionId.trim()));
}

export function storeReqChatReqId(sessionId: string, reqId: string) {
  const rid = reqId.trim();
  if (rid) sessionStorage.setItem(reqIdKey(sessionId.trim()), rid);
}

export function readReqChatReqId(sessionId: string) {
  return sessionStorage.getItem(reqIdKey(sessionId.trim()))?.trim() ?? "";
}
