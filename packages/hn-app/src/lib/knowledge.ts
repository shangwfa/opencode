/** 知识库前端类型与纯逻辑：数据源定数据，检索/后处理能力定用法。 */

export type KnowledgeSourceType = "documents" | "structured"

/** 文档库支持全部后处理；结构化数据支持混合检索与图检索。 */
export type KnowledgeCapability = "rag" | "graph" | "wiki" | "hybrid"

export const SOURCE_LABELS: Record<KnowledgeSourceType, string> = {
  documents: "文档库",
  structured: "结构化数据",
}

export const CAPABILITY_LABELS: Record<KnowledgeCapability, string> = {
  rag: "RAG",
  graph: "GraphRAG",
  wiki: "LLM-Wiki",
  hybrid: "混合检索",
}

export interface KnowledgeBaseSummary {
  editorUrl?: string | null
  /** 已发布文档数 */
  publishedCount?: number
  /** 知识处理失败的文档数 */
  failedCount?: number
  /** 已发布但仍在处理中的文档数 */
  pendingCount?: number
  id: string
  name: string
  description?: string
  sourceType: KnowledgeSourceType
  capabilities: KnowledgeCapability[]
  documentCount: number
  chunkCount: number
  embeddingModel?: string
  status: "ready" | "indexing" | "error"
  timeUpdated: number
}

export interface KnowledgeDocSummary {
  id: string
  name: string
  chunkCount: number
  status: "ready" | "indexing" | "error"
  source: "doc-platform" | "upload" | "text" | "url" | "api-spec"
  timeUpdated: number
}

export interface KnowledgeChunk {
  index: number
  text: string
  tokenCount?: number
  vectorized: boolean
}

export interface KnowledgeTask {
  id: string
  type: "doc-platform-sync" | "yydoc-sync" | "wiki-compile" | "graph-ingest" | "vectorize"
  baseName: string
  status: "running" | "succeeded" | "failed"
  progress: number
  message?: string
  timeUpdated: number
}

export const DETAIL_TABS = ["docs", "recall", "graph", "wiki", "tasks"] as const
export type DetailTab = (typeof DETAIL_TABS)[number]

export const DETAIL_TAB_LABELS: Record<DetailTab, string> = {
  docs: "文档",
  recall: "分段&召回测试",
  graph: "图谱",
  wiki: "Wiki",
  tasks: "任务",
}

/** Tab 显隐由数据源与启用能力决定：RAG 出分段&召回；graph/wiki 各出一 Tab。 */
export function detailTabs(sourceType: KnowledgeSourceType, capabilities: readonly KnowledgeCapability[]): DetailTab[] {
  const enabled = new Set(capabilities)
  const tabs: DetailTab[] = ["docs"]
  if (sourceType === "structured" || enabled.has("rag") || enabled.has("hybrid")) tabs.push("recall")
  if (enabled.has("graph")) tabs.push("graph")
  if (enabled.has("wiki")) tabs.push("wiki")
  tabs.push("tasks")
  return tabs
}

/** 创建/库设置可勾选的能力组合；文档库默认 RAG。 */
export function selectableCapabilities(sourceType: KnowledgeSourceType): Array<{ id: KnowledgeCapability; required: boolean }> {
  return sourceType === "documents"
    ? [
        { id: "rag", required: false },
        { id: "graph", required: false },
        { id: "wiki", required: false },
      ]
    : [
        { id: "hybrid", required: false },
        { id: "graph", required: false },
      ]
}

export function defaultCapabilities(sourceType: KnowledgeSourceType): KnowledgeCapability[] {
  return sourceType === "documents" ? ["rag"] : ["hybrid"]
}

export function filterBases(
  bases: readonly KnowledgeBaseSummary[],
  input: { query?: string; sourceType?: KnowledgeSourceType | "all" },
): KnowledgeBaseSummary[] {
  const query = input.query?.trim().toLocaleLowerCase()
  return bases.filter((base) => {
    if (input.sourceType && input.sourceType !== "all" && base.sourceType !== input.sourceType) return false
    if (!query) return true
    return `${base.name} ${base.description ?? ""}`.toLocaleLowerCase().includes(query)
  })
}
