/**
 * 兼容层：tiptap → markdown 转换已下沉至 graph-rag 模块（src/graph/utils），
 * 供文档平台/知识库等应用层复用。LLM 增强版仍在应用层（tiptap-to-markdown-llm.ts）。
 */
export { tiptapToMarkdown } from '../graph/utils/tiptap-to-markdown.js'
