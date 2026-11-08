import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react"
import { browserApi, readBrowserFrames, type BrowserTarget } from "@/lib/browser"
import { BaseApiError } from "@/lib/base-api"

export type ViewerFrame = { data: string; metadata?: { deviceWidth?: number; deviceHeight?: number } }
type History = { currentIndex: number; entries: Array<{ id: number; url: string }> }

export function useCdpViewer(sessionId: string) {
  const [targets, setTargets] = useState<BrowserTarget[]>([])
  const [selection, setSelection] = useState({ sessionId, id: "" })
  const target = selection.sessionId === sessionId ? selection.id : ""
  const setTarget = useCallback(
    (value: SetStateAction<string>) =>
      setSelection((current) => ({
        sessionId,
        id: typeof value === "function" ? value(current.sessionId === sessionId ? current.id : "") : value,
      })),
    [sessionId],
  )
  const [frame, setFrame] = useState<ViewerFrame | null>(null)
  const [status, setStatus] = useState("connecting")
  const [error, setError] = useState("")
  const [history, setHistory] = useState<History>({ currentIndex: -1, entries: [] })
  const [restartKey, setRestartKey] = useState(0)
  const active = useRef(true)
  const startup = useRef<{ key: string; promise: Promise<unknown> } | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    active.current = true
    setTarget("")
    setFrame(null)
    setError("")
    setStatus("connecting")
    const refresh = async () => {
      try {
        const { items } = await browserApi.targets(sessionId)
        if (stopped) return
        setTargets(items)
        setTarget((current) => (items.some((item) => item.id === current) ? current : (items[0]?.id ?? "")))
        if (!items.length) setStatus("empty")
      } catch (cause) {
        if (!stopped) {
          setError(String(cause instanceof Error ? cause.message : cause))
          setStatus("down")
        }
      } finally {
        if (!stopped) timer = setTimeout(refresh, 3000)
      }
    }
    // StrictMode 的 effect 重放不能重复发起沙箱 shell；这里只复用本次挂载的启动请求。
    const key = `${sessionId}:${restartKey}`
    if (startup.current?.key !== key) startup.current = { key, promise: browserApi.start(sessionId) }
    void startup.current.promise
      .then(() => {
        if (!stopped) return refresh()
      })
      .catch((cause) => {
        if (stopped) return
        // 404 = 该会话没有浏览器会话记录（接口/脚本创建的任务不启动浏览器），不是连接故障。
        if (cause instanceof BaseApiError && cause.status === 404) {
          setStatus("unavailable")
          setError("")
          return
        }
        setError(String(cause instanceof Error ? cause.message : cause))
        setStatus("down")
      })
    return () => {
      stopped = true
      active.current = false
      clearTimeout(timer)
    }
  }, [sessionId, restartKey])

  useEffect(() => {
    if (!target) return
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout>
    setFrame(null)
    setHistory({ currentIndex: -1, entries: [] })
    const connect = async () => {
      setStatus("connecting")
      try {
        const response = await browserApi.frames(sessionId, target, controller.signal)
        await readBrowserFrames(response, (raw) => {
          if (controller.signal.aborted) return
          const value = raw as ViewerFrame
          if (typeof value.data === "string") {
            setFrame(value)
            setStatus("live")
            setError("")
          }
        })
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!controller.signal.aborted) {
          setStatus("down")
          retry = setTimeout(connect, 2000)
        }
      }
    }
    let checking = false
    const refreshHistory = async () => {
      if (checking) return
      checking = true
      try {
        const result = await browserApi.command<History>(sessionId, target, "Page.getNavigationHistory")
        if (!controller.signal.aborted) setHistory(result)
      } catch {
        /* 断线期间由画面流负责显示错误 */
      } finally {
        checking = false
      }
    }
    void connect()
    void refreshHistory()
    const historyTimer = setInterval(refreshHistory, 3000)
    return () => {
      controller.abort()
      clearTimeout(retry)
      clearInterval(historyTimer)
    }
  }, [sessionId, target, restartKey])

  const command = useCallback(
    async (method: string, params: Record<string, unknown> = {}) => {
      if (!target) return
      try {
        return await browserApi.command(sessionId, target, method, params)
      } catch (cause) {
        if (active.current) setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [sessionId, target],
  )

  return {
    targets,
    target,
    setTarget,
    frame,
    status,
    error,
    history,
    command,
    url: history.entries[history.currentIndex]?.url ?? targets.find((item) => item.id === target)?.url ?? "",
    restart: () => setRestartKey((key) => key + 1),
    openTab: async (url: string) => {
      const tab = await browserApi.openTab(sessionId, url)
      setTargets((items) => [...items, tab])
      setTarget(tab.id)
    },
    closeTab: async (id: string) => {
      await browserApi.closeTab(sessionId, id)
      setTargets((items) => items.filter((item) => item.id !== id))
      setTarget((current) => (current === id ? "" : current))
    },
  }
}
