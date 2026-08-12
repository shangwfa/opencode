import { EventType, type ChatStorage, type Message, type StreamProtocolAdapter, type Thread } from "@openuidev/react-headless";

export const RENDER_BOUNDARY = "\n<!-- openui-render-boundary -->\n";
export const TRAILING_TRACE_BOUNDARY = "\n<!-- opencode-trailing-trace -->\n";
export const TRACE_PREFIX = "<!-- opencode-trace:";
export const TRACE_SUFFIX = " -->";
export const SESSION_PENDING_MARKER = "<!-- opencode-session-pending -->";

const SAAS_URL = process.env.NEXT_PUBLIC_OPENCODE_SAAS_URL ?? "http://localhost:14096";
const MODEL = process.env.NEXT_PUBLIC_OPENCODE_MODEL ?? '{"providerID":"zhipuai","modelID":"glm-5.1"}';

export type TraceItem = {
  id: string;
  kind: "tool" | "note" | "stats";
  title: string;
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
};

type SaasSession = {
  id: string;
  title: string;
  directory: string;
};

type SaasMessage = {
  info?: { id?: string; role?: string };
  parts?: Array<{
    id?: string;
    type?: string;
    text?: string;
    tool?: string;
    attempt?: number;
    error?: { message?: string };
    description?: string;
    agent?: string;
    name?: string;
    command?: string;
    files?: string[];
    filename?: string;
    url?: string;
    auto?: boolean;
    reason?: string;
    cost?: number;
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      title?: string;
      output?: string;
      error?: string;
    };
  }>;
};

type ThreadDetail = {
  id: string;
  title: string;
  createdAt: string;
  saasSessionId?: string;
};

type PermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "ask" | "deny";
};

type SaasAgent = {
  name?: string;
  permission?: PermissionRule[];
};

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`SaaS ${init?.method ?? "GET"} ${url} failed: ${response.status}`);
  return response;
}

function permissionConfig(rules: PermissionRule[] = []) {
  return rules.reduce<Record<string, string | Record<string, string>>>((result, rule) => {
    if (rule.pattern === "*") {
      result[rule.permission] = rule.action;
      return result;
    }
    const existing = result[rule.permission];
    result[rule.permission] = {
      ...(typeof existing === "object" ? existing : {}),
      [rule.pattern]: rule.action,
    };
    return result;
  }, {});
}

export function formatTrace(item: TraceItem) {
  return `${TRACE_PREFIX}${encodeURIComponent(JSON.stringify(item))}${TRACE_SUFFIX}`;
}

export function parseThinking(content: string) {
  const items: TraceItem[] = [];
  const reasoning = content.replace(/<!-- opencode-trace:(.*?) -->/g, (_, encoded) => {
    try {
      items.push(JSON.parse(decodeURIComponent(encoded)) as TraceItem);
    } catch {}
    return "";
  }).replace(/>\s*(?=\n|$)/g, "").replace(/\n{3,}/g, "\n\n").trim();
  const latest = new Map<string, TraceItem>();
  items.forEach((item) => latest.set(item.id, item));
  const values = [...latest.values()];
  const stats = values.filter((item) => item.kind === "stats");
  const total = stats.reduce((sum, item) => sum + (Number.parseInt(item.title) || 0), 0);
  return {
    reasoning,
    items: [
      ...values.filter((item) => item.kind !== "stats"),
      ...(stats.length > 0 ? [{ id: "stats", kind: "stats" as const, title: `${total} tokens`, output: `${stats.length} 个步骤` }] : []),
    ],
  };
}

export function normalizeOpenUiCode(code: string) {
  return code.split("\n").map((line) => {
    const stackGap = /^(\s*\w+\s*=\s*Stack\(.+),\s*"(none|xs|s|m|l|xl|2xl)"\s*\)\s*$/.exec(line);
    if (stackGap) return `${stackGap[1]}, "column", "${stackGap[2]}")`;
    const cardGap = /^(\s*\w+\s*=\s*Card\(.+),\s*"(none|xs|s|m|l|xl|2xl)"\s*\)\s*$/.exec(line);
    if (cardGap) return `${cardGap[1]}, "card", "column", "${cardGap[2]}")`;
    return line;
  }).join("\n");
}

