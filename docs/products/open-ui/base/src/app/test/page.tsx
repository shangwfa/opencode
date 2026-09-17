"use client";

import { useState, useCallback } from "react";

const SAAS_URL = process.env.NEXT_PUBLIC_OPENCODE_SAAS_URL ?? "http://localhost:14096";
const MODEL = process.env.NEXT_PUBLIC_OPENCODE_MODEL ?? '{"providerID":"zhipuai","modelID":"glm-5.1"}';

// 最简 LLM：直接调 SaaS，返回 Response
async function callSaaS(userText: string): Promise<string> {
  const modelPayload = JSON.parse(MODEL);

  // 1. 创建 session
  const sessionRes = await fetch(`${SAAS_URL}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!sessionRes.ok) throw new Error(`createSession: ${sessionRes.status}`);
  const session = await sessionRes.json();

  // 2. 创建 agent
  await fetch(`${SAAS_URL}/session/${session.id}/agents/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "openui",
      description: "code generator",
      prompt: "You are a UI code generator.",
      mode: "primary",
      model: modelPayload,
      tools: {},
    }),
  }).catch(() => {});

  // 3. 获取 directory
  const infoRes = await fetch(`${SAAS_URL}/session/${session.id}`);
  const info = await infoRes.json();

  // 4. 订阅 SSE
  const sseRes = await fetch(`${SAAS_URL}/event`, {
    headers: { "x-opencode-directory": info.directory },
  });
  if (!sseRes.ok || !sseRes.body) throw new Error("SSE failed");

  const reader = sseRes.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  let connected = false;
  let messageSent = false;
  let allText = "";

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
      try { raw = JSON.parse(line.slice(6)); } catch { continue; }
      const event = raw.payload || raw;

      if (!connected && event.type === "server.connected") {
        connected = true;
        if (!messageSent) {
          messageSent = true;
          fetch(`${SAAS_URL}/session/${session.id}/prompt_async`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              parts: [{ type: "text", text: userText }],
              model: modelPayload,
              agent: "openui",
              system: "Respond with: root = Stack([TextContent(\"hello\")])",
            }),
          }).catch(() => {});
        }
        continue;
      }

      if (event.type === "server.heartbeat") continue;

      if (event.type === "message.part.delta" && event.properties.field === "text") {
        allText += event.properties.delta;
      }

      if (event.type === "session.idle") {
        reader.cancel();
        break;
      }
    }
  }

  fetch(`${SAAS_URL}/session/${session.id}`, { method: "DELETE" }).catch(() => {});
  return allText;
}

// 测试 TransformStream
function testTransformStream(): { ok: boolean; data: string } {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  writer.write(encoder.encode("data: hello\n\n"));
  writer.write(encoder.encode("data: world\n\n"));
  writer.close();

  return { ok: true, data: "TransformStream created, data written" };
}

export default function TestPage() {
  const [result, setResult] = useState("点击按钮测试");
  const [busy, setBusy] = useState(false);

  const testDirect = useCallback(async () => {
    setBusy(true);
    setResult("调用 SaaS 中...");
    try {
      const text = await callSaaS("说一个字");
      setResult(`✅ SaaS 返回 (${text.length} 字符):\n${text.slice(0, 500)}`);
    } catch (e) {
      setResult(`❌ 错误: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const testTransform = useCallback(() => {
    try {
      const r = testTransformStream();
      setResult(`✅ ${r.data}`);
    } catch (e) {
      setResult(`❌ TransformStream 错误: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // 测试 send() + Response + adapter 完整链路
  const testFullChain = useCallback(async () => {
    setBusy(true);
    setResult("测试完整链路...");
    try {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      // IIFE 写入数据
      (async () => {
        await new Promise((r) => setTimeout(r, 100));
        writer.write(encoder.encode('data: {"type":"TEXT_MESSAGE_START","messageId":"test","role":"assistant"}\n\n'));
        await new Promise((r) => setTimeout(r, 50));
        writer.write(encoder.encode('data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"test","delta":"root = Stack([TextContent(\\"hello\\")])"}\n\n'));
        await new Promise((r) => setTimeout(r, 50));
        writer.write(encoder.encode('data: {"type":"TEXT_MESSAGE_END","messageId":"test"}\n\n'));
        await new Promise((r) => setTimeout(r, 50));
        writer.close();
      })();

      const response = new Response(readable, {
        headers: { "Content-Type": "text/event-stream" },
      });

      // 用和 agUIAdapter 一样的逻辑解析
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const events: any[] = [];

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
          try { events.push(JSON.parse(data)); } catch {}
        }
      }

      setResult(`✅ 收到 ${events.length} 个事件:\n${JSON.stringify(events, null, 2)}`);
    } catch (e) {
      setResult(`❌ 错误: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div style={{ padding: 20, fontFamily: "monospace", fontSize: 13 }}>
      <h2>调试面板</h2>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={testTransform} style={{ padding: "4px 12px" }}>1. 测 TransformStream</button>
        <button onClick={testFullChain} disabled={busy} style={{ padding: "4px 12px" }}>2. 测 Response+Adapter 链路</button>
        <button onClick={testDirect} disabled={busy} style={{ padding: "4px 12px" }}>3. 测 SaaS API 直调</button>
      </div>
      <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", background: "#f5f5f5", padding: 12, borderRadius: 4, maxHeight: 400, overflow: "auto" }}>
        {result}
      </pre>
    </div>
  );
}