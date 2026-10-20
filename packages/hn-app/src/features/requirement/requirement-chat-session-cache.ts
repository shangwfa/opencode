type RequirementChatSession = {
  repo: string;
  reqId: string;
};

const STORAGE_KEY = "requirement-chat-session-map";

function readMap(): Record<string, RequirementChatSession> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, RequirementChatSession>) : {};
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(map: Record<string, RequirementChatSession>) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage errors (e.g. private mode)
  }
}

export function saveRequirementChatSession(
  sessionId: string,
  repo: string,
  reqId: string,
) {
  const id = sessionId.trim();
  const r = repo.trim();
  const q = reqId.trim();
  if (!id || !r || !q) return;

  const map = readMap();
  map[id] = { repo: r, reqId: q };
  writeMap(map);
}

export function getRequirementChatSession(
  sessionId: string,
): RequirementChatSession | undefined {
  const id = sessionId.trim();
  if (!id) return undefined;
  return readMap()[id];
}