function formatTracePart(part: NonNullable<SaasMessage["parts"]>[number]) {
  if (part.type === "reasoning" || part.type === "text") return part.text ?? "";
  if (part.type === "retry") {
    return formatTrace({ id: part.id ?? `retry-${part.attempt}`, kind: "note", title: `重试第 ${part.attempt ?? "?"} 次`, error: part.error?.message ?? "模型请求失败" });
  }
  if (part.type === "tool") {
    return formatTrace({
      id: part.id ?? `tool-${part.tool}`,
      kind: "tool",
      title: part.state?.title || part.tool || "unknown",
      status: part.state?.status ?? "pending",
      input: part.state?.input,
      output: part.state?.output,
      error: part.state?.error,
    });
  }
  if (part.type === "subtask") {
    return formatTrace({ id: part.id ?? "subtask", kind: "note", title: `子任务：${part.description ?? part.agent ?? "未命名"}`, output: part.command });
  }
  if (part.type === "agent") return formatTrace({ id: part.id ?? "agent", kind: "note", title: `切换 Agent：${part.name ?? part.agent ?? "unknown"}` });
  if (part.type === "patch") return formatTrace({ id: part.id ?? "patch", kind: "note", title: `修改 ${part.files?.length ?? 0} 个文件`, output: part.files?.join("\n") });
  if (part.type === "file") return formatTrace({ id: part.id ?? "file", kind: "note", title: `附件：${part.filename ?? "未命名文件"}`, output: part.url });
  if (part.type === "compaction") return formatTrace({ id: part.id ?? "compaction", kind: "note", title: `上下文压缩${part.auto ? "（自动）" : ""}` });
  if (part.type === "step-finish") {
    const tokens = part.tokens;
    return formatTrace({
      id: part.id ?? "stats",
      kind: "stats",
      title: `${tokens?.total ?? (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0)} tokens`,
      output: `cost ${part.cost ?? 0} · cache ${tokens?.cache?.read ?? 0}`,
    });
  }
  return "";
}

function messageFromSaas(sessionMessage: SaasMessage): Message {
  const role = sessionMessage.info?.role;
  if (role === "user") {
    const text = (sessionMessage.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return { id: sessionMessage.info?.id ?? crypto.randomUUID(), role, content: text };
  }
  const parts = sessionMessage.parts ?? [];
  const textIndexes = parts.flatMap((part, index) => part.type === "text" && part.text?.trim() ? [index] : []);
  const textIndex = textIndexes.find((index) => /(^|\n)root\s*=/.test(parts[index]?.text ?? "")) ?? textIndexes.at(-1) ?? -1;
  const reasoning = parts
    .slice(0, textIndex === -1 ? undefined : textIndex)
    .map(formatTracePart)
    .filter(Boolean)
    .join("\n\n");
  const text = textIndex === -1 ? "" : parts[textIndex]?.text ?? "";
  const trailingTrace = textIndex === -1 ? "" : parts
    .slice(textIndex + 1)
    .map(formatTracePart)
    .filter(Boolean)
    .join("\n\n");
  return {
    id: sessionMessage.info?.id ?? crypto.randomUUID(),
    role: "assistant",
    content: reasoning && text
      ? reasoning + RENDER_BOUNDARY + text + (trailingTrace ? TRAILING_TRACE_BOUNDARY + trailingTrace : "")
      : reasoning || text,
  };
}

function messagesFromSaas(messages: SaasMessage[]) {
  return messages.reduce<SaasMessage[]>((result, message) => {
    if (message.info?.role !== "assistant" || result.at(-1)?.info?.role !== "assistant") {
      result.push(message);
      return result;
    }
    const previous = result.at(-1)!;
    result[result.length - 1] = {
      info: message.info,
      parts: [...(previous.parts ?? []), ...(message.parts ?? [])],
    };
    return result;
  }, []).map(messageFromSaas);
}

async function resolveSaasSession(threadId: string): Promise<string> {
  const detail = (await (await request(`/api/threads/get/${threadId}`)).json()) as ThreadDetail;
  if (!detail.saasSessionId) throw new Error(`thread ${threadId} has no linked SaaS session`);
  return detail.saasSessionId;
}

const streamAdapter: StreamProtocolAdapter = {
  async *parse(response) {
    if (!response.body) throw new Error("OpenCode response body is missing");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const messageId = crypto.randomUUID();
    let buffer = "";
    let messageStarted = false;

    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as {
          type: string;
          properties?: { field?: string; delta?: string; renderStart?: boolean };
        };
        if (event.type === "message.part.delta" && event.properties?.field === "text" && event.properties.delta) {
          if (!messageStarted) {
            messageStarted = true;
            yield { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" };
          }
          if (event.properties.renderStart) {
            yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: RENDER_BOUNDARY };
          }
          yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: event.properties.delta };
          continue;
        }
        if (event.type === "session.idle" && messageStarted) {
          yield { type: EventType.TEXT_MESSAGE_END, messageId };
        }
      }

      if (chunk.done) break;
    }
    reader.releaseLock();
  },
};

