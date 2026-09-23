const SAAS_URL = process.env.NEXT_PUBLIC_OPENCODE_SAAS_URL ?? "http://localhost:14096";
const MODEL = process.env.NEXT_PUBLIC_OPENCODE_MODEL ?? '{"providerID":"zhipuai","modelID":"glm-5.1"}';
const DIRECTORY = process.env.NEXT_PUBLIC_OPENCODE_DIRECTORY ?? "/workspace";

export type Phase = "idle" | "thinking" | "rendering";

export type TraceItem = {
  id: string;
  kind: "tool" | "note" | "stats";
  title: string;
  status?: string;
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
  };
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content?: string;
  reasoning?: string;
  traces?: TraceItem[];
  code?: string | null;
  status?: "generating" | "done";
  recovering?: boolean;
  error?: string;
};

export type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
};

export type SendMessageCallbacks = {
  onReasoning: (delta: string) => void;
  onTrace: (item: TraceItem) => void;
  onRenderStart: () => void;
  onRenderDelta: (delta: string) => void;
  onIdle: () => void;
  onTitle?: (title: string) => void;
};

export type ResumeCallbacks = {
  onReasoning: (delta: string) => void;
  onTrace: (item: TraceItem) => void;
  onRenderStart: () => void;
  onRenderDelta: (delta: string) => void;
  onDone: (messages: ChatMessage[]) => void;
  onTitle?: (title: string) => void;
};

export type OpenCodeService = {
  listThreads(): Promise<ChatThread[]>;
  createThread(): Promise<ChatThread>;
  getMessages(threadId: string): Promise<ChatMessage[]>;
  deleteThread(threadId: string): Promise<void>;
  sendMessage(threadId: string, text: string, callbacks: SendMessageCallbacks, signal: AbortSignal): Promise<void>;
  resumeSession(threadId: string, streamingStarted: boolean, callbacks: ResumeCallbacks, signal: AbortSignal): Promise<void>;
  abortSession(threadId: string): Promise<void>;
};

type SaasSession = {
  id: string;
  title: string;
  directory: string;
};

type SaasMessage = {
  info?: {
    id?: string;
    role?: string;
    time?: { completed?: number };
    error?: { data?: { message?: string }; message?: string; name?: string };
  };
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

export function normalizeOpenUiCode(code: string) {
  const normalized = code.split("\n").map((line) => {
    const heading = /^(\s*\w+\s*=\s*Heading\(.+,\s*"h[1-4])\)\s*$/.exec(line);
    if (heading) return `${heading[1]}")`;
    if (/^\s*\w*Rows\s*=/.test(line) && /\)\]\s*$/.test(line)) return line.replace(/\)\]\s*$/, "]]" );
    const stackGap = /^(\s*\w+\s*=\s*Stack\(.+),\s*"(none|xs|s|m|l|xl|2xl)"\s*\)\s*$/.exec(line);
    if (stackGap) return `${stackGap[1]}, "column", "${stackGap[2]}")`;
    const cardGap = /^(\s*\w+\s*=\s*Card\(.+),\s*"(none|xs|s|m|l|xl|2xl)"\s*\)\s*$/.exec(line);
    if (cardGap) return `${cardGap[1]}, "card", "column", "${cardGap[2]}")`;
    return line;
  }).join("\n");
  const root = /(^|\n)(root\s*=\s*Card\(\[)([^\]]*)(\])/.exec(normalized);
  if (!root) return normalized;

  const components = new Set([
    "Accordion", "Alert", "AlertDialogBlock", "AreaChart", "Avatar", "BarChart", "Blockquote", "Buttons",
    "CalendarBlock", "CardHeader", "Carousel", "CodeBlock", "DialogBlock", "DrawerBlock", "Form", "Heading",
    "Image", "ImageBlock", "InlineCode", "LineChart", "MarkDownRenderer", "PaginationBlock", "PieChart",
    "Progress", "RadarChart", "RadialChart", "ScatterChart", "Separator", "Table", "Tabs", "TagBlock", "TextContent",
  ]);
  const definitions = [...normalized.matchAll(/(^|\n)(\w+)\s*=\s*(\w+)\(/g)].map((match) => ({
    name: match[2],
    component: match[3],
    index: match.index ?? 0,
  }));
  const rootChildren = [...root[3].matchAll(/\b\w+\b/g)].map((match) => match[0]);
  const orphans = definitions.filter((definition) => {
    if (!components.has(definition.component) || rootChildren.includes(definition.name)) return false;
    return (normalized.match(new RegExp(`\\b${definition.name}\\b`, "g")) ?? []).length === 1;
  });
  if (orphans.length === 0) return normalized;

  const repairedChildren = rootChildren.flatMap((name, index) => {
    const definition = definitions.find((item) => item.name === name);
    const nextDefinition = definitions.find((item) => item.name === rootChildren[index + 1]);
    const additions = orphans
      .filter((item) => item.index > (definition?.index ?? -1) && item.index < (nextDefinition?.index ?? Infinity))
      .map((item) => item.name);
    return [name, ...additions];
  });
  const missingAtEnd = orphans
    .filter((item) => !repairedChildren.includes(item.name))
    .map((item) => item.name);
  return normalized.replace(root[0], `${root[1]}${root[2]}${[...repairedChildren, ...missingAtEnd].join(", ")}${root[4]}`);
}

