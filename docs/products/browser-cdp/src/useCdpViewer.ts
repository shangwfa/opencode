import { useCallback, useEffect, useRef, useState } from "react"

export interface TargetInfo {
  id: string
  title: string
  url: string
  type: string
}

export interface Frame {
  dataUrl: string
  width: number
  height: number
}

export type ViewerStatus = "idle" | "connecting" | "live" | "down"

interface CdpMessage {
  id?: number
  method?: string
  error?: { message: string }
  result?: Record<string, unknown>
  params?: {
    data?: string
    sessionId?: string
    metadata?: { deviceWidth?: number; deviceHeight?: number }
    frame?: { url?: string; parentId?: string }
  }
}

interface NavigationHistory {
  currentIndex: number
  entries: Array<{ id: number; url: string }>
}

const SCREENCAST_PARAMS = { format: "jpeg", quality: 65, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }

// CDP 连接生命周期：/cdp/:sessionId 同源代理 -> cdp-gateway -> Chromium
export function useCdpViewer(sessionId: string) {
  const [targets, setTargets] = useState<TargetInfo[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [status, setStatus] = useState<ViewerStatus>("idle")
  const [currentUrl, setCurrentUrl] = useState("")
  const [frame, setFrame] = useState<Frame | null>(null)
  const [fps, setFps] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const currentRef = useRef<string | null>(null)
  const msgIdRef = useRef(0)
  const pendingRef = useRef(new Map<number, (msg: CdpMessage) => void>())
  const frameCountRef = useRef(0)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const keepaliveTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const base = `/cdp/${sessionId}`

  const send = useCallback((method: string, params?: Record<string, unknown>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ id: ++msgIdRef.current, method, params }))
  }, [])

  const request = useCallback(
    <T = Record<string, unknown>,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      return new Promise((resolve, reject) => {
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          reject(new Error("cdp not connected"))
          return
        }
        const id = ++msgIdRef.current
        pendingRef.current.set(id, (msg) => {
          if (msg.error) reject(new Error(msg.error.message))
          else resolve((msg.result ?? {}) as T)
        })
        ws.send(JSON.stringify({ id, method, params }))
        setTimeout(() => {
          if (pendingRef.current.has(id)) {
            pendingRef.current.delete(id)
            reject(new Error(`cdp request timeout: ${method}`))
          }
        }, 10_000)
      })
    },
    [],
  )

  const loadTargets = useCallback(async (): Promise<TargetInfo[]> => {
    try {
      const res = await fetch(`${base}/json/list`, { cache: "no-store" })
      const all = (await res.json()) as TargetInfo[]
      const pages = all.filter((t) => t.type === "page")
      setTargets(pages)
      return pages
    } catch {
      return []
    }
  }, [base])

  const refreshHistory = useCallback(async () => {
    try {
      const history = await request<NavigationHistory>("Page.getNavigationHistory")
      const canBack = history.currentIndex > 0
      const canForward = history.currentIndex < history.entries.length - 1
      setCanGoBack(canBack)
      setCanGoForward(canForward)
      const current = history.entries[history.currentIndex]
      if (current?.url) setCurrentUrl(current.url)
    } catch {}
  }, [request])

  const stopScreencastLoop = useCallback(() => {
    if (keepaliveTimer.current) clearInterval(keepaliveTimer.current)
    keepaliveTimer.current = null
  }, [])

  const connect = useCallback(
    (targetId: string) => {
      currentRef.current = targetId
      setCurrentId(targetId)
      setStatus("connecting")
      setError(null)
      setFrame(null)
      setCanGoBack(false)
      setCanGoForward(false)
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)

      wsRef.current?.close()
      const proto = location.protocol === "https:" ? "wss://" : "ws://"
      const url = `${proto}${location.host}${base}/devtools/page/${targetId}`
      const ws = new WebSocket(url)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus("live")
        send("Page.enable")
        send("Runtime.enable")
        send("Page.startScreencast", SCREENCAST_PARAMS)
        void refreshHistory()
        stopScreencastLoop()
        // 导航等场景 screencast 可能停发，周期性重发兜底
        keepaliveTimer.current = setInterval(() => send("Page.startScreencast", SCREENCAST_PARAMS), 8000)
      }
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as CdpMessage
        if (msg.id && pendingRef.current.has(msg.id)) {
          const resolve = pendingRef.current.get(msg.id)!
          pendingRef.current.delete(msg.id)
          resolve(msg)
          return
        }
        if (msg.method === "Page.screencastFrame" && msg.params?.data) {
          setFrame({
            dataUrl: `data:image/jpeg;base64,${msg.params.data}`,
            width: msg.params.metadata?.deviceWidth ?? 1280,
            height: msg.params.metadata?.deviceHeight ?? 800,
          })
          frameCountRef.current++
          send("Page.screencastFrameAck", { sessionId: msg.params.sessionId })
        } else if (msg.method === "Page.frameNavigated" && msg.params?.frame && !msg.params.frame.parentId) {
          setCurrentUrl(msg.params.frame.url ?? "")
          void refreshHistory()
        } else if (msg.method === "Page.navigatedWithinDocument") {
          void refreshHistory()
        }
      }
      ws.onclose = () => {
        stopScreencastLoop()
        if (currentRef.current !== targetId) return
        setStatus("down")
        reconnectTimer.current = setTimeout(() => {
          if (currentRef.current === targetId) connect(targetId)
        }, 2000)
      }
      ws.onerror = () => ws.close()
    },
    [base, send, refreshHistory, stopScreencastLoop],
  )

  const switchTarget = useCallback(
    (targetId: string) => {
      currentRef.current = null // 阻断旧 ws 的自动重连
      wsRef.current?.close()
      loadTargets().then((pages) => {
        const target = pages.find((t) => t.id === targetId)
        setCurrentUrl(target?.url ?? "")
      })
      connect(targetId)
    },
    [connect, loadTargets],
  )

  const refreshTargets = useCallback(async () => {
    const pages = await loadTargets()
    if (!currentRef.current && pages.length) switchTarget(pages[0].id)
  }, [loadTargets, switchTarget])

  const navigate = useCallback(
    (url: string) => {
      const full = /^https?:\/\//.test(url) ? url : `https://${url}`
      setCurrentUrl(full)
      send("Page.navigate", { url: full })
    },
    [send],
  )

  const goBack = useCallback(async () => {
    const history = await request<NavigationHistory>("Page.getNavigationHistory")
    if (history.currentIndex > 0) {
      send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id })
    }
  }, [request, send])

  const goForward = useCallback(async () => {
    const history = await request<NavigationHistory>("Page.getNavigationHistory")
    if (history.currentIndex < history.entries.length - 1) {
      send("Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex + 1].id })
    }
  }, [request, send])

  const reload = useCallback(() => send("Page.reload", { ignoreCache: false }), [send])

  const screenshot = useCallback(async (): Promise<void> => {
    const { data } = await request<{ data: string }>("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
    })
    const bin = atob(data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const blob = new Blob([bytes], { type: "image/png" })
    const link = document.createElement("a")
    link.href = URL.createObjectURL(blob)
    link.download = `browser-cdp-${Date.now()}.png`
    link.click()
    URL.revokeObjectURL(link.href)
  }, [request])

  const newTab = useCallback(async () => {
    try {
      const res = await fetch(`${base}/json/new?about:blank`, { method: "PUT" })
      const target = (await res.json()) as TargetInfo
      await loadTargets()
      switchTarget(target.id)
    } catch (err) {
      setError(`新建标签页失败: ${String(err)}`)
    }
  }, [base, loadTargets, switchTarget])

  const closeTab = useCallback(
    async (targetId: string) => {
      try {
        await fetch(`${base}/json/close/${targetId}`)
      } catch {}
      const pages = await loadTargets()
      if (currentRef.current === targetId) {
        currentRef.current = null
        wsRef.current?.close()
        if (pages.length) connect(pages[0].id)
        else setFrame(null)
      }
    },
    [base, loadTargets, connect],
  )

  const dispatchMouse = useCallback(
    (type: string, x: number, y: number, opts: { button?: string; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }) => {
      send("Input.dispatchMouseEvent", { type, x, y, ...opts })
    },
    [send],
  )

  const dispatchKey = useCallback(
    (type: string, e: KeyboardEvent, extra?: { text?: string }) => {
      // CDP modifiers 掩码：Alt=1 Ctrl=2 Meta=4 Shift=8
      const modifiers = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0)
      send("Input.dispatchKeyEvent", {
        type,
        modifiers,
        windowsVirtualKeyCode: e.keyCode,
        nativeVirtualKeyCode: e.keyCode,
        code: e.code,
        key: e.key,
        autoRepeat: e.repeat,
        ...extra,
      })
    },
    [send],
  )

  useEffect(() => {
    let cancelled = false
    setStatus("connecting")
    const boot = async () => {
      let pages: TargetInfo[] = []
      for (let i = 0; i < 10 && !cancelled; i++) {
        pages = await loadTargets()
        if (pages.length) break
        await new Promise((r) => setTimeout(r, 1500))
      }
      if (!cancelled && pages.length) connect(pages[0].id)
      else if (!cancelled) setError("没有可用的 page target")
    }
    void boot()
    const fpsTimer = setInterval(() => {
      setFps(frameCountRef.current)
      frameCountRef.current = 0
    }, 10_000)
    const targetsTimer = setInterval(() => {
      if (!cancelled) void loadTargets()
    }, 15_000)
    return () => {
      cancelled = true
      clearInterval(fpsTimer)
      clearInterval(targetsTimer)
      stopScreencastLoop()
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      currentRef.current = null
      wsRef.current?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return {
    targets,
    currentId,
    status,
    currentUrl,
    frame,
    fps,
    error,
    canGoBack,
    canGoForward,
    switchTarget,
    refreshTargets,
    navigate,
    goBack,
    goForward,
    reload,
    screenshot,
    newTab,
    closeTab,
    dispatchMouse,
    dispatchKey,
  }
}
