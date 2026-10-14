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
    case "azure":
    case "deepseek":
    case "qwen":
    case "chatglm":
      // 必须透传完整 provider/model 规格：createChatModel 在 inner 模式下按
      // 前缀路由渠道（resolveChannelModel），此处先剥前缀会把 azure/gpt-5.5
      // 错误路由到 openai 渠道；标准模式下 normalizeModelId 自会剥离前缀。
      return openaiChat(model) as any;
    case "google":
    case "anthropic":
      // 目标包仅提供 OpenAI 兼容 provider（providers/llm.ts），无 google/anthropic 等价实现。
      throw new Error(`Unsupported model provider in @opencode/knowledge: ${provider}`);
    default:
      throw new Error(`Unsupported model provider: ${provider}`);
  }
}