function traceItemFromPart(part: NonNullable<SaasMessage["parts"]>[number]): TraceItem | null {
  if (part.type === "retry") {
    return { id: part.id ?? `retry-${part.attempt}`, kind: "note", title: `重试第 ${part.attempt ?? "?"} 次`, error: part.error?.message ?? "模型请求失败" };
  }
  if (part.type === "tool") {
    return {
      id: part.id ?? `tool-${part.tool}`,
      kind: "tool",
      title: part.state?.title || part.tool || "unknown",
      status: part.state?.status ?? "pending",
      input: part.state?.input,
      output: part.state?.output,
      error: part.state?.error,
    };
  }
  if (part.type === "subtask") {
    return { id: part.id ?? "subtask", kind: "note", title: `子任务：${part.description ?? part.agent ?? "未命名"}`, output: part.command };
  }
  if (part.type === "agent") return { id: part.id ?? "agent", kind: "note", title: `切换 Agent：${part.name ?? part.agent ?? "unknown"}` };
  if (part.type === "patch") return { id: part.id ?? "patch", kind: "note", title: `修改 ${part.files?.length ?? 0} 个文件`, output: part.files?.join("\n") };
  if (part.type === "file") return { id: part.id ?? "file", kind: "note", title: `附件：${part.filename ?? "未命名文件"}`, output: part.url };
  if (part.type === "compaction") return { id: part.id ?? "compaction", kind: "note", title: `上下文压缩${part.auto ? "（自动）" : ""}` };
  if (part.type === "step-finish") {
    const tokens = part.tokens;
    return {
      id: part.id ?? "stats",
      kind: "stats",
      title: "tokens",
      tokens: {
        input: tokens?.input ?? 0,
        output: tokens?.output ?? 0,
        reasoning: tokens?.reasoning ?? 0,
        cacheRead: tokens?.cache?.read ?? 0,
      },
    };
  }
  return null;
}

export function aggregateStats(traces: TraceItem[]) {
  const stats = traces.filter((t) => t.kind === "stats");
  const tokens = stats.reduce((sum, item) => ({
    input: sum.input + (item.tokens?.input ?? 0),
    output: sum.output + (item.tokens?.output ?? 0),
    reasoning: sum.reasoning + (item.tokens?.reasoning ?? 0),
    cacheRead: sum.cacheRead + (item.tokens?.cacheRead ?? 0),
  }), { input: 0, output: 0, reasoning: 0, cacheRead: 0 });
  return { tokens, steps: stats.length };
}

