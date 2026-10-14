/**
 * Knowledge 包的环境配置。
 *
 * 数据库：
 *   KNOWLEDGE_DATABASE_URL    PostgreSQL 连接串（回退 DATABASE_URL、OPENCODE_DATABASE_URL）
 *   KNOWLEDGE_DATABASE_SCHEMA 业务 schema 名，默认 "knowledge"
 *
 * LLM / Embedding（OpenAI 兼容协议，可配置）：
 *   KNOWLEDGE_LLM_BASE_URL       OpenAI 兼容 chat 端点，默认 https://api.openai.com/v1
 *   KNOWLEDGE_LLM_API_KEY        API Key
 *   KNOWLEDGE_EMBEDDING_BASE_URL embedding 端点，默认同 KNOWLEDGE_LLM_BASE_URL
 *   KNOWLEDGE_EMBEDDING_API_KEY  默认同 KNOWLEDGE_LLM_API_KEY
 *   KNOWLEDGE_DEFAULT_CHAT_MODEL       默认 openai/gpt-5.6（代理已开通）
 *   KNOWLEDGE_DEFAULT_EMBEDDING_MODEL  默认 openai/text-embedding-3-small
 *   KNOWLEDGE_LLM_CHANNEL              设为 "inner" 时 chat 走影刀内网会话代理
 *                                      （需 XYBOT_AI_BASE_URL / XYBOT_USER_HEADER / PROXY_BIZ_CODE /
 *                                      PROXY_BIZ_ID / PROXY_BIZ_TYPE，模型按 provider/model-id 前缀
 *                                      路由渠道 openai/azure/deepseek/qwen/chatglm，见 providers/conversation-proxy.ts）
 *   KNOWLEDGE_EMBEDDING_CHANNEL        设为 "inner" 时 embedding 走影刀内网代理
 *                                      （需 XYBOT_AI_BASE_URL / XYBOT_USER_HEADER / PROXY_BIZ_CODE /
 *                                      PROXY_BIZ_ID / PROXY_BIZ_TYPE / PROXY_CONNECTOR_UUID，
 *                                      见 providers/inner-proxy.ts；运行时建议 no_proxy 含内网主机）
 *
 * MCP（kb-document-search）：
 *   MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_IDS    默认知识库 CSV（ID 优先）
 *   MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_NAMES  默认知识库 CSV（名称，ID 缺省时）
 *   DOCUMENT_SEARCH_DEBUG                    "true" 时输出检索合并日志
 */

export function getDatabaseUrl(): string {
  const url =
    process.env["KNOWLEDGE_DATABASE_URL"] || process.env["DATABASE_URL"] || process.env["OPENCODE_DATABASE_URL"] || ""
  return url.trim()
}

export function getDatabaseSchema(): string {
  return (process.env["KNOWLEDGE_DATABASE_SCHEMA"] || "knowledge").replace(/['"]/g, "").trim() || "knowledge"
}

export interface LLMEndpointConfig {
  baseURL: string
  apiKey: string
}

export function getChatEndpoint(): LLMEndpointConfig {
  return {
    baseURL: (process.env["KNOWLEDGE_LLM_BASE_URL"] || "https://api.openai.com/v1").replace(/\/+$/, ""),
    apiKey: process.env["KNOWLEDGE_LLM_API_KEY"] || "unused",
  }
}

export function getEmbeddingEndpoint(): LLMEndpointConfig {
  return {
    baseURL: (process.env["KNOWLEDGE_EMBEDDING_BASE_URL"] || getChatEndpoint().baseURL).replace(/\/+$/, ""),
    apiKey: process.env["KNOWLEDGE_EMBEDDING_API_KEY"] || getChatEndpoint().apiKey,
  }
}

export function getDefaultChatModel(): string {
  // 图谱抽取等 LLM 任务的默认模型（provider/model-id 格式，经 resolveModel/openaiChat
  // 归一后调用 KNOWLEDGE_LLM_BASE_URL 兼容端点；请确保该端点支持此模型，失败时相关链路自动降级）。
  return process.env["KNOWLEDGE_DEFAULT_CHAT_MODEL"] || "openai/gpt-5.6"
}

export function getDefaultEmbeddingModel(): string {
  return process.env["KNOWLEDGE_DEFAULT_EMBEDDING_MODEL"] || "openai/text-embedding-3-small"
}

/**
 * MCP kb-document-search 默认知识库（CSV，ID 或名称），单次调用传参仍可覆盖。
 * 优先 MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_IDS，其次 MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_NAMES。
 */
export function getMcpKbDocumentSearchDefaultKbs(): string[] {
  const parseCsv = (value: string | undefined): string[] | undefined => {
    const items = value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean)
    return items && items.length > 0 ? items : undefined
  }
  return (
    parseCsv(process.env["MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_IDS"]) ??
    parseCsv(process.env["MCP_KB_DOCUMENT_SEARCH_DEFAULT_KB_NAMES"]) ??
    []
  )
}

/**
 * 模型 ID 归一：业务侧习惯写 "openai/text-embedding-3-small"，
 * OpenAI 兼容端点需要裸模型名。
 */
export function normalizeModelId(modelId: string): string {
  return modelId.includes("/") && /^(openai|azure)\//.test(modelId) ? modelId.split("/").slice(1).join("/") : modelId
}