export function createOpenCodeAdapter(systemPrompt: string) {
  const storage: ChatStorage = {
    thread: {
      async listThreads() {
        const data = (await (await request(`/api/threads/get`)).json()) as { threads: Thread[] };
        return { threads: data.threads, nextCursor: undefined };
      },
      async createThread() {
        return (await (await request(`/api/threads/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })).json()) as Thread;
      },
      async getMessages(threadId) {
        const saasSessionId = await resolveSaasSession(threadId);
        const [messages, statuses] = await Promise.all([
          request(`${SAAS_URL}/session/${saasSessionId}/message`).then((response) => response.json()) as Promise<SaasMessage[]>,
          request(`${SAAS_URL}/session/status`)
            .then((response) => response.json() as Promise<Record<string, { type?: string }>>)
            .catch((): Record<string, { type?: string }> => ({})),
        ]);
        const result = messagesFromSaas(messages);
        if (!statuses[saasSessionId] || statuses[saasSessionId].type === "idle") return result;
        const marked = result.map((message) => message.role === "assistant"
          ? { ...message, content: (message.content ?? "") + SESSION_PENDING_MARKER }
          : message
        );
        return marked.some((message) => message.role === "assistant")
          ? marked
          : [...marked, { id: `status-${saasSessionId}`, role: "assistant", content: SESSION_PENDING_MARKER }];
      },
      async updateThread(thread) {
        return (await (await request(`/api/threads/update/${thread.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: thread.title }),
        })).json()) as Thread;
      },
      async deleteThread(id) {
        await request(`/api/threads/delete/${id}`, { method: "DELETE" });
      },
    },
  };

  const llm = {
    async send({ threadId, messages, signal }: { threadId: string; messages: Message[]; signal: AbortSignal }) {
      const lastUserMessage = [...messages].reverse().find((message) => message.role === "user");
      if (!lastUserMessage) throw new Error("no user message");

      const model = JSON.parse(MODEL);
      const saasSessionId = await resolveSaasSession(threadId);
      const info = (await (await request(`${SAAS_URL}/session/${saasSessionId}`)).json()) as SaasSession;
      const agents = (await (await request(`${SAAS_URL}/agent`)).json()) as SaasAgent[];
      const sessionAgents = (await (await request(`${SAAS_URL}/session/${saasSessionId}/agents`)).json()) as SaasAgent[];
      if (!sessionAgents.some((agent) => agent.name === "openui")) {
        const buildPermission = agents.find((agent) => agent.name === "build")?.permission ?? [];
        await request(`${SAAS_URL}/session/${saasSessionId}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "openui",
            description: "OpenUI Lang generator",
            prompt: systemPrompt,
            mode: "primary",
            model,
            permission: permissionConfig(buildPermission),
          }),
          signal,
        });
      }
      const agentsMdResponse = await request(`${SAAS_URL}/session/${saasSessionId}/agents-md`);
      if ((await agentsMdResponse.json()) === null) {
        await request(`${SAAS_URL}/session/${saasSessionId}/agents-md/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: systemPrompt }),
          signal,
        });
      }

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          const eventSource = new EventSource(
            `${SAAS_URL}/event?directory=${encodeURIComponent(info.directory)}&sessionID=${encodeURIComponent(saasSessionId)}`,
          );
          let messageSent = false;
          let finished = false;
          let streamedTextPart = false;
          let streamedTrailingTrace = false;
          const partTypes = new Map<string, string>();
          const pendingDeltas = new Map<string, string[]>();
          const traceStates = new Map<string, string>();

          const enqueue = (event: object) => {
            controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
          };
          const enqueueDelta = (partType: string, delta: string) => {
            const renderStart = partType === "text" && !streamedTextPart;
            enqueue({
              type: "message.part.delta",
              properties: { field: "text", delta, renderStart },
            });
            if (partType === "text") streamedTextPart = true;
          };
          const enqueueTrace = (trace: string) => {
            if (!streamedTextPart) {
              enqueueDelta("reasoning", `\n\n${trace}`);
              return;
            }
            enqueueDelta("reasoning", `${streamedTrailingTrace ? "\n\n" : TRAILING_TRACE_BOUNDARY}${trace}`);
            streamedTrailingTrace = true;
          };
          const fail = (error: Error) => {
            if (finished) return;
            finished = true;
            eventSource.close();
            controller.error(error);
          };

          eventSource.onmessage = (message) => {
            let event;
            try {
              event = JSON.parse(message.data);
            } catch {
              return;
            }
            const payload = event.payload || event;

            if (payload.type === "server.connected") {
              if (messageSent) return;
              messageSent = true;
              fetch(`${SAAS_URL}/session/${saasSessionId}/prompt_async`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  parts: [{ type: "text", text: lastUserMessage.content }],
                  model,
                  agent: "openui",
                  system: systemPrompt,
                }),
              }).then((response) => {
                if (!response.ok) fail(new Error("prompt_async failed: " + response.status));
              }).catch((error) => fail(error));
              return;
            }

            if (payload.type === "server.heartbeat") return;
            const eventSessionId = payload.properties?.sessionID ?? payload.properties?.part?.sessionID;
            if (eventSessionId && eventSessionId !== saasSessionId) return;
            if (payload.type === "session.updated" && payload.properties?.info?.title) {
              fetch(`/api/threads/update/${threadId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: payload.properties.info.title }),
              }).catch(() => {});
              return;
            }
            if (payload.type === "permission.asked") {
              enqueueTrace(formatTrace({
                id: payload.properties.id ?? "permission",
                kind: "note",
                title: `等待权限：${payload.properties.permission}`,
                output: payload.properties.patterns?.join("\n") || "*",
              }));
              return;
            }
            if (payload.type === "permission.replied") {
              enqueueTrace(formatTrace({
                id: payload.properties.requestID ?? "permission",
                kind: "note",
                title: `权限回复：${payload.properties.reply}`,
              }));
              return;
            }
            if (payload.type === "session.error") {
              enqueueTrace(formatTrace({
                id: `error-${Date.now()}`,
                kind: "note",
                title: "会话错误",
                error: payload.properties.error?.data?.message ?? payload.properties.error?.name ?? "未知错误",
              }));
              return;
            }
            if (payload.type === "message.part.updated") {
              const part = payload.properties?.part;
              if (part?.id && (part.type === "reasoning" || part.type === "text")) {
                partTypes.set(part.id, part.type);
                pendingDeltas.get(part.id)?.forEach((delta) => enqueueDelta(part.type, delta));
                pendingDeltas.delete(part.id);
              }
              if (part?.id && ["tool", "retry", "subtask", "agent", "patch", "file", "compaction", "step-finish"].includes(part.type)) {
                const trace = formatTracePart(part);
                if (trace && traceStates.get(part.id) !== trace) {
                  traceStates.set(part.id, trace);
                  enqueueTrace(trace);
                }
              }
              return;
            }
            if (payload.type === "message.part.delta" && payload.properties.field === "text") {
              const partType = partTypes.get(payload.properties.partID);
              if (partType === "reasoning" || partType === "text") {
                enqueueDelta(partType, payload.properties.delta);
                return;
              }
              pendingDeltas.set(payload.properties.partID, [
                ...(pendingDeltas.get(payload.properties.partID) ?? []),
                payload.properties.delta,
              ]);
              return;
            }

            if (payload.type !== "session.idle" || finished) return;
            finished = true;
            enqueue({ type: "session.idle" });
            eventSource.close();
            controller.close();
          };

          eventSource.onerror = () => fail(new Error("SSE error"));
          signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
        },
      });

      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
    },
    streamProtocol: streamAdapter,
  };

  return { storage, llm };
}
