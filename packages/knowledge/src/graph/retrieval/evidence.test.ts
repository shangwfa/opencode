import { describe, expect, it } from 'bun:test'
import { contentHash, parseAnswerClaims } from './evidence.js'

describe('evidence', () => {
  it('生成稳定的证据内容哈希', () => {
    expect(contentHash('同一证据')).toBe(contentHash('同一证据'))
    expect(contentHash('同一证据')).not.toBe(contentHash('另一证据'))
  })

  it('只接受当前 trace 中存在的 evidenceId', () => {
    const claims = parseAnswerClaims('结论 [ev:1]\n错误引用 [ev:404]', new Set(['ev:1']))

    expect(claims[0]).toMatchObject({ evidenceIds: ['ev:1'], support: 'direct' })
    expect(claims[1]).toMatchObject({ evidenceIds: [], support: 'invalid_reference' })
  })

  it('没有引用的答案标记为 unsupported', () => {
    expect(parseAnswerClaims('无法确认', new Set())[0].support).toBe('unsupported')
  })
})
