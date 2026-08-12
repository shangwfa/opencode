const SAAS_URL = process.env.NEXT_PUBLIC_OPENCODE_SAAS_URL ?? "http://localhost:14096";
const MODEL = process.env.NEXT_PUBLIC_OPENCODE_MODEL ?? '{"providerID":"zhipuai","modelID":"glm-5.1"}';

function agUIAdapter() {
  return {
    async *parse(response: Response) {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (!data) continue;
          try {
            yield JSON.parse(data);
          } catch {}
        }
      }
    },
  };
}

export function createOpenCodeLLM(systemPrompt: string) {
  return {
    async send({ messages, signal }: { threadId: string; messages: any[]; signal: AbortSignal }) {
      const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMessage) throw new Error("no user message");

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder();
          const messageId = crypto.randomUUID();
          let started = false;
          let preamble = true;
          let buf = "";

          const send = (type: string, data: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...data })}\n\n`));
          };

          const ensureStarted = () => {
            if (!started) {
              started = true;
              send("TEXT_MESSAGE_START", { messageId, role: "assistant" });
            }
          };

          try {
            const modelPayload = JSON.parse(MODEL);

            const sessionRes = await fetch(`${SAAS_URL}/session`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
              signal,
            });
            if (!sessionRes.ok) throw new Error(`createSession: ${sessionRes.status}`);
            const session = await sessionRes.json();

            await fetch(`${SAAS_URL}/session/${session.id}/agents/create`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: "openui",
                description: "OpenUI Lang code generator",
                prompt: "You are a UI code generator that outputs openui-lang.",
                mode: "primary",
                model: modelPayload,
                tools: {},
              }),
              signal,
            }).catch(() => {});

            const infoRes = await fetch(`${SAAS_URL}/session/${session.id}`, { signal });
            const info = await infoRes.json();

            const sseRes = await fetch(`${SAAS_URL}/event`, {
              headers: { "x-opencode-directory": info.directory },
              signal,
            });
            if (!sseRes.ok || !sseRes.body) throw new Error("SSE connection failed");

            const reader = sseRes.body.getReader();
            const decoder = new TextDecoder();
            let sseBuf = "";
            let connected = false;
            let messageSent = false;

            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              sseBuf += decoder.decode(value, { stream: true });
              const blocks = sseBuf.split("\n\n");
              sseBuf = blocks.pop() ?? "";

              for (const block of blocks) {
                const line = block.split("\n").find((l) => l.startsWith("data: "));
                if (!line) continue;
                let raw;
                try {
                  raw = JSON.parse(line.slice(6));
                } catch {
                  continue;
                }
                const event = raw.payload || raw;

                if (!connected && event.type === "server.connected") {
                  connected = true;
                  if (!messageSent) {
                    messageSent = true;
                    fetch(`${SAAS_URL}/session/${session.id}/prompt_async`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        parts: [{ type: "text", text: lastUserMessage.content }],
                        model: modelPayload,
                        agent: "openui",
                        system: systemPrompt,
                      }),
                      signal,
                    }).then((r) => console.log("[opencode] prompt_async status:", r.status))
                      .catch((err) => console.error("[opencode] prompt_async error:", err));
                  }
                  continue;
                }

                if (event.type === "server.heartbeat") continue;

                if (event.type === "message.part.delta") {
                  if (event.properties.field === "text" && event.properties.delta) {
                    const text: string = event.properties.delta;

                    if (preamble) {
                      buf += text;
                      const idx = buf.indexOf("root =");
                      if (idx !== -1) {
                        preamble = false;
                        const rest = buf.slice(idx);
                        ensureStarted();
                        if (rest) send("TEXT_MESSAGE_CONTENT", { messageId, delta: rest });
                        buf = "";
                      }
                    } else {
                      ensureStarted();
                      send("TEXT_MESSAGE_CONTENT", { messageId, delta: text });
                    }
                  }
                  continue;
                }

                if (event.type === "session.idle") {
                  if (preamble && buf) {
                    const idx = buf.indexOf("root =");
                    if (idx !== -1) {
                      const rest = buf.slice(idx);
                      ensureStarted();
                      send("TEXT_MESSAGE_CONTENT", { messageId, delta: rest });
                    } else {
                      const escaped = buf.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
                      ensureStarted();
                      send("TEXT_MESSAGE_CONTENT", {
                        messageId,
                        delta: `root = Stack([TextContent("${escaped}")])`,
                      });
                    }
                  }
                  if (started) send("TEXT_MESSAGE_END", { messageId });
                  else {
                    ensureStarted();
                    send("TEXT_MESSAGE_CONTENT", {
                      messageId,
                      delta: `root = Stack([TextContent("(empty response)")])`,
                    });
                    send("TEXT_MESSAGE_END", { messageId });
                  }
                  reader.cancel();
                  break;
                }
              }
            }

            fetch(`${SAAS_URL}/session/${session.id}`, { method: "DELETE" }).catch(() => {});
          } catch (err) {
            console.error("[opencode] stream error:", err);
            const msg = err instanceof Error ? err.message : String(err);
            const escaped = msg.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
            ensureStarted();
            send("TEXT_MESSAGE_CONTENT", {
              messageId,
              delta: `root = Stack([TextContent("Error: ${escaped}")])`,
            });
            send("TEXT_MESSAGE_END", { messageId });
          } finally {
            controller.close();
          }
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        },
      });
    },
    streamProtocol: agUIAdapter(),
  };
}