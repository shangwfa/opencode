import type { ModelRef } from "@/features/requirement/flows/config";
export type { ModelRef } from "@/features/requirement/flows/config";

export const mergeAgents = <T extends { name: string }>(base: T[], extra: T[]) => {
  const map = new Map(base.map((item) => [item.name, item] as const));
  for (const item of extra) map.set(item.name, item);
  return [...map.values()];
};

export const pickModel = (data: unknown): ModelRef | undefined => {
  const root = data as {
    connected?: string[];
    all?: { id: string; models?: Record<string, { id: string }> }[];
  };
  const connected = root?.connected;
  const all = root?.all;
  if (!connected?.length || !all?.length) return;
  const provider = all.find((item) => connected.includes(item.id));
  if (!provider?.models) return;
  const models = Object.values(provider.models);
  if (!models.length) return;
  return { providerID: provider.id, modelID: models[0]!.id };
}
