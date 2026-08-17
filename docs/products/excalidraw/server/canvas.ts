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
  schemaVersion: 1
  mermaid: string
  elements: ExcalidrawElement[]
  state: 'mermaid' | 'manual'
  revision: number
  appliedOperationIds: string[]
  sourceOffsets: Record<string, number>
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
    schemaVersion: 1,
    mermaid: '',
    elements: [],
    state: 'mermaid',
    revision: 1,
    appliedOperationIds: [],
    sourceOffsets: {},
    updatedAt: new Date().toISOString(),
  }
  canvases.set(canvas.id, canvas)
  persistCanvas(canvas)
  return canvas
}

export function getCanvas(id: string): CanvasRecord | undefined {
  if (canvases.has(id)) return canvases.get(id)
  const file = fileOf(id)
  if (!fs.existsSync(file)) return undefined
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CanvasRecord> & Pick<CanvasRecord, 'id' | 'mermaid' | 'elements' | 'state' | 'revision' | 'updatedAt'>
  const canvas: CanvasRecord = {
    ...stored,
    schemaVersion: 1,
    appliedOperationIds: stored.appliedOperationIds ?? [],
    sourceOffsets: stored.sourceOffsets ?? {},
  }
  canvases.set(id, canvas)
  return canvas
}

export function persistCanvas(canvas: CanvasRecord, notify = false) {
  canvas.updatedAt = new Date().toISOString()
  fs.writeFileSync(fileOf(canvas.id), JSON.stringify(canvas))
  canvases.set(canvas.id, canvas)
  if (notify) for (const listener of listeners.get(canvas.id) ?? []) listener(canvas)
}

export function onCanvasUpdate(id: string, fn: (c: CanvasRecord) => void): () => void {
  if (!listeners.has(id)) listeners.set(id, new Set())
  listeners.get(id)!.add(fn)
  return () => listeners.get(id)!.delete(fn)
}

// 给 AI 的画布上下文：manual 态给元素清单；旧 mermaid 画布提示需 clear 重画（render 已停用）
export function canvasContextForAI(canvas: CanvasRecord): string | null {
  if (canvas.state === 'manual') return elementsSummary(canvas)
  if (canvas.mermaid.trim()) {
    return '画布当前是一张旧版 mermaid 图，无法增量修改。若用户要改它，请用 {"op":"draw","clear":true,...} 手绘重画等价内容后再做修改'
  }
  return null
}

