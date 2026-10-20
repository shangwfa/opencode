import type { ModelRef } from "@/features/requirement/flows/config";
import { pickModel } from "@/context/requirement-sync/shared";

const SYNC_MESSAGE_TIMEOUT_MS = 120_000;

export type SendStageSyncMessageInput = {
  sessionId: string;
  agent: string;
  text: string;
  model?: ModelRef;
};

export async function sendStageSyncMessage(input: {
  entry: SendStageSyncMessageInput;
  baseUrl: string;
  resolveModel: (hint?: ModelRef) => Promise<ModelRef>;
}) {
  const sid = input.entry.sessionId.trim();
  const text = input.entry.text.trim();
  if (!sid || !text) return;

  const picked = await input.resolveModel(input.entry.model);
  const payload = {
    agent: input.entry.agent,
    model: picked,
    parts: [{ type: "text" as const, text }],
  };

  const base = input.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/session/${encodeURIComponent(sid)}/message`);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SYNC_MESSAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body.trim() || `同步消息失败 (${res.status})`);
  }

  const trimmed = (await res.text()).trim();
  if (!trimmed) {
    throw new Error("同步消息返回为空，请检查 session 与模型配置");
  }
}
