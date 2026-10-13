import { describe, expect, it } from 'bun:test'
import { compileOntologyQuerySql } from './sql-compiler.js'

describe('compileOntologyQuerySql', () => {
  it('编译多 pattern join、重复变量、graph 和参数过滤', () => {
    const compiled = compileOntologyQuerySql({
      variables: ['sensor', 'room'],
      patterns: [
        { subject: { variable: 'sensor' }, predicate: { value: 'a' }, object: { value: 'urn:Sensor' } },
        { subject: { variable: 'sensor' }, predicate: { value: 'urn:observes' }, object: { variable: 'room' } },
      ],
      graph: 'urn:graph:knowledge:kb', inferred: true, filters: [{ variable: 'room', operator: '!=', value: 'urn:none' }], limit: 5,
    }, 'test')
    expect(compiled.text).toContain('q1.subject = q0.subject')
    expect(compiled.text).toContain('array_agg(DISTINCT q0.id)')
    expect(compiled.text).toContain('q0.source_chunk_id')
    expect(compiled.text).toContain('q1.source_run_id')
    expect(compiled.text).toContain('LIMIT 5')
    expect(compiled.params).toContain('urn:Sensor')
    expect(compiled.params).toContain('urn:observes')
  })

  it('为每个查询结果编译去重后的三类 provenance 数组', () => {
    const compiled = compileOntologyQuerySql({
      variables: ['x'],
      patterns: [{ subject: { variable: 'x' }, predicate: { value: 'urn:p' }, object: { value: 'urn:o' } }],
    }, 'test')
    expect(compiled.text).toContain('AS "statementIds"')
    expect(compiled.text).toContain('AS "sourceChunkIds"')
    expect(compiled.text).toContain('AS "sourceRunIds"')
    expect(compiled.text).toContain('unnest(')
    expect(compiled.text).toContain('DISTINCT value')
  })
})