function messageFromSaas(sessionMessage: SaasMessage): ChatMessage {
  const role = sessionMessage.info?.role;
  const id = sessionMessage.info?.id ?? crypto.randomUUID();
  if (role === "user") {
    const text = (sessionMessage.parts ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n");
    return { id, role: "user", content: text };
  }
  const parts = sessionMessage.parts ?? [];
  const textIndexes = parts.flatMap((part, index) => part.type === "text" && part.text?.trim() ? [index] : []);
  const textIndex = textIndexes.find((index) => /(^|\n)root\s*=/.test(parts[index]?.text ?? "")) ?? textIndexes.at(-1) ?? -1;

  const beforeParts = textIndex === -1 ? parts : parts.slice(0, textIndex);
  const reasoning = beforeParts.filter((p) => p.type === "reasoning").map((p) => p.text ?? "").filter(Boolean).join("\n\n");
  const traces = beforeParts.map(traceItemFromPart).filter((t): t is TraceItem => t !== null);
  const code = textIndex === -1 ? null : (parts[textIndex]?.text ?? null);
  const afterTraces = textIndex === -1
    ? []
    : parts.slice(textIndex + 1).map(traceItemFromPart).filter((t): t is TraceItem => t !== null);

  return {
    id,
    role: "assistant",
    reasoning,
    traces: [...traces, ...afterTraces],
    code,
    status: sessionMessage.info?.time?.completed || sessionMessage.info?.error ? "done" : "generating",
    recovering: false,
    error: sessionMessage.info?.error?.data?.message ?? sessionMessage.info?.error?.message ?? sessionMessage.info?.error?.name,
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

async function fetchSaasMessages(saasSessionId: string): Promise<SaasMessage[]> {
  return fetch(`${SAAS_URL}/session/${saasSessionId}/message`)
    .then((response) => response.json())
    .then((data: unknown) => (Array.isArray(data) ? (data as SaasMessage[]) : []))
    .catch((): SaasMessage[] => []);
}

async function fetchLatestRoot(saasSessionId: string): Promise<string | undefined> {
  let finalText: string | undefined;
  for (let attempt = 0; attempt < 20 && !finalText; attempt++) {
    const messages = await fetchSaasMessages(saasSessionId);
    const latestAssistant = messages.findLast((message) => message.info?.role === "assistant");
    finalText = [...(latestAssistant?.parts ?? [])]
      .reverse()
      .find((part) => part.type === "text" && /(^|\n)root\s*=/.test(part.text ?? ""))
      ?.text;
    if (!finalText && attempt < 19) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return finalText;
}

type StreamCallbacks = {
  onReasoning: (delta: string) => void;
  onTraceItem: (item: TraceItem) => void;
  onRenderStart: () => void;
  onRenderDelta: (delta: string) => void;
  onIdle: () => Promise<void> | void;
  onError: (error: Error) => void;
  onTitle?: (title: string) => void;
};

type StreamOptions = {
  prefillPartTypes?: Map<string, string>;
  streamingStarted?: boolean;
  dropTextWithoutRoot?: boolean;
  routeDeltaByPhase?: boolean;
  fillMissingRoot?: boolean;
  idleFallback?: boolean;
  onConnected?: () => void;
  onTitle?: (title: string) => void;
  injectPartTypes?: (inject: (partID: string, type: string) => void) => void;
};

function subscribeSessionEvents(
  saasSessionId: string,
  directory: string,
  callbacks: StreamCallbacks,
  signal: AbortSignal,
  opts: StreamOptions = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const eventSource = new EventSource(
      `${SAAS_URL}/event?directory=${encodeURIComponent(directory)}&sessionID=${encodeURIComponent(saasSessionId)}`,
    );
    let messageSent = false;
    let finished = false;
    let streamedTextPart = opts.streamingStarted ?? false;
    let textPartActive = opts.streamingStarted ?? false;
    let textBuffer = "";
    const partTypes = new Map(opts.prefillPartTypes ?? []);
    const pendingDeltas = new Map<string, string[]>();
    const traceStates = new Map<string, string>();

    const onReasoning = (delta: string) => callbacks.onReasoning(delta);
    const onTraceItem = (item: TraceItem) => {
      const key = JSON.stringify(item);
      if (traceStates.get(item.id) !== key) {
        traceStates.set(item.id, key);
        callbacks.onTraceItem(item);
      }
    };
    const onOpenUi = (delta: string) => {
      if (streamedTextPart) {
        callbacks.onRenderDelta(delta);
        return;
      }
      textBuffer += delta;
      const root = /(^|\n)root\s*=/.exec(textBuffer);
      if (root) {
        const start = root.index + root[1].length;
        callbacks.onRenderStart();
        callbacks.onRenderDelta(textBuffer.slice(start));
        streamedTextPart = true;
        textBuffer = "";
        return;
      }
      if (opts.dropTextWithoutRoot && textBuffer.length > 512) {
        textBuffer = "";
      }
    };

    const injectPartType = (partID: string, type: string) => {
      partTypes.set(partID, type);
      pendingDeltas.get(partID)?.forEach(type === "reasoning" ? onReasoning : onOpenUi);
      pendingDeltas.delete(partID);
    };
    opts.injectPartTypes?.(injectPartType);

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = async () => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (opts.fillMissingRoot && !streamedTextPart) {
        const finalText = await fetchLatestRoot(saasSessionId);
        if (finalText) {
          if (!finalText.startsWith(textBuffer)) textBuffer = "";
          onOpenUi(finalText.startsWith(textBuffer) ? finalText.slice(textBuffer.length) : finalText);
        }
      }
      try {
        await callbacks.onIdle();
      } catch {}
      eventSource.close();
      resolve();
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      eventSource.close();
      callbacks.onError(error);
      reject(error);
    };

    idleTimer = opts.idleFallback
      ? setTimeout(() => {
          fetch(`${SAAS_URL}/session/status`)
            .then((response) => response.json() as Promise<Record<string, { type?: string }>>)
            .catch((): Record<string, { type?: string }> => ({}))
            .then((statuses) => {
              if (finished) return;
              const busy = statuses[saasSessionId]?.type != null && statuses[saasSessionId].type !== "idle";
              if (!busy) void finish();
            });
        }, 3000)
      : undefined;

    eventSource.onmessage = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch { return; }
      const payload = event.payload || event;

      if (payload.type === "server.connected") {
        if (messageSent) return;
        messageSent = true;
        opts.onConnected?.();
        return;
      }
      if (payload.type === "server.heartbeat") return;
      const eventSessionId = payload.properties?.sessionID ?? payload.properties?.part?.sessionID;
      if (eventSessionId && eventSessionId !== saasSessionId) return;
      if (payload.type === "session.updated" && payload.properties?.info?.title) {
        opts.onTitle?.(payload.properties.info.title);
        callbacks.onTitle?.(payload.properties.info.title);
        return;
      }
      if (payload.type === "permission.asked") {
        onTraceItem({
          id: payload.properties.id ?? "permission",
          kind: "note",
          title: `等待权限：${payload.properties.permission}`,
          output: payload.properties.patterns?.join("\n") || "*",
        });
        return;
      }
      if (payload.type === "permission.replied") {
        onTraceItem({
          id: payload.properties.requestID ?? "permission",
          kind: "note",
          title: `权限回复：${payload.properties.reply}`,
        });
        return;
      }
      if (payload.type === "session.error") {
        onTraceItem({
          id: `error-${Date.now()}`,
          kind: "note",
          title: "会话错误",
          error: payload.properties.error?.data?.message ?? payload.properties.error?.name ?? "未知错误",
        });
        return;
      }
      if (payload.type === "message.part.updated") {
        const part = payload.properties?.part;
        if (part?.id && part.type === "text") {
          if (!part.text) {
            textPartActive = true;
          } else if (/(^|\n)root\s*=/.test(part.text)) {
            textPartActive = true;
            if (!streamedTextPart) onOpenUi(part.text);
          }
        }
        if (part?.id && (part.type === "reasoning" || part.type === "text")) {
          partTypes.set(part.id, part.type);
          pendingDeltas.get(part.id)?.forEach(part.type === "reasoning" ? onReasoning : onOpenUi);
          pendingDeltas.delete(part.id);
        }
        if (part?.id && ["tool", "retry", "subtask", "agent", "patch", "file", "compaction", "step-finish"].includes(part.type)) {
          const item = traceItemFromPart(part);
          if (item) onTraceItem(item);
        }
        return;
      }
      if (payload.type === "message.part.delta" && payload.properties.field === "text") {
        const partType = partTypes.get(payload.properties.partID);
        if (partType === "reasoning") {
          onReasoning(payload.properties.delta);
          return;
        }
        if (partType === "text") {
          onOpenUi(payload.properties.delta);
          return;
        }
        if (opts.routeDeltaByPhase) {
          if (textPartActive) onOpenUi(payload.properties.delta);
          else onReasoning(payload.properties.delta);
          return;
        }
        pendingDeltas.set(payload.properties.partID, [
          ...(pendingDeltas.get(payload.properties.partID) ?? []),
          payload.properties.delta,
        ]);
        return;
      }
      if (payload.type === "session.status" && payload.properties?.status?.type === "idle") {
        void finish();
        return;
      }
      if (payload.type !== "session.idle") return;
      void finish();
    };

    eventSource.onerror = () => fail(new Error("SSE error"));
    signal.addEventListener("abort", () => fail(new Error("aborted")), { once: true });
  });
}

