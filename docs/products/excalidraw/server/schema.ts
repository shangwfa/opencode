import type { CardInput, DrawElement, PatchInput } from './canvas.ts'

export const CANVAS_SCHEMA_VERSION = 1

export type CanvasOp =
  | { op: 'draw'; elements: DrawElement[]; clear?: boolean }
  | ({ op: 'card' } & CardInput)
  | ({ op: 'patch' } & PatchInput)
  | { op: 'delete'; ids: string[] }

export interface CanvasOperation {
  schemaVersion: 1
  operationId?: string
  baseRevision?: number
  operation: CanvasOp
  legacy: boolean
}

export type ParseResult =
  | { ok: true; value: CanvasOperation }
  | { ok: false; error: string }

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function string(value: unknown, field: string, optional = false) {
  if (value === undefined && optional) return null
  if (typeof value !== 'string') return `${field} 必须是字符串`
  if (!value.trim()) return `${field} 不能为空`
  return null
}

function number(value: unknown, field: string, optional = false, positive = false) {
  if (value === undefined && optional) return null
  if (!finite(value)) return `${field} 必须是有限数字`
  if (positive && value <= 0) return `${field} 必须大于 0`
  return null
}

function optionalStrings(value: Record<string, unknown>, fields: string[]) {
  return fields.map((field) => string(value[field], field, true)).find((error) => error) ?? null
}

function optionalNumbers(value: Record<string, unknown>, fields: string[], positive = false) {
  return fields.map((field) => number(value[field], field, true, positive)).find((error) => error) ?? null
}

function parseDrawElement(value: unknown, index: number): string | null {
  if (!object(value)) return `elements[${index}] 必须是对象`
  const prefix = `elements[${index}]`
  const type = value.type
  if (!['rectangle', 'ellipse', 'diamond', 'text', 'line', 'arrow'].includes(String(type))) {
    return `${prefix}.type 不受支持`
  }
  if (value.textAlign !== undefined && !['left', 'center', 'right'].includes(String(value.textAlign))) {
    return `${prefix}.textAlign 必须是 left/center/right`
  }
  if (value.verticalAlign !== undefined && !['top', 'middle', 'bottom'].includes(String(value.verticalAlign))) {
    return `${prefix}.verticalAlign 必须是 top/middle/bottom`
  }
  const common = string(value.id, `${prefix}.id`, true) ??
    number(value.x, `${prefix}.x`) ??
    number(value.y, `${prefix}.y`) ??
    optionalStrings(value, ['backgroundColor', 'strokeColor', 'strokeStyle'])
  if (common) return common
  if (type === 'text') {
    return string(value.text, `${prefix}.text`) ?? number(value.fontSize, `${prefix}.fontSize`, true, true)
  }
  if (type === 'line' || type === 'arrow') {
    if (!Array.isArray(value.points) || value.points.length < 2) return `${prefix}.points 至少需要两个点`
    const invalid = value.points.findIndex(
      (point) => !Array.isArray(point) || point.length !== 2 || !finite(point[0]) || !finite(point[1]),
    )
    if (invalid >= 0) return `${prefix}.points[${invalid}] 必须是两个有限数字`
    if (value.endArrowhead !== undefined && value.endArrowhead !== 'arrow' && value.endArrowhead !== null) {
      return `${prefix}.endArrowhead 无效`
    }
    return null
  }
  return number(value.width, `${prefix}.width`, false, true) ??
    number(value.height, `${prefix}.height`, false, true) ??
    string(value.text, `${prefix}.text`, true) ??
    optionalStrings(value, ['textAlign', 'verticalAlign'])
}

