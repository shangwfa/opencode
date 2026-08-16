import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// 画布状态模型：AI 产出 mermaid 文本；用户手动编辑后回传 elements 快照
// state = 'mermaid'：以 mermaid 为准（前端用官方库转换渲染）
// state = 'manual'：以用户编辑快照为准
export interface ExcalidrawElement {
  id: string
  type: string
  isDeleted?: boolean
  [key: string]: unknown
}

export interface CanvasRecord {
  id: string
  mermaid: string
  elements: ExcalidrawElement[]
  state: 'mermaid' | 'manual'
  revision: number
  updatedAt: string
}

const dataDir = path.resolve(import.meta.dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const canvases = new Map<string, CanvasRecord>()
const listeners = new Map<string, Set<(c: CanvasRecord) => void>>()

function fileOf(id: string) {
  return path.join(dataDir, `canvas-${id}.json`)
}

export function createCanvas(): CanvasRecord {
  const canvas: CanvasRecord = {
    id: crypto.randomUUID().slice(0, 8),
    mermaid: '',
    elements: [],
    state: 'mermaid',
    revision: 1,
    updatedAt: new Date().toISOString(),
  }
  canvases.set(canvas.id, canvas)
  persist(canvas)
  return canvas
}

export function getCanvas(id: string): CanvasRecord | undefined {
  if (canvases.has(id)) return canvases.get(id)
  const file = fileOf(id)
  if (!fs.existsSync(file)) return undefined
  const canvas = JSON.parse(fs.readFileSync(file, 'utf8')) as CanvasRecord
  canvases.set(id, canvas)
  return canvas
}

function persist(canvas: CanvasRecord) {
  canvas.updatedAt = new Date().toISOString()
  fs.writeFileSync(fileOf(canvas.id), JSON.stringify(canvas))
}

function commit(canvas: CanvasRecord) {
  canvas.revision++
  persist(canvas)
  for (const notify of listeners.get(canvas.id) ?? []) notify(canvas)
}

export function onCanvasUpdate(id: string, fn: (c: CanvasRecord) => void): () => void {
  if (!listeners.has(id)) listeners.set(id, new Set())
  listeners.get(id)!.add(fn)
  return () => listeners.get(id)!.delete(fn)
}

// AI 产出一版完整 mermaid（覆盖语义：最新版即全图）
export function setMermaid(canvas: CanvasRecord, mermaid: string) {
  canvas.mermaid = mermaid
  canvas.state = 'mermaid'
  canvas.elements = []
  commit(canvas)
}

// 用户手动编辑后的快照回传（不广播，避免回环）
export function syncElements(canvas: CanvasRecord, elements: ExcalidrawElement[]) {
  canvas.elements = elements
  canvas.state = 'manual'
  canvas.revision++
  persist(canvas)
}

// 给 AI 的画布上下文：当前 mermaid（manual 态时提示需基于快照重写）
export function canvasContextForAI(canvas: CanvasRecord): string | null {
  if (canvas.state === 'mermaid' && canvas.mermaid) return canvas.mermaid
  if (canvas.state === 'manual' && canvas.mermaid) {
    return `${canvas.mermaid}\n（注：用户在画布上手动调整过，以下 mermaid 是最近一版 AI 产出，输出新版本时尽量保留用户意图）`
  }
  return null
}

// ---- draw 模式：自由绘制元素（示意图/数据图/信息卡片），坐标由 AI 给定 ----

const rand = () => Math.floor(Math.random() * 2 ** 31)

function baseElement(type: string, partial: Partial<ExcalidrawElement>): ExcalidrawElement {
  return {
    id: crypto.randomUUID(),
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    roundness: null,
    seed: rand(),
    versionNonce: rand(),
    version: 1,
    isDeleted: false,
    groupIds: [],
    frameId: null,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...partial,
  }
}

// draw 元素 id 由 AI 提供时直接采用（Excalidraw 元素 id 是任意字符串），
// 后续 patch/delete 用同一 id 引用，实现增量修改
export type DrawElement =
  | { id?: string; type: 'rectangle' | 'ellipse' | 'diamond'; x: number; y: number; width: number; height: number; text?: string; backgroundColor?: string; strokeColor?: string }
  | { id?: string; type: 'text'; x: number; y: number; text: string; fontSize?: number; strokeColor?: string }
  | { id?: string; type: 'line' | 'arrow'; x: number; y: number; points: Array<[number, number]>; strokeColor?: string; strokeStyle?: string; endArrowhead?: 'arrow' | null }

const SHAPE_BG: Record<string, string> = {
  rectangle: '#a5d8ff',
  ellipse: '#b2f2bb',
  diamond: '#ffec99',
}
const SHAPE_ROUNDNESS: Record<string, unknown> = {
  rectangle: { type: 3 },
  ellipse: { type: 2 },
  diamond: null,
}

// 坐标约束：限制在合理画布范围并对齐网格，防止 AI 给的值飞出视野
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

// 文本尺寸估算：中文/全角按 fontSize（1倍），ASCII 按 0.55 倍
function textWidth(text: string, fontSize: number): number {
  return Math.max(
    ...text.split('\n').map((line) => {
      let w = 0
      for (const ch of line) {
        w += /[一-鿿＀-￯　-〿]/.test(ch) ? fontSize : fontSize * 0.55
      }
      return w
    }),
  )
}

// 给定容器宽度，估算文本换行后的行数（容器内边距 16px）
function wrapLines(text: string, fontSize: number, containerWidth: number): number {
  const usable = Math.max(20, containerWidth - 16)
  let lines = 0
  for (const line of text.split('\n')) {
    const w = textWidth(line, fontSize)
    lines += Math.max(1, Math.ceil(w / usable))
  }
  return lines
}

// 容器文本所需的最小高度
function textHeight(text: string, fontSize: number, containerWidth: number): number {
  return wrapLines(text, fontSize, containerWidth) * fontSize * 1.25 + 20
}

export function drawElements(canvas: CanvasRecord, elements: DrawElement[]) {
  for (const el of elements) {
    const x = clamp(Math.round(el.x / 10) * 10, -2000, 2000)
    const y = clamp(Math.round(el.y / 10) * 10, -2000, 2000)
    const id = el.id && !canvas.elements.some((e) => e.id === el.id) ? el.id : crypto.randomUUID()

    if (el.type === 'text') {
      const fontSize = el.fontSize ?? 20
      const lines = el.text.split('\n').length
      canvas.elements.push(
        baseElement('text', {
          id,
          x,
          y,
          width: textWidth(el.text, fontSize),
          height: lines * fontSize * 1.25, // 多行按行数撑高
          text: el.text,
          originalText: el.text,
          fontSize,
          fontFamily: 1,
          textAlign: 'left',
          verticalAlign: 'top',
          strokeColor: el.strokeColor ?? '#1e1e1e',
          lineHeight: 1.25,
          autoResize: true,
        }),
      )
      continue
    }

    if (el.type === 'line' || el.type === 'arrow') {
      canvas.elements.push(
        baseElement(el.type, {
          id,
          points: el.points,
          strokeColor: el.strokeColor ?? '#1e1e1e',
          strokeStyle: el.strokeStyle ?? 'solid',
          endArrowhead: el.type === 'arrow' ? (el.endArrowhead ?? 'arrow') : null,
          startArrowhead: null,
        }),
      )
      continue
    }

    // shape：rectangle / ellipse / diamond，可选容器文本
    const shapeEl = el as Extract<DrawElement, { type: 'rectangle' | 'ellipse' | 'diamond' }>
    // 容器尺寸自适应文本：宽度按单行最宽，高度按换行后行数，避免文案截断
    let shapeW = clamp(shapeEl.width, 20, 1200)
    let shapeH = clamp(shapeEl.height, 20, 1200)
    if (shapeEl.text) {
      const fontSize = 16
      shapeW = clamp(Math.max(shapeW, textWidth(shapeEl.text, fontSize) + 24), 20, 1200)
      shapeH = clamp(Math.max(shapeH, textHeight(shapeEl.text, fontSize, shapeW)), 20, 1200)
    }
    const shape = baseElement(shapeEl.type, {
      id: el.id && !canvas.elements.some((e) => e.id === el.id) ? el.id : crypto.randomUUID(),
      x,
      y,
      width: shapeW,
      height: shapeH,
      backgroundColor: shapeEl.backgroundColor ?? SHAPE_BG[shapeEl.type],
      strokeColor: shapeEl.strokeColor ?? '#1e1e1e',
      roundness: SHAPE_ROUNDNESS[shapeEl.type],
      boundElements: [],
    })
    if (shapeEl.text) {
      const label = baseElement('text', {
        x: shape.x,
        y: shape.y,
        width: shape.width,
        height: shape.height,
        text: shapeEl.text,
        originalText: shapeEl.text,
        fontSize: 16,
        fontFamily: 1,
        textAlign: 'center',
        verticalAlign: 'middle',
        containerId: shape.id,
        lineHeight: 1.25,
        autoResize: true,
      })
      shape.boundElements = [{ id: label.id, type: 'text' }]
      canvas.elements.push(shape, label)
    } else {
      canvas.elements.push(shape)
    }
  }
  canvas.state = 'manual'
  canvas.mermaid = ''
  canvas.revision++
  persist(canvas)
  for (const notify of listeners.get(canvas.id) ?? []) notify(canvas)
}

// ---- 增量修改：按 id patch / delete ----

export interface PatchInput {
  id: string
  text?: string
  x?: number
  y?: number
  width?: number
  height?: number
  backgroundColor?: string
  strokeColor?: string
  fontSize?: number
}

export function patchElement(canvas: CanvasRecord, patch: PatchInput): string | null {
  const el = canvas.elements.find((e) => e.id === patch.id && !e.isDeleted)
  if (!el) return `未找到元素: ${patch.id}`
  const { id, text, ...rest } = patch
  if (rest.x !== undefined) rest.x = clamp(Math.round(rest.x / 10) * 10, -2000, 2000)
  if (rest.y !== undefined) rest.y = clamp(Math.round(rest.y / 10) * 10, -2000, 2000)
  Object.assign(el, rest)
  el.version = ((el.version as number) ?? 0) + 1
  el.updated = Date.now()
  if (text !== undefined) {
    el.text = text
    el.originalText = text
    if (el.type === 'text' && !el.containerId) {
      // 独立文本：宽度按新文本重算
      el.width = textWidth(text, (el.fontSize as number) ?? 20)
    }
  }
  // 容器文本同步坐标（shape 移动时）
  if (rest.x !== undefined || rest.y !== undefined) {
    for (const bound of (el.boundElements as Array<{ id: string; type: string }> | null) ?? []) {
      if (bound.type !== 'text') continue
      const label = canvas.elements.find((e) => e.id === bound.id && !e.isDeleted)
      if (label) {
        label.x = el.x
        label.y = el.y
        label.version = ((label.version as number) ?? 0) + 1
        label.updated = Date.now()
      }
    }
  }
  canvas.state = 'manual'
  canvas.revision++
  persist(canvas)
  for (const notify of listeners.get(canvas.id) ?? []) notify(canvas)
  return null
}

export function deleteElements(canvas: CanvasRecord, ids: string[]): string | null {
  const missing: string[] = []
  for (const id of ids) {
    const el = canvas.elements.find((e) => e.id === id && !e.isDeleted)
    if (!el) {
      missing.push(id)
      continue
    }
    // 连带删除容器绑定文本
    const doomed = new Set([id])
    for (const bound of (el.boundElements as Array<{ id: string; type: string }> | null) ?? []) doomed.add(bound.id)
    for (const e of canvas.elements) {
      if (doomed.has(e.id) && !e.isDeleted) {
        e.isDeleted = true
        e.version = ((e.version as number) ?? 0) + 1
      }
    }
  }
  canvas.state = 'manual'
  canvas.revision++
  persist(canvas)
  for (const notify of listeners.get(canvas.id) ?? []) notify(canvas)
  return missing.length ? `未找到: ${missing.join(', ')}` : null
}

// 给 AI 的元素清单（增量修改时按 id 引用）
export function elementsSummary(canvas: CanvasRecord): string | null {
  const live = canvas.elements.filter((e) => !e.isDeleted)
  if (live.length === 0) return null
  return live
    .map((e) => {
      const label = e.type === 'text' ? ` "${String(e.text ?? '').slice(0, 20)}"` : ''
      return `- ${e.id} [${e.type}] @(${Math.round(e.x as number)},${Math.round(e.y as number)})${label}`
    })
    .join('\n')
}
