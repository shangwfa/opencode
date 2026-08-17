import { describe, expect, test } from 'bun:test'
import { parseCanvasOperation } from './schema.ts'

describe('parseCanvasOperation', () => {
  test('accepts versioned operations and rejects retired render', () => {
    expect(parseCanvasOperation({ op: 'render', mermaid: 'graph TD\nA-->B' }).ok).toBe(false)
    const result = parseCanvasOperation({
      schemaVersion: 1,
      operationId: 'op-1',
      baseRevision: 3,
      operation: { op: 'patch', id: 'node-a', text: 'updated' },
    })
    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        operationId: 'op-1',
        baseRevision: 3,
        operation: { op: 'patch', id: 'node-a', text: 'updated' },
        legacy: false,
      },
    })
  })

  test('rejects invalid numbers and duplicate draw ids', () => {
    expect(parseCanvasOperation({
      op: 'draw',
      elements: [{ type: 'text', id: 'a', x: Number.NaN, y: 0, text: 'bad' }],
    })).toEqual({ ok: false, error: 'elements[0].x 必须是有限数字' })
    expect(parseCanvasOperation({
      op: 'draw',
      elements: [
        { type: 'text', id: 'a', x: 0, y: 0, text: 'one' },
        { type: 'text', id: 'a', x: 0, y: 20, text: 'two' },
      ],
    })).toEqual({ ok: false, error: 'draw.elements 包含重复 id' })
  })

  test('accepts empty elements only for legacy clear', () => {
    expect(parseCanvasOperation({ op: 'draw', clear: true, elements: [] }).ok).toBe(true)
    expect(parseCanvasOperation({ op: 'draw', elements: [] })).toEqual({
      ok: false,
      error: 'draw.elements 为空时必须设置 clear:true',
    })
  })

  test('rejects malformed envelopes', () => {
    expect(parseCanvasOperation({
      schemaVersion: 2,
      operationId: 'op-1',
      operation: { op: 'draw', elements: [{ type: 'text', x: 0, y: 0, text: 'a' }] },
    })).toEqual({ ok: false, error: '不支持 schemaVersion: 2' })
    expect(parseCanvasOperation({
      schemaVersion: 1,
      operation: { op: 'draw', elements: [{ type: 'text', x: 0, y: 0, text: 'a' }] },
    })).toEqual({ ok: false, error: 'operationId 必须是字符串' })
  })
})