function parseOperation(value: unknown): { ok: true; value: CanvasOp } | { ok: false; error: string } {
  if (!object(value)) return { ok: false, error: 'operation 必须是对象' }
  if (value.op === 'render') {
    // 产品已全面转向手绘 draw；旧 render 一律拒绝并引导（错误文案随 AI 下轮写入自然送达不了，但日志可查）
    return { ok: false, error: 'render/mermaid 已停用：所有图表请用 draw 手绘（shape 节点 + arrow 连线，布局法见 skill）' }
  }
  if (value.op === 'draw') {
    if (!Array.isArray(value.elements)) return { ok: false, error: 'draw.elements 必须是数组' }
    if (value.clear !== undefined && typeof value.clear !== 'boolean') return { ok: false, error: 'clear 必须是布尔值' }
    if (value.elements.length === 0 && value.clear !== true) {
      return { ok: false, error: 'draw.elements 为空时必须设置 clear:true' }
    }
    const error = value.elements.map(parseDrawElement).find((item) => item)
    if (error) return { ok: false, error }
    const ids = value.elements
      .map((element) => (element as Record<string, unknown>).id)
      .filter((id): id is string => typeof id === 'string')
    if (new Set(ids).size !== ids.length) return { ok: false, error: 'draw.elements 包含重复 id' }
    return { ok: true, value: value as CanvasOp }
  }
  if (value.op === 'card') {
    const error = string(value.id, 'id', true) ??
      number(value.x, 'x') ??
      number(value.y, 'y') ??
      number(value.width, 'width', false, true) ??
      optionalNumbers(value, ['height', 'titleFontSize', 'bodyFontSize', 'gap'], true) ??
      optionalStrings(value, ['title', 'body', 'backgroundColor'])
    if (error) return { ok: false, error }
    if (value.title === undefined && value.body === undefined) return { ok: false, error: 'card 至少需要 title 或 body' }
    return { ok: true, value: value as CanvasOp }
  }
  if (value.op === 'patch') {
    const error = string(value.id, 'id') ??
      string(value.text, 'text', true) ??
      optionalNumbers(value, ['x', 'y']) ??
      optionalNumbers(value, ['width', 'height', 'fontSize'], true) ??
      optionalStrings(value, ['backgroundColor', 'strokeColor'])
    if (error) return { ok: false, error }
    if (!['text', 'x', 'y', 'width', 'height', 'backgroundColor', 'strokeColor', 'fontSize'].some((field) => value[field] !== undefined)) {
      return { ok: false, error: 'patch 没有可修改字段' }
    }
    return { ok: true, value: value as CanvasOp }
  }
  if (value.op === 'delete') {
    if (!Array.isArray(value.ids) || value.ids.length === 0) return { ok: false, error: 'delete.ids 必须是非空数组' }
    if (value.ids.some((id) => typeof id !== 'string' || !id.trim())) return { ok: false, error: 'delete.ids 必须是非空字符串' }
    if (new Set(value.ids).size !== value.ids.length) return { ok: false, error: 'delete.ids 包含重复 id' }
    return { ok: true, value: value as CanvasOp }
  }
  return { ok: false, error: `未知 op: ${String(value.op)}` }
}

export function parseCanvasOperation(raw: unknown): ParseResult {
  if (!object(raw)) return { ok: false, error: 'canvas operation 必须是对象' }
  const enveloped = object(raw.operation) ||
    raw.schemaVersion !== undefined ||
    raw.operationId !== undefined ||
    raw.opId !== undefined ||
    raw.baseRevision !== undefined
  const operation = parseOperation(object(raw.operation) ? raw.operation : raw)
  if (!operation.ok) return operation
  if (!enveloped) {
    return { ok: true, value: { schemaVersion: 1, operation: operation.value, legacy: true } }
  }
  if (raw.schemaVersion !== CANVAS_SCHEMA_VERSION) return { ok: false, error: `不支持 schemaVersion: ${String(raw.schemaVersion)}` }
  const operationId = raw.operationId ?? raw.opId
  const operationIdError = string(operationId, 'operationId')
  if (operationIdError) return { ok: false, error: operationIdError }
  // AI 编造的 baseRevision（如新会话时写 0）不能整批拒绝——operationId 幂等已足够，忽略即可
  const baseRevision =
    raw.baseRevision !== undefined && Number.isSafeInteger(raw.baseRevision) && (raw.baseRevision as number) >= 1
      ? (raw.baseRevision as number)
      : undefined
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      operationId: operationId as string,
      baseRevision,
      operation: operation.value,
      legacy: false,
    },
  }
}
