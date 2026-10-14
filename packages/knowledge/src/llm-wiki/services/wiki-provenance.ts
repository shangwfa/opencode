import { createHash } from 'crypto'
import { tiptapToMarkdown } from '../../utils/tiptap-to-markdown.js'
import type { CompilationDocument } from './wiki-compilation-plan.js'
import type { WikiEvidence, WikiPageContent } from '../types/wiki.types.js'

export interface WikiSourceManifest {
  document: CompilationDocument
  contentHash: string
  title: string
  blocks: Array<{ refId: string; blockIndex: number; textHash: string; text: string }>
}

export class WikiProvenanceError extends Error {
  constructor(readonly issues: string[]) {
    super(`Wiki provenance validation failed: ${issues.join('; ')}`)
    this.name = 'WikiProvenanceError'
  }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex')

/** 段落标识绑定原文版本；修订中保存 raw content，不靠当前文档重建历史。 */
export function buildSourceManifest(document: CompilationDocument): WikiSourceManifest {
  const metadata = document.metadata && typeof document.metadata === 'object'
    ? document.metadata as Record<string, unknown> : {}
  const title = typeof metadata.docName === 'string' ? metadata.docName : document.id
  const markdown = document.type === 'tiptap' ? tiptapToMarkdown(JSON.parse(document.content)) : document.content
  const contentHash = hash(document.content)
  const blocks = markdown.replace(/\r\n/g, '\n').split(/\n[ \t]*\n/).map(text => text.trim()).filter(Boolean)
    .map((text, blockIndex) => ({ refId: `wiki-ref:${hash(JSON.stringify([document.id, contentHash, blockIndex, text]))}`,
      blockIndex, textHash: hash(text), text }))
  return { document: { id: document.id, knowledgeBaseId: document.knowledgeBaseId, content: document.content,
    type: document.type, metadata: document.metadata }, contentHash, title, blocks }
}

export function formatSourceManifest(manifest: WikiSourceManifest): string {
  return JSON.stringify({ documentId: manifest.document.id, title: manifest.title,
    contentHash: manifest.contentHash, blocks: manifest.blocks })
}

/**
 * 面向模型的轻量源材料清单：只给全局块序号与原文（省略 refId 哈希与 contentHash），
 * 模型以 blockIndex + anchor 指认证据，由 materializePageContent 回填完整引文。
 */
export function formatSourceManifestsForModel(manifests: WikiSourceManifest[]): string {
  return flatBlocks(manifests)
    .map((block, index) => JSON.stringify({ blockIndex: index, documentTitle: block.documentTitle, text: block.text }))
    .join('\n\n---\n\n')
}

interface FlatBlock { refId: string; text: string; documentId: string; documentTitle: string }

function flatBlocks(manifests: WikiSourceManifest[]): FlatBlock[] {
  return manifests.flatMap(manifest =>
    manifest.blocks.map(block => ({ refId: block.refId, text: block.text,
      documentId: manifest.document.id, documentTitle: manifest.title })))
}

/**
 * 瘦身上游：把模型输出的 blockIndex + anchor 证据指认回填为完整 { refId, quote }。
 * - 旧协议（refId + quote）原样透传，向后兼容；
 * - anchor 必须逐字存在于所指块的原文中，否则拒绝（不得回填伪造证据）；
 * - 回填后的页面仍须经 validatePageProvenance 完整校验。
 */
export function materializePageContent(
  page: Record<string, any>,
  manifests: WikiSourceManifest[],
): { page: WikiPageContent; errors: string[] } {
  const errors: string[] = []
  const blocks = flatBlocks(manifests)
  const blockByIndex = (index: number) => (Number.isInteger(index) && index >= 0 && index < blocks.length ? blocks[index] : null)
  const materializeEvidence = (evidence: any[], label: string): WikiEvidence[] =>
    (evidence || []).map((item, i) => {
      if (item?.refId && item?.quote) return { refId: String(item.refId), quote: String(item.quote) }
      const block = blockByIndex(Number(item?.blockIndex))
      if (!block) {
        errors.push(`Invalid block index: ${label}#${i}=${item?.blockIndex}`)
        return { refId: '', quote: '' }
      }
      const anchor = String(item?.anchor ?? '').trim()
      if (!anchor || !block.text.includes(anchor)) {
        errors.push(`Anchor not found: ${label}#${i}`)
        return { refId: '', quote: '' }
      }
      return { refId: block.refId, quote: block.text }
    })

  const sections = (page.sections || []).map((section: any) => {
    const claimRefs = ((section.claims || []) as any[]).flatMap(claim =>
      (claim.evidence || []).map((item: any) => {
        if (item?.refId) return String(item.refId)
        const block = blockByIndex(Number(item?.blockIndex))
        return block ? block.refId : null
      })).filter(Boolean)
    const sourceRefs: string[] = [...new Set([
      ...(section.sourceRefs || []),
      // claim 引用的块即段落引用：模型漏列 sourceBlockIndexes 不应误拒（见 Claim ref missing）。
      ...claimRefs,
      ...(section.sourceBlockIndexes || []).map((index: number) => {
        const block = blockByIndex(Number(index))
        if (!block) {
          errors.push(`Invalid block index: section ${section.heading}#${index}`)
          return null
        }
        return block.refId
      }).filter(Boolean),
    ])]
    return {
      heading: section.heading,
      content: section.content,
      sourceRefs,
      claims: (section.claims || []).map((claim: any) => ({
        statement: claim.statement,
        evidence: materializeEvidence(claim.evidence, `claim ${claim.statement}`),
      })),
    }
  })

  const materialized: WikiPageContent = {
    ...page,
    sections,
    definitionEvidence: materializeEvidence(page.definitionEvidence, 'definition'),
    summaryEvidence: materializeEvidence(page.summaryEvidence, 'summary'),
    conflicts: (page.conflicts || []).map((conflict: any) => ({
      topic: conflict.topic,
      statements: (conflict.statements || []).map((claim: any) => ({
        statement: claim.statement,
        evidence: materializeEvidence(claim.evidence, `conflict ${conflict.topic}`),
      })),
    })),
  }
  return { page: materialized, errors: [...new Set(errors)] }
}

/** 剥离 [[wikilink]] 标记，保留纯文本：statement 与正文的覆盖比对不应因格式标记差异误拒。 */
export function stripWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]]+)\]\]/g, '$1')
}

