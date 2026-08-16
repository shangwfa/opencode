import { useEffect, useRef, useState } from 'react'
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw'
import '@excalidraw/excalidraw/index.css'

interface Props {
  canvasId: string | null
  onSaasEvent: (type: string) => void
}

const STEP_MS = 120

// 官方管线两步：解析 mermaid 得到骨架 → 转完整元素（缺第二步会因缺字段崩溃）
// files 回调：image 元素（解析降级为 SVG 图片时）需要 files 数据
async function renderMermaid(
  mermaid: string,
  onFiles?: (files: never) => void,
): Promise<ExcalidrawElement[]> {
  const convert = async (def: string) => {
    const result = await parseMermaidToExcalidraw(def)
    if (result.files && onFiles) onFiles(result.files as never)
    return convertToExcalidrawElements(result.elements) as ExcalidrawElement[]
  }
  try {
    return await convert(mermaid)
  } catch (err) {
    // subgraph 解析失败（如中文标题等边界情况）→ 去掉 subgraph 外壳降级为平面图重试
    if (String(err).includes('SubGraph')) {
      const flat = mermaid
        .split('\n')
        .filter((l) => !/^\s*subgraph\b/i.test(l) && !/^\s*end\s*$/.test(l))
        .join('\n')
      return convert(flat)
    }
    throw err
  }
}

export default function CanvasPanel({ canvasId, onSaasEvent }: Props) {
  const [excalidrawAPI, setExcalidrawAPI] = useState<ExcalidrawImperativeAPI | null>(null)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  apiRef.current = excalidrawAPI

  const sceneRef = useRef<ExcalidrawElement[]>([])
  const queueRef = useRef<ExcalidrawElement[]>([])
  const animatingRef = useRef(false)
  const lastStateRef = useRef<'mermaid' | 'manual' | null>(null)
  const lastMermaidRef = useRef('')
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!canvasId) return
    sceneRef.current = []
    queueRef.current = []
    animatingRef.current = false
    lastStateRef.current = null
    lastMermaidRef.current = ''
    const source = new EventSource(`/api/canvas/${canvasId}/stream`)
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as {
          type?: string
          state?: 'mermaid' | 'manual'
          mermaid?: string
          elements?: ExcalidrawElement[]
        }
        if (data.type === 'canvas.update') {
          onCanvasUpdate(data.state ?? 'mermaid', data.mermaid ?? '', data.elements ?? [])
          return
        }
        if (data.type?.startsWith('message.') || data.type === 'session.idle' || data.type === 'session.status') {
          onSaasEvent(data.type ?? '')
        }
      } catch {
        // ignore malformed events
      }
    }
    return () => source.close()
  }, [canvasId])

  async function onCanvasUpdate(state: 'mermaid' | 'manual', mermaid: string, elements: ExcalidrawElement[]) {
    const api = apiRef.current
    if (!api) return

    if (state === 'manual') {
      // 用户编辑快照：直接渲染，无动画
      queueRef.current = []
      animatingRef.current = false
      sceneRef.current = elements
      lastStateRef.current = 'manual'
      api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER })
      return
    }

    // mermaid 态：同一版本不重复转换
    if (mermaid === lastMermaidRef.current && lastStateRef.current === 'mermaid') return
    lastMermaidRef.current = mermaid
    lastStateRef.current = 'mermaid'

    if (!mermaid.trim()) {
      queueRef.current = []
      animatingRef.current = false
      sceneRef.current = []
      api.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER })
      return
    }

    let converted: ExcalidrawElement[]
    let files: Parameters<ExcalidrawImperativeAPI['addFiles']>[0] | null = null
    try {
      converted = await renderMermaid(mermaid, (f) => { files = f })
    } catch (err) {
      console.warn('[canvas] mermaid 转换失败（保持现状）:', err)
      return
    }
    if (files) api.addFiles(files)

    // 与当前画布 diff：新版本若与现有元素同源（官方转换确定性 id），只入场新增部分
    const sceneIds = new Set(sceneRef.current.map((e) => e.id))
    const added = converted.filter((e) => !sceneIds.has(e.id))

    if (added.length === 0 && converted.length > 0) {
      sceneRef.current = converted
      api.updateScene({ elements: converted, captureUpdate: CaptureUpdateAction.NEVER })
      api.scrollToContent(converted, { fitToContent: true, animate: true, duration: 400 })
      return
    }

    if (sceneRef.current.length === 0) {
      // 首版：逐个入场
      queueRef.current = [...converted]
    } else {
      // 后续版本：全量替换 + 平滑视角（图生长效果）
      sceneRef.current = converted
      api.updateScene({ elements: converted, captureUpdate: CaptureUpdateAction.NEVER })
      api.scrollToContent(converted, { fitToContent: true, animate: true, duration: 400 })
      return
    }

    if (!animatingRef.current) playNext()
  }

  // 逐个添加入场：元素短暂选中高亮，像正在"画"
  function playNext() {
    const next = queueRef.current.shift()
    const api = apiRef.current
    if (!next || !api) {
      animatingRef.current = false
      const els = sceneRef.current.filter((e) => !e.isDeleted)
      if (els.length > 0) api?.scrollToContent(els, { fitToContent: true, animate: true, duration: 400 })
      return
    }
    animatingRef.current = true
    sceneRef.current = [...sceneRef.current, next]
    api.updateScene({
      elements: sceneRef.current,
      appState: { selectedElementIds: { [next.id]: true } },
      captureUpdate: CaptureUpdateAction.NEVER,
    })
    setTimeout(playNext, STEP_MS)
  }

  // 用户手动编辑 → 防抖回传快照（入场动画期间不回传）
  function handleChange(elements: readonly { id: string }[]) {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      if (!canvasId || animatingRef.current) return
      if (lastStateRef.current === 'mermaid' && sceneRef.current.length === 0) return
      const current = elements as ExcalidrawElement[]
      const sceneIds = sceneRef.current.map((e) => e.id).join(',')
      const liveIds = current.map((e) => e.id).join(',')
      if (sceneIds === liveIds) return
      sceneRef.current = current
      lastStateRef.current = 'manual'
      fetch(`/api/canvas/${canvasId}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: current }),
      }).catch(() => {})
    }, 800)
  }

  if (!canvasId) {
    return (
      <div className="flex h-full flex-1 items-center justify-center bg-muted/20 text-muted-foreground">
        <div className="text-center text-sm">
          <div className="mb-2 text-4xl">🎨</div>
          选择或新建一个会话，画布将在这里呈现
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex-1">
      <Excalidraw
        excalidrawAPI={(api) => setExcalidrawAPI(api)}
        onChange={(elements) => handleChange(elements)}
        UIOptions={{ canvasActions: { loadScene: false } }}
      />
    </div>
  )
}
