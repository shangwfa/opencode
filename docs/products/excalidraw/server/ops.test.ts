import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { createCanvas, getCanvas } from './canvas.ts'
import { applyBatch, splitJsonObjects } from './ops.ts'

const created: string[] = []

function canvas() {
  const value = createCanvas()
  created.push(value.id)
  return value
}

afterEach(() => {
  created.splice(0).forEach((id) => {
    const file = path.resolve(import.meta.dirname, 'data', `canvas-${id}.json`)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  })
})

describe('applyBatch', () => {
  test('applies legacy operations atomically', () => {
    const value = canvas()
    const result = applyBatch(value.id, [
      { op: 'draw', elements: [{ type: 'text', id: 'title', x: 0, y: 0, text: 'old' }] },
      { op: 'patch', id: 'title', text: 'new' },
    ])
    expect(result).toEqual({ applied: 2, skipped: 0, error: null })
    expect(getCanvas(value.id)?.elements.find((element) => element.id === 'title')?.text).toBe('new')
  })

  test('does not mutate when a later operation is invalid', () => {
    const value = canvas()
    const revision = getCanvas(value.id)!.revision
    const result = applyBatch(value.id, [
      { op: 'draw', elements: [{ type: 'text', id: 'title', x: 0, y: 0, text: 'new' }] },
      { op: 'patch', id: 'missing', text: 'bad' },
    ])
    expect(result.error).toBe('未找到元素: missing')
    expect(value.elements).toEqual([])
    expect(value.revision).toBe(revision)
  })

  test('discards a batch when a real mutator reports a bound-target error', () => {
    const value = canvas()
    expect(applyBatch(value.id, [{
      op: 'draw',
      elements: [{ type: 'rectangle', id: 'box', x: 0, y: 0, width: 100, height: 80, text: 'label' }],
    }]).error).toBeNull()
    const before = structuredClone(getCanvas(value.id)!)
    const label = before.elements.find((element) => element.containerId === 'box')!.id

    const result = applyBatch(value.id, [
      { op: 'delete', ids: ['box'] },
      { op: 'patch', id: label, text: 'changed' },
    ])

    expect(result).toEqual({ applied: 0, skipped: 0, error: `未找到元素: ${label}` })
    expect(getCanvas(value.id)).toEqual(before)
  })

  test('preserves legacy empty draw clear behavior', () => {
    const value = canvas()
    expect(applyBatch(value.id, [{
      op: 'draw',
      elements: [{ type: 'text', id: 'title', x: 0, y: 0, text: 'remove me' }],
    }]).error).toBeNull()

    expect(applyBatch(value.id, [{ op: 'draw', clear: true, elements: [] }])).toEqual({
      applied: 1,
      skipped: 0,
      error: null,
    })
    expect(getCanvas(value.id)?.elements).toEqual([])
  })

  test('propagates delete target errors without partial mutation', () => {
    const value = canvas()
    expect(applyBatch(value.id, [{
      op: 'draw',
      elements: [{ type: 'text', id: 'keep', x: 0, y: 0, text: 'keep' }],
    }]).error).toBeNull()
    const before = structuredClone(getCanvas(value.id)!)

    expect(applyBatch(value.id, [{ op: 'delete', ids: ['keep', 'missing'] }]).error).toBe('未找到元素: missing')
    expect(getCanvas(value.id)).toEqual(before)
  })

  test('rejects duplicate existing ids without mutation', () => {
    const value = canvas()
    expect(applyBatch(value.id, [{ op: 'draw', elements: [{ type: 'text', id: 'title', x: 0, y: 0, text: 'one' }] }]).error).toBeNull()
    const revision = getCanvas(value.id)!.revision
    const result = applyBatch(value.id, [{ op: 'draw', elements: [{ type: 'text', id: 'title', x: 0, y: 20, text: 'two' }] }])
    expect(result.error).toBe('元素 id 已存在: title')
    expect(getCanvas(value.id)?.revision).toBe(revision)
    expect(getCanvas(value.id)?.elements.filter((element) => element.id === 'title')).toHaveLength(1)
  })

  test('makes operation ids idempotent and enforces base revision', () => {
    const value = canvas()
    const operation = {
      schemaVersion: 1,
      operationId: 'once',
      baseRevision: value.revision,
      operation: { op: 'draw', elements: [{ type: 'text', id: 'title', x: 0, y: 0, text: 'one' }] },
    }
    expect(applyBatch(value.id, [operation])).toEqual({ applied: 1, skipped: 0, error: null })
    const revision = getCanvas(value.id)!.revision
    expect(applyBatch(value.id, [operation])).toEqual({ applied: 0, skipped: 1, error: null })
    expect(getCanvas(value.id)?.revision).toBe(revision)
    expect(applyBatch(value.id, [{ ...operation, operationId: 'stale' }]).error).toContain('revision conflict')
  })

  test('persists source checkpoints with the canvas record', () => {
    const value = canvas()
    applyBatch(value.id, [{ op: 'draw', clear: true, elements: [{ type: 'text', id: 't', x: 0, y: 0, text: 'a' }] }], { sourceId: 'session-1', offset: 42 })
    const stored = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'data', `canvas-${value.id}.json`), 'utf8'))
    expect(stored.sourceOffsets).toEqual({ 'session-1': 42 })
    expect(stored.schemaVersion).toBe(1)
  })

  test('card ops dodge overlapping placement', () => {
    const value = canvas()
    expect(applyBatch(value.id, [{ op: 'card', id: 'a', x: 200, y: 180, width: 800, title: '1. 背景', body: '一\n二\n三' }]).error).toBeNull()
    expect(applyBatch(value.id, [{ op: 'card', id: 'b', x: 200, y: 180, width: 800, title: '2. 目标', body: '一' }]).error).toBeNull()
    const elements = getCanvas(value.id)!.elements
    const a = elements.find((element) => element.id === 'a')!
    const b = elements.find((element) => element.id === 'b')!
    expect(b.y).toBeGreaterThanOrEqual((a.y as number) + (a.height as number) + 39)
  })

  test('cards in one batch dodge each other sequentially', () => {
    const value = canvas()
    const result = applyBatch(value.id, [
      { op: 'card', id: 'a', x: 200, y: 180, width: 800, title: '1', body: '一\n二\n三' },
      { op: 'card', id: 'b', x: 200, y: 180, width: 800, title: '2', body: '一' },
      { op: 'card', id: 'c', x: 200, y: 180, width: 800, title: '3', body: '一' },
    ])
    expect(result.error).toBeNull()
    const elements = getCanvas(value.id)!.elements
    const cards = ['a', 'b', 'c'].map((id) => elements.find((element) => element.id === id)!)
    for (let i = 1; i < cards.length; i++) {
      expect(cards[i].y as number).toBeGreaterThanOrEqual((cards[i - 1].y as number) + (cards[i - 1].height as number) + 39)
    }
  })
})

  test('arrows keep their placement coordinates', () => {
    const value = canvas()
    expect(applyBatch(value.id, [{
      op: 'draw',
      elements: [
        { type: 'rectangle', id: 'n1', x: 320, y: 100, width: 160, height: 60, text: '开始' },
        { type: 'rectangle', id: 'n2', x: 320, y: 220, width: 160, height: 60, text: '处理' },
        { type: 'arrow', id: 'e1', x: 400, y: 160, points: [[0, 0], [0, 60]] },
      ],
    }]).error).toBeNull()
    const arrow = getCanvas(value.id)!.elements.find((element) => element.id === 'e1')!
    expect(arrow.x).toBe(400)
    expect(arrow.y).toBe(160)
  })

  test('shape label alignment follows the declared textAlign', () => {
    const value = canvas()
    expect(applyBatch(value.id, [{
      op: 'draw',
      elements: [
        { type: 'rectangle', id: 'node', x: 200, y: 100, width: 160, height: 60, text: '开始' },
        { type: 'rectangle', id: 'cell', x: 200, y: 200, width: 200, height: 40, text: '状态列', textAlign: 'left' },
      ],
    }]).error).toBeNull()
    const elements = getCanvas(value.id)!.elements
    const node = elements.find((e) => e.id === 'node')!
    const nodeLabel = elements.find((e) => e.containerId === 'node')!
    // 默认居中：label 中心 ≈ shape 中心
    expect(Math.abs((nodeLabel.x as number) + (nodeLabel.width as number) / 2 - ((node.x as number) + (node.width as number) / 2))).toBeLessThan(2)
    const cellLabel = elements.find((e) => e.containerId === 'cell')!
    expect(cellLabel.x).toBe(212) // cell.x + 12 内边距
    expect(cellLabel.textAlign).toBe('left')
    // 移动 cell 后 label 仍保持左对齐定位
    expect(applyBatch(value.id, [{ op: 'patch', id: 'cell', x: 300 }]).error).toBeNull()
    const moved = getCanvas(value.id)!.elements.find((e) => e.containerId === 'cell')!
    expect(moved.x).toBe(312)
  })

  test('legacy mermaid canvas only allows clear redraw', () => {
    const value = canvas()
    const record = getCanvas(value.id)!
    record.state = 'mermaid'
    record.mermaid = 'graph TD\nA-->B'
    const before = structuredClone(getCanvas(value.id)!)

    // 非 clear 的增量 op 被拒
    expect(applyBatch(value.id, [{ op: 'draw', elements: [{ type: 'text', x: 0, y: 0, text: 't' }] }]).error).toContain('mermaid')
    expect(applyBatch(value.id, [{ op: 'patch', id: 'a', text: 'x' }]).error).toContain('mermaid')
    expect(getCanvas(value.id)).toEqual(before)

    // clear 重画放行并清掉 mermaid
    expect(applyBatch(value.id, [{ op: 'draw', clear: true, elements: [{ type: 'text', id: 't', x: 0, y: 0, text: 'new' }] }]).error).toBeNull()
    const redrawn = getCanvas(value.id)!
    expect(redrawn.mermaid).toBe('')
    expect(redrawn.state).toBe('manual')
  })

  describe('splitJsonObjects', () => {
  test('keeps incomplete trailing objects for the next poll', () => {
    const result = splitJsonObjects('{"op":"render","mermaid":"graph TD"}\n{"op":"draw"')
    expect(result.complete).toHaveLength(1)
    expect(result.consumedBytes).toBe(36)
  })

  test('consumes byte offsets for multibyte content', () => {
    const line = '{"op":"card","title":"五、功能模块","body":"一\\n二"}\n'
    const text = line + '{"op":"draw"'
    const result = splitJsonObjects(text)
    expect(result.complete).toHaveLength(1)
    // 结算到对象的 '}' 为止（尾部 \n 留给下次，tail 从 \n 起读无害）
    expect(result.consumedBytes).toBe(Buffer.byteLength(line, 'utf8') - 1)
  })

  test('skips garbage fragments without braces so a stuck offset can recover', () => {
    const garbage = '调度 / 机器人 / 监控 八大子系统'
    const result = splitJsonObjects(garbage)
    expect(result.complete).toHaveLength(0)
    expect(result.consumedBytes).toBe(Buffer.byteLength(garbage, 'utf8'))
  })
})