export function createOpenCodeService(systemPrompt: string): OpenCodeService {
  return {
    async listThreads() {
      const data = (await (await request(`/api/threads/get`)).json()) as { threads: ChatThread[] };
      return data.threads;
    },

    async createThread() {
      return (await (await request(`/api/threads/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })).json()) as ChatThread;
    },

    async getMessages(threadId: string) {
      const saasSessionId = await resolveSaasSession(threadId);
      const [messagesResponse, statuses] = await Promise.all([
        fetch(`${SAAS_URL}/session/${saasSessionId}/message`).then((response) => response.json()).catch(() => []),
        fetch(`${SAAS_URL}/session/status`)
          .then((response) => response.json() as Promise<Record<string, { type?: string }>>)
          .catch((): Record<string, { type?: string }> => ({})),
      ]);
      const messages = (Array.isArray(messagesResponse) ? messagesResponse : []) as SaasMessage[];
      const result = messagesFromSaas(messages);
      const statusBusy = statuses[saasSessionId]?.type != null && statuses[saasSessionId].type !== "idle";
      const activeAssistant = result.findLast((message) => message.role === "assistant" && message.status === "generating");
      if (!statusBusy && !activeAssistant) return result;
      if (activeAssistant) {
        return result.map((message) => message.id === activeAssistant.id ? { ...message, recovering: true } : message);
      }
      return [
        ...result,
        {
          id: `recovering-${saasSessionId}`,
          role: "assistant",
          reasoning: "",
          traces: [],
          code: null,
          status: "generating",
          recovering: true,
        },
      ];
    },

    async deleteThread(threadId: string) {
      await request(`/api/threads/delete/${threadId}`, { method: "DELETE" });
    },

    async abortSession(threadId: string) {
      const detail = (await (await request(`/api/threads/get/${threadId}`)).json()) as ThreadDetail;
      if (detail.saasSessionId) {
        await fetch(`${SAAS_URL}/session/${detail.saasSessionId}/abort`, { method: "POST" }).catch(() => {});
      }
    },

    async sendMessage(threadId, text, callbacks, signal) {
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
      const agentsMd = await agentsMdResponse.json() as { content?: string } | null;
      if (agentsMd?.content === systemPrompt) {
        await request(`${SAAS_URL}/session/${saasSessionId}/agents-md`, { method: "DELETE", signal });
      }

      await subscribeSessionEvents(
        saasSessionId,
        info.directory,
        {
          onReasoning: (delta) => callbacks.onReasoning(delta),
          onTraceItem: (item) => callbacks.onTrace(item),
          onRenderStart: () => callbacks.onRenderStart(),
          onRenderDelta: (delta) => callbacks.onRenderDelta(delta),
          onIdle: () => callbacks.onIdle(),
          onError: () => {},
          onTitle: (title) => callbacks.onTitle?.(title),
        },
        signal,
        {
          fillMissingRoot: true,
          onConnected: () => {
            fetch(`${SAAS_URL}/session/${saasSessionId}/prompt_async`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ parts: [{ type: "text", text }], model, agent: "openui" }),
            }).catch(() => {});
          },
          onTitle: (title) => {
            fetch(`/api/threads/update/${threadId}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title }),
            }).catch(() => {});
          },
        },
      );
    },

    async resumeSession(threadId, streamingStarted, callbacks, signal) {
      const saasSessionId = await resolveSaasSession(threadId);

      await subscribeSessionEvents(
        saasSessionId,
        DIRECTORY,
        {
          onReasoning: (delta) => callbacks.onReasoning(delta),
          onTraceItem: (item) => callbacks.onTrace(item),
          onRenderStart: () => callbacks.onRenderStart(),
          onRenderDelta: (delta) => callbacks.onRenderDelta(delta),
          onIdle: async () => {
            const final = await fetchSaasMessages(saasSessionId);
            callbacks.onDone(messagesFromSaas(final));
          },
          onError: () => {},
          onTitle: (title) => callbacks.onTitle?.(title),
        },
        signal,
        {
          streamingStarted,
          dropTextWithoutRoot: !streamingStarted,
          routeDeltaByPhase: true,
          idleFallback: true,
          injectPartTypes: (inject) => {
            fetchSaasMessages(saasSessionId).then((messages) => {
              messages.forEach((message) =>
                (message.parts ?? []).forEach((part) => {
                  if (part.id && (part.type === "reasoning" || part.type === "text")) inject(part.id, part.type);
                })
              );
            });
          },
        },
      );
    },
  };
}