/** 校验引用、版本及逐字引文；不宣称证明断言被原文逻辑蕴含。 */
export function validatePageProvenance(page: WikiPageContent, manifests: WikiSourceManifest[]): string[] {
  const errors: string[] = []
  const refs = new Map(manifests.flatMap(manifest => manifest.blocks.map(block =>
    [block.refId, { ...block, documentId: manifest.document.id }] as const)))
  if (new Set(manifests.map(manifest => manifest.document.knowledgeBaseId)).size > 1) errors.push('Mixed knowledge bases in source manifest')
  const checkEvidence = (evidence: WikiEvidence[] | undefined, label: string) => {
    if (!evidence?.length) errors.push(`Missing evidence: ${label}`)
    for (const item of evidence || []) {
      const source = refs.get(item.refId)
      if (!source) errors.push(`Unknown source ref: ${item.refId}`)
      else if (!item.quote.trim() || !source.text.includes(item.quote)) errors.push(`Quote not found: ${item.refId}`)
    }
  }
  for (const section of page.sections) {
    if (!section.sourceRefs?.length) errors.push(`Missing source refs: ${section.heading}`)
    for (const ref of section.sourceRefs || []) if (!refs.has(ref)) errors.push(`Unknown source ref: ${ref}`)
    if (!section.claims?.length) errors.push(`Missing claims: ${section.heading}`)
    for (const claim of section.claims || []) {
      // 断言允许是正文的改写：不再强制逐字出现在 content，但必须被至少一条逐字引文覆盖（quote 已锚定原文段落）。
      // [[wikilink]] 是格式标记不是内容：比对前统一剥离，避免"进入[[知识库]]"与"进入知识库"这类误拒。
      const statement = stripWikiLinks(claim.statement)
      const grounded = stripWikiLinks(section.content).includes(statement)
        || (claim.evidence || []).some(item => item.quote.includes(claim.statement))
      if (!grounded) errors.push(`Claim missing from section: ${claim.statement}`)
      checkEvidence(claim.evidence, claim.statement)
      for (const evidence of claim.evidence) if (!section.sourceRefs?.includes(evidence.refId)) errors.push(`Claim ref missing from section: ${evidence.refId}`)
    }
  }
  if (page.definition) checkEvidence(page.definitionEvidence, 'definition')
  if (page.summary) checkEvidence(page.summaryEvidence, 'summary')
  const body = page.sections.map(section => section.content).join('\n')
  for (const conflict of page.conflicts || []) {
    if (!body.includes('冲突待确认') || !body.includes(conflict.topic)) errors.push(`Conflict not visible: ${conflict.topic}`)
    const documents = new Set<string>()
    if (conflict.statements.length < 2) errors.push(`Conflict requires two statements: ${conflict.topic}`)
    if (new Set(conflict.statements.map(claim => claim.statement.trim())).size < 2) errors.push(`Conflict requires distinct statements: ${conflict.topic}`)
    for (const claim of conflict.statements) {
      if (!stripWikiLinks(body).includes(stripWikiLinks(claim.statement))) errors.push(`Conflict statement not visible: ${claim.statement}`)
      checkEvidence(claim.evidence, conflict.topic)
      for (const evidence of claim.evidence) {
        const source = refs.get(evidence.refId)
        if (source) documents.add(source.documentId)
      }
    }
    if (documents.size < 2) errors.push(`Conflict requires distinct documents: ${conflict.topic}`)
  }
  return [...new Set(errors)]
}