// 用户手动编辑后的快照回传（不广播，避免回环）
export function syncElements(canvas: CanvasRecord, elements: ExcalidrawElement[]) {
  canvas.elements = elements
  canvas.state = 'manual'
  canvas.revision++
  persistCanvas(canvas)
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
  | { id?: string; type: 'rectangle' | 'ellipse' | 'diamond'; x: number; y: number; width: number; height: number; text?: string; backgroundColor?: string; strokeColor?: string; textAlign?: 'left' | 'center' | 'right'; verticalAlign?: 'top' | 'middle' | 'bottom' }
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
// 上限 6000：长文档（十几张卡）垂直累计可达 3000+，2000 会截断
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
const clampX = (v: number) => clamp(Math.round(v / 10) * 10, -2000, 6000)

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

// 容器文本定位：按对齐参数把文字实际尺寸对准 shape（内边距 12）
const SHAPE_PAD = 12

function placeLabel(shape: ExcalidrawElement, tw: number, th: number, align: string, valign: string): { x: number; y: number } {
  const sx = shape.x as number
  const sy = shape.y as number
  const sw = shape.width as number
  const sh = shape.height as number
  const x = align === 'left' ? sx + SHAPE_PAD : align === 'right' ? sx + sw - tw - SHAPE_PAD : sx + sw / 2 - tw / 2
  const y = valign === 'top' ? sy + SHAPE_PAD : valign === 'bottom' ? sy + sh - th - SHAPE_PAD : sy + sh / 2 - th / 2
  return { x, y }
}

// 容器文本同步坐标（shape 移动时）：按 label 自身的对齐参数重算
export function realignLabels(canvas: CanvasRecord, el: ExcalidrawElement) {
  for (const bound of (el.boundElements as Array<{ id: string; type: string }> | null) ?? []) {
    if (bound.type !== 'text') continue
    const label = canvas.elements.find((e) => e.id === bound.id && !e.isDeleted)
    if (!label) continue
    const pos = placeLabel(
      el,
      label.width as number,
      label.height as number,
      (label.textAlign as string) ?? 'center',
      (label.verticalAlign as string) ?? 'middle',
    )
    label.x = pos.x
    label.y = pos.y
    label.version = ((label.version as number) ?? 0) + 1
    label.updated = Date.now()
  }
}

export function drawElements(canvas: CanvasRecord, elements: DrawElement[], save = true) {
  for (const el of elements) {
    const x = clampX(el.x)
    const y = clampX(el.y)
    const id = el.id && !canvas.elements.some((e) => e.id === el.id) ? el.id : crypto.randomUUID()

    if (el.type === 'text') {
      // 正文用 Excalifont（正常体，可读性），标题保留手写风格
      const fontSize = el.fontSize ?? 18
      const fontFamily = fontSize >= 22 ? 1 : 5
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
          fontFamily,
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
          x,
          y,
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
      const fontSize = 16
      // 容器文本按对齐参数精确定位（默认居中，流程图节点常用；表格/标签类可传 left/top）
      const align = shapeEl.textAlign ?? 'center'
      const valign = shapeEl.verticalAlign ?? 'middle'
      const tw = textWidth(shapeEl.text, fontSize)
      const th = shapeEl.text.split('\n').length * fontSize * 1.25
      const pos = placeLabel(shape, tw, th, align, valign)
      const label = baseElement('text', {
        x: pos.x,
        y: pos.y,
        width: tw,
        height: th,
        text: shapeEl.text,
        originalText: shapeEl.text,
        fontSize,
        fontFamily: 5,
        textAlign: align,
        verticalAlign: valign,
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
  if (save) persistCanvas(canvas, true)
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

export function patchElement(canvas: CanvasRecord, patch: PatchInput, save = true): string | null {
  const el = canvas.elements.find((e) => e.id === patch.id && !e.isDeleted)
  if (!el) return `未找到元素: ${patch.id}`
  const { id, text, ...rest } = patch
  if (rest.x !== undefined) rest.x = clampX(rest.x)
  if (rest.y !== undefined) rest.y = clampX(rest.y)
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
  // 容器文本定位：按对齐参数把文字实际尺寸对准 shape（内边距 12）
  if (rest.x !== undefined || rest.y !== undefined) realignLabels(canvas, el)
  canvas.state = 'manual'
  canvas.revision++
  if (save) persistCanvas(canvas, true)
  return null
}

export function deleteElements(canvas: CanvasRecord, ids: string[], save = true): string | null {
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
  if (save) persistCanvas(canvas, true)
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

// ---- card 复合 op：卡片内排版由 server 按文本实际尺寸计算，消除内容重叠 ----

export interface CardInput {
  id?: string
  x: number
  y: number
  width: number
  height?: number
  title?: string
  body?: string
  titleFontSize?: number
  bodyFontSize?: number
  backgroundColor?: string
  gap?: number
}

// 卡片实际高度（与 drawCard 排版一致）：标题行 + 正文换行 + 上下内边距
export function measureCardHeight(input: CardInput): number {
  const width = clamp(input.width, 120, 1200)
  const titleFs = input.titleFontSize ?? 22
  const bodyFs = input.bodyFontSize ?? 16
  const gap = input.gap ?? 12
  let cursor = 24 // pad
  if (input.title) cursor += titleFs * 1.25 + gap
  if (input.body) cursor += textHeight(input.body, bodyFs, width - 48)
  return Math.max(input.height ?? 0, cursor + 24)
}

// sanitize：AI 给的卡片 y 只是期望起点，与已有元素碰撞时自动下移避让（文档卡片垂直堆叠语义）
const CARD_GAP = 40

export function resolveCardPlacement(canvas: CanvasRecord, input: CardInput): CardInput {
  const x = clampX(input.x)
  const width = clamp(input.width, 120, 1200)
  const height = measureCardHeight(input)
  let y = clampX(input.y)
  const solids = canvas.elements.filter((e) => !e.isDeleted && e.type !== 'line' && e.type !== 'arrow')
  for (let i = 0; i < 20; i++) {
    const hit = solids.find(
      (e) =>
        x < (e.x as number) + (e.width as number) &&
        x + width > (e.x as number) &&
        y < (e.y as number) + (e.height as number) &&
        y + height > (e.y as number),
    )
    if (!hit) break
    y = clamp(Math.round(((hit.y as number) + (hit.height as number) + CARD_GAP) / 10) * 10, -2000, 6000)
  }
  return { ...input, x, y }
}

export function drawCard(canvas: CanvasRecord, input: CardInput, save = true) {
  const id = input.id && !canvas.elements.some((e) => e.id === input.id) ? input.id : crypto.randomUUID()
  const x = clampX(input.x)
  const y = clampX(input.y)
  const width = clamp(input.width, 120, 1200)
  const pad = 24
  const titleFs = input.titleFontSize ?? 22
  const bodyFs = input.bodyFontSize ?? 16
  const gap = input.gap ?? 12

  let cursor = y + pad
  const inner: ExcalidrawElement[] = []

  if (input.title) {
    inner.push(
      baseElement('text', {
        id: `${id}-title`,
        x: x + pad,
        y: cursor,
        width: textWidth(input.title, titleFs),
        height: titleFs * 1.25,
        text: input.title,
        originalText: input.title,
        fontSize: titleFs,
        fontFamily: 1, // 标题保留手写风
        textAlign: 'left',
        verticalAlign: 'top',
        lineHeight: 1.25,
        autoResize: true,
      }),
    )
    cursor += titleFs * 1.25 + gap
  }

  if (input.body) {
    const bodyH = textHeight(input.body, bodyFs, width - pad * 2)
    inner.push(
      baseElement('text', {
        id: `${id}-body`,
        x: x + pad,
        y: cursor,
        width: width - pad * 2,
        height: bodyH,
        text: input.body,
        originalText: input.body,
        fontSize: bodyFs,
        fontFamily: 5, // 正文正常体
        textAlign: 'left',
        verticalAlign: 'top',
        lineHeight: 1.25,
        autoResize: true,
      }),
    )
    cursor += bodyH
  }

  const height = measureCardHeight(input)
  const card = baseElement('rectangle', {
    id,
    x,
    y,
    width,
    height,
    backgroundColor: input.backgroundColor ?? '#f8f9fa',
    strokeColor: '#adb5bd',
    roundness: { type: 3 },
  })
  // 卡片垫底：插到最前（渲染在内容下方）
  canvas.elements.unshift(card)
  canvas.elements.push(...inner)
  canvas.state = 'manual'
  canvas.mermaid = ''
  canvas.revision++
  if (save) persistCanvas(canvas, true)
}
