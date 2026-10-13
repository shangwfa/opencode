import { openaiChat } from '../providers/llm.js'

const OPENAI_COMPATIBLE_CHANNELS = ["azure", "deepseek", "qwen", "chatglm"] as const;

export function resolveModel(model: string) {
  const [provider, ...modelParts] = model.split("/");
  const modelId = modelParts.join("/");

  if (!provider || !modelId) {
    throw new Error(`Invalid model format: ${model}`);
  }

  switch (provider) {
    case "openai":
      return openaiChat(modelId) as any;
    case "azure":
    case "deepseek":
    case "qwen":
    case "chatglm":
      // 原实现按通道选择不同 baseURL 的 openai 兼容 provider；
      // 目标包统一走 providers/llm.ts（KNOWLEDGE_LLM_BASE_URL），通道名不再参与路由。
      return openaiChat(modelId) as any;
    case "google":
    case "anthropic":
      // 目标包仅提供 OpenAI 兼容 provider（providers/llm.ts），无 google/anthropic 等价实现。
      throw new Error(`Unsupported model provider in @opencode/knowledge: ${provider}`);
    default:
      throw new Error(`Unsupported model provider: ${provider}`);
  }
}
