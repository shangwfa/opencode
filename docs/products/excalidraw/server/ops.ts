import type { ServerConfig, SessionRecord } from './sessions.ts'
import { deleteElements, drawElements, getCanvas, patchElement, setMermaid } from './canvas.ts'
import type { DrawElement, PatchInput } from './canvas.ts'

// AI 写入 /workspace/canvas-ops.jsonl，一行一个 JSON op（允许多行 pretty JSON，按括号配平解析）
// {"op":"render","mermaid":"..."}      结构化图表全量（流程/架构/时序/ER/类/状态机）
// {"op":"draw","elements":[...]}       自由绘制追加（UI原型/文档/示意图），可带 clear
// {"op":"patch","id":"...","text":..}  增量修改单个元素（按 id）
// {"op":"delete","ids":[...]}          增量删除（按 id）

export type CanvasOp =
  | { op: 'render'; mermaid: string }
  | { op: 'draw'; elements: DrawElement[]; clear?: boolean }
  | { op: 'patch' } & PatchInput
  | { op: 'delete'; ids: string[] }

export function applyOp(canvasId: string, raw: unknown): string | null {
  const canvas = getCanvas(canvasId)
  if (!canvas) return 'canvas not found'
  const op = raw as CanvasOp
  try {
    if (op.op === 'render') {
      if (typeof op.mermaid !== 'string') return 'render 缺少 mermaid 字段'
      setMermaid(canvas, op.mermaid)
      return null
    }
    if (op.op === 'draw') {
      if (!Array.isArray(op.elements)) return 'draw 缺少 elements 数组'
      if (op.clear) canvas.elements = []
      drawElements(canvas, op.elements)
      return null
    }
    if (op.op === 'patch') {
      if (typeof op.id !== 'string') return 'patch 缺少 id'
      return patchElement(canvas, op as PatchInput)
    }
    if (op.op === 'delete') {
      if (!Array.isArray(op.ids)) return 'delete 缺少 ids 数组'
      return deleteElements(canvas, op.ids)
    }
    return `未知 op: ${String((op as { op?: string }).op)}`
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

// ---- exec 轮询器 ----

const OPS_FILE = '/workspace/canvas-ops.jsonl'
const POLL_MS = 500

interface PollerState {
  offset: number
  timer: ReturnType<typeof setInterval> | null
  emptyTicks: number
  execFailures: number
  ticking: boolean // 执行锁：防止 exec 慢时并发重放同一批 ops
}

const pollers = new Map<string, PollerState>()

async function exec(config: ServerConfig, saasSessionId: string, command: string): Promise<{ exitCode: number; stdout: string } | null> {
  try {
    const res = await fetch(`${config.saasBaseUrl}/session/${saasSessionId}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return null
    return (await res.json()) as { exitCode: number; stdout: string }
  } catch {
    return null
  }
}

async function tick(config: ServerConfig, session: SessionRecord, state: PollerState) {
  if (state.ticking) return
  state.ticking = true
  try {
    await doTick(config, session, state)
  } finally {
    state.ticking = false
  }
}

async function doTick(config: ServerConfig, session: SessionRecord, state: PollerState) {
  const result = await exec(
    config,
    session.saasSessionId,
    `tail -c +${state.offset} ${OPS_FILE} 2>/dev/null | head -c 200000`,
  )
  if (!result) {
    // 沙箱可能已被回收（AI 完成后 idle）或暂不可达
    state.execFailures++
    console.warn(`[ops] ${session.id} exec失败 ${state.execFailures}/5`)
    if (state.execFailures >= 5) stopPolling(session.id)
    return
  }
  state.execFailures = 0

  // AI 写的是多行 pretty-printed JSON——按"括号配平"切分成完整对象，而非按行
  const text = result.stdout
  const objects = splitJsonObjects(text)
  if (objects.complete.length === 0) {
    if (text.trim()) console.warn(`[ops] ${session.id} 拉到 ${text.length} 字节但未解析出完整对象: ${text.slice(0, 80)}`)
    // 长时空转才停（AI 可能长时间思考后才写 ops；exec 便宜，多等无害）
    state.emptyTicks++
    if (state.emptyTicks >= 600) stopPolling(session.id)
    return
  }
  state.emptyTicks = 0

  for (const op of objects.complete) {
    const err = applyOp(session.canvasId, op)
    console.log(`[ops] ${session.id} 应用 op: ${(op as {op?:string}).op} err=${err}`)
    if (err) console.warn(`[ops] ${session.id}: ${err}`)
  }
  // offset 按已消费的字符数推进（半截对象留到下次重读）
  if (objects.consumedChars > 0) state.offset += objects.consumedChars
}

// 从文本流中提取完整 JSON 对象（括号配平，容忍多行/半截）
function splitJsonObjects(text: string): { complete: unknown[]; consumedChars: number } {
  const complete: unknown[] = []
  let i = text.indexOf('{')
  let consumed = 0
  while (i >= 0) {
    let depth = 0
    let inString = false
    let escaped = false
    let j = i
    for (; j < text.length; j++) {
      const ch = text[j]
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{' || ch === '[') depth++
      if (ch === '}' || ch === ']') depth--
      if (depth === 0) break
    }
    if (depth === 0 && j < text.length) {
      try {
        complete.push(JSON.parse(text.slice(i, j + 1)))
        consumed = j + 1
      } catch {
        // 配平但解析失败（不应发生），跳过
      }
      i = text.indexOf('{', j + 1)
      continue
    }
    // 未配平：后续内容不完整，下次重读
    break
  }
  return { complete, consumedChars: consumed }
}

export function startPolling(config: ServerConfig, session: SessionRecord) {
  const existing = pollers.get(session.id)
  if (existing?.timer) return // 幂等：已在轮询
  console.log(`[ops] startPolling ${session.id} canvas=${session.canvasId} saas=${session.saasSessionId} offset=${existing?.offset ?? 1}`)
  const state: PollerState = {
    offset: existing?.offset ?? 1,
    timer: null,
    emptyTicks: 0,
    execFailures: 0,
    ticking: false,
  }
  pollers.set(session.id, state)
  state.timer = setInterval(() => void tick(config, session, state), POLL_MS)
}

export function stopPolling(sessionId: string) {
  const state = pollers.get(sessionId)
  if (!state) return
  if (state.timer) clearInterval(state.timer)
  pollers.set(sessionId, { ...state, timer: null })
}
