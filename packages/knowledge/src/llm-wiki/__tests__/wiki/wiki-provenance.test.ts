import { describe, expect, it } from 'bun:test'
import { buildSourceManifest, materializePageContent, validatePageProvenance, stripWikiLinks } from '../../services/wiki-provenance.js'

const sourceA = buildSourceManifest({ id: 'a', knowledgeBaseId: 'kb', type: 'markdown',
  content: '任务尚未结束时不要重复发起相同的全量同步。\n\n只重试失败文档。' })
const sourceB = buildSourceManifest({ id: 'b', knowledgeBaseId: 'kb', type: 'markdown',
  content: '任务可以重复发起全量同步。' })
const evidence = { refId: sourceA.blocks[0].refId, quote: sourceA.blocks[0].text }
const statement = evidence.quote
const valid = () => ({ sections: [{ heading: '同步', content: statement,
  sourceRefs: [evidence.refId], claims: [{ statement, evidence: [evidence] }] }], relatedConcepts: [] })

describe('Wiki 引用与证据校验', () => {
  it('相同来源版本的段落 ID 稳定，来源变化时改变', () => {
    expect(buildSourceManifest(sourceA.document).blocks).toEqual(sourceA.blocks)
    const changed = buildSourceManifest({ ...sourceA.document, content: sourceA.document.content + '修改' })
    expect(changed.blocks[0].refId).not.toBe(sourceA.blocks[0].refId)
  })
  it('接受引用有效、引文确实存在的声明', () => {
    expect(validatePageProvenance(valid(), [sourceA])).toEqual([])
  })
  it('拒绝伪造引用，即使 documentId 存在也不能冒充段落引用', () => {
    const page = valid()
    page.sections[0].sourceRefs = ['a']
    expect(validatePageProvenance(page, [sourceA]).join(';')).toContain('Unknown source ref')
  })
  it('拒绝其它来源、旧版本及来源列表外的证据', () => {
    const page = valid()
    expect(validatePageProvenance(page, [sourceB]).length).toBeGreaterThan(0)
    const changed = buildSourceManifest({ ...sourceA.document, content: '已撤销原事实。' })
    expect(validatePageProvenance(page, [changed]).length).toBeGreaterThan(0)
  })
  it('拒绝在原段落中找不到的引文', () => {
    const page = valid()
    page.sections[0].claims[0].evidence[0] = { ...evidence, quote: '可以重复发起全量同步。' }
    expect(validatePageProvenance(page, [sourceA]).join(';')).toContain('Quote not found')
  })
  it('事实章节必须有显式声明和证据，声明必须出现在正文', () => {
    expect(validatePageProvenance({ sections: [{ heading: '无引用', content: '无依据内容', sourceRefs: [] }] }, [sourceA]).length).toBeGreaterThan(0)
    const page = valid()
    page.sections[0].claims[0].statement = '正文与引文之外改写的断言'
    expect(validatePageProvenance(page, [sourceA]).join(';')).toContain('Claim missing from section')
  })
  it('断言是对正文的改写时，必须至少被一条逐字引文覆盖', () => {
    const page = valid()
    const quote = sourceA.blocks[0].text
    // 正文为改写表述、不含断言原句；断言本身等于逐字引文，应通过（证据链由 quote 锚定）。
    page.sections[0].content = '同步尚未完成时，请勿再次发起相同的全量同步操作。'
    page.sections[0].claims[0] = { statement: quote, evidence: [evidence] }
    expect(validatePageProvenance(page, [sourceA])).toEqual([])
    // 断言既不在正文也不被任何逐字引文覆盖 → 拒绝（证据强度不降）。
    page.sections[0].claims[0] = { statement: '正文与引文之外改写的断言', evidence: [evidence] }
    expect(validatePageProvenance(page, [sourceA]).join(';')).toContain('Claim missing from section')
  })
  it('瘦身上游：blockIndex+anchor 协议由服务器回填完整引文与 refId', () => {
    const raw = {
      definition: '定义', summary: '摘要',
      definitionEvidence: [{ blockIndex: 0, anchor: '任务尚未结束时' }],
      summaryEvidence: [{ blockIndex: 1, anchor: '只重试失败文档' }],
      tags: ['t'],
      sections: [{
        heading: '同步', content: sourceA.blocks[0].text,
        sourceBlockIndexes: [0, 1],
        claims: [{ statement: sourceA.blocks[0].text, evidence: [{ blockIndex: 0, anchor: '任务尚未结束时' }] }],
      }],
      relatedConcepts: [],
    }
    const { page, errors } = materializePageContent(raw, [sourceA, sourceB])
    expect(errors).toEqual([])
    expect(page!.sections[0]!.sourceRefs).toEqual([sourceA.blocks[0].refId, sourceA.blocks[1].refId])
    const claim = page!.sections[0]!.claims![0]!
    expect(claim.evidence[0]!.refId).toBe(sourceA.blocks[0].refId)
    expect(claim.evidence[0]!.quote).toBe(sourceA.blocks[0].text)
    expect((claim.evidence[0] as any).anchor).toBeUndefined()
    expect(page!.definitionEvidence![0]!.quote).toBe(sourceA.blocks[0].text)
    // 回填后的页面必须通过既有证据校验（引文逐字、refId 有效）。
    expect(validatePageProvenance(page!, [sourceA])).toEqual([])
  })
  it('瘦身上游：锚点不在原文或 blockIndex 越界时拒绝，不得回填伪造证据', () => {
    const bad = materializePageContent({
      sections: [{ heading: 'h', content: 'x', sourceBlockIndexes: [99], claims: [{ statement: 'x', evidence: [{ blockIndex: 0, anchor: '原文没有的锚点' }] }] }],
    }, [sourceA])
    expect(bad.errors.join(';')).toContain('Invalid block index')
    const badAnchor = materializePageContent({
      sections: [{ heading: 'h', content: 'x', sourceRefs: [], claims: [{ statement: 'x', evidence: [{ blockIndex: 0, anchor: '原文没有的锚点' }] }] }],
    }, [sourceA])
    expect(badAnchor.errors.join(';')).toContain('Anchor not found')
    // 旧协议（refId+quote）原样透传，不依赖 blockIndex。
    const legacy = materializePageContent(valid(), [sourceA])
    expect(legacy.errors).toEqual([])
    expect(legacy.page!.sections[0]!.claims![0]!.evidence[0]!.quote).toBe(sourceA.blocks[0].text)
  })
  it('claim 引用的块自动并入段落 sourceRefs（模型漏列不误拒）', () => {
    const { page, errors } = materializePageContent({
      sections: [{ heading: 'h', content: sourceA.blocks[1]!.text, sourceBlockIndexes: [1],
        claims: [{ statement: sourceA.blocks[0]!.text, evidence: [{ blockIndex: 0, anchor: '任务尚未结束时' }] }] }],
    }, [sourceA])
    expect(errors).toEqual([])
    expect(page!.sections[0]!.sourceRefs).toContain(sourceA.blocks[0]!.refId)
    expect(validatePageProvenance(page!, [sourceA])).toEqual([])
  })
  it('statement 覆盖比对剥离 [[wikilink]] 标记（格式差异不误拒）', () => {
    const page = valid()
    page.sections[0]!.content = `通过同步进入[[知识库]]后，系统会保存来源信息。`
    page.sections[0]!.claims = [{ statement: '通过同步进入知识库后，系统会保存来源信息。',
      evidence: [evidence] }]
    expect(validatePageProvenance(page, [sourceA])).toEqual([])
  })
  it('定义和摘要也需要来源证据', () => {
    expect(validatePageProvenance({ ...valid(), definition: '定义', summary: '摘要' }, [sourceA]).length).toBeGreaterThan(0)
  })
  it('冲突必须保留两份来源证据，并在正文明确标注', () => {
    const other = { refId: sourceB.blocks[0].refId, quote: sourceB.blocks[0].text }
    const page = { ...valid(), conflicts: [{ topic: '全量同步', statements: [
      { statement, evidence: [evidence] }, { statement: other.quote, evidence: [other] },
    ] }] }
    expect(validatePageProvenance(page, [sourceA, sourceB]).join(';')).toContain('Conflict not visible')
    page.sections[0].content += `\n冲突待确认：全量同步\n${other.quote}`
    expect(validatePageProvenance(page, [sourceA, sourceB])).toEqual([])
  })
  it('同一个来源不能冒充两方冲突', () => {
    const page = { ...valid(), conflicts: [{ topic: '全量同步', statements: [
      { statement, evidence: [evidence] }, { statement: '其它说法', evidence: [evidence] },
    ] }] }
    page.sections[0].content += '\n冲突待确认：全量同步\n其它说法'
  expect(validatePageProvenance(page, [sourceA]).join(';')).toContain('Conflict requires distinct documents')
  })
})
