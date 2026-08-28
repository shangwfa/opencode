import { useCallback, useEffect, useState } from "react"
import { Viewer } from "./components/Viewer"

interface SessionEntry {
  id: string
  title: string
  timeUpdated: number | null
  sandbox: { image?: string } | null
}

interface SessionStatus {
  sessionId: string
  sandboxId: string | null
  sandbox: { image?: string } | null
  ready: boolean
}

interface Config {
  image: string
  saasBaseUrl: string
}

export default function App() {
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [currentSid, setCurrentSid] = useState<string>("")
  const [status, setStatus] = useState<SessionStatus | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [image, setImage] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } })
    const body = await res.json()
    if (!res.ok) throw new Error(String((body as { error?: string }).error ?? res.status))
    return body as T
  }, [])

  const loadSessions = useCallback(async () => {
    setSessions(await api("/api/sessions"))
  }, [api])

  const loadStatus = useCallback(
    async (sid: string) => {
      if (!sid) return undefined
      try {
        setStatus(await api<SessionStatus>(`/api/sessions/${sid}/status`))
      } catch {
        setStatus(null)
      }
    },
    [api],
  )

  useEffect(() => {
    void (async () => {
      const cfg = await api<Config>("/api/config")
      setConfig(cfg)
      setImage(cfg.image)
      await loadSessions()
    })().catch((err) => setMessage(`初始化失败: ${String(err)}`))
  }, [api, loadSessions])

  useEffect(() => {
    if (!currentSid) return
    void loadStatus(currentSid)
    const timer = setInterval(() => void loadStatus(currentSid), 5000)
    return () => clearInterval(timer)
  }, [currentSid, loadStatus])

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setMessage(null)
    try {
      await fn()
    } catch (err) {
      setMessage(`${label}失败: ${String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const createSession = () =>
    run("创建会话", async () => {
      const created = await api<{ sessionId: string; ready: boolean; error: string | null }>("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ image: image.trim() || undefined }),
      })
      await loadSessions()
      setCurrentSid(created.sessionId)
      setMessage(created.ready ? "会话就绪，浏览器已启动" : `会话已创建但未就绪: ${created.error ?? "unknown"}`)
    })

  const startBrowser = () =>
    run("启动浏览器", async () => {
      const result = await api<{ ready: boolean }>(`/api/sessions/${currentSid}/browser/start`, { method: "POST" })
      await loadStatus(currentSid)
      setMessage(result.ready ? "浏览器已启动" : "浏览器启动命令已执行，但 CDP 未就绪")
    })

  const stopBrowser = () =>
    run("停止浏览器", async () => {
      await api(`/api/sessions/${currentSid}/browser/stop`, { method: "POST" })
      await loadStatus(currentSid)
    })

  const killSandbox = () =>
    run("销毁沙箱", async () => {
      await api(`/api/sessions/${currentSid}/sandbox`, { method: "DELETE" })
      await loadStatus(currentSid)
      setMessage("沙箱已销毁（keepAlive 仍生效，可用「启动浏览器」重新 boot）")
    })

  const ready = status?.ready ?? false

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
      <header className="flex flex-none flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        <h1 className="mr-2 text-sm font-semibold text-zinc-100">browser-cdp 测试台</h1>
        <select
          className="max-w-72 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
          value={currentSid}
          onChange={(e) => setCurrentSid(e.target.value)}
        >
          <option value="">选择会话…</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || s.id}
              {s.sandbox?.image ? ` — ${s.sandbox.image.split("/").pop()}` : ""}
            </option>
          ))}
        </select>
        <input
          className="w-64 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm placeholder:text-zinc-600"
          placeholder={`镜像（默认 ${config?.image ?? ""}）`}
          value={image}
          onChange={(e) => setImage(e.target.value)}
        />
        <button
          className="rounded border border-emerald-700 bg-emerald-800 px-3 py-1 text-sm hover:bg-emerald-700 disabled:opacity-40"
          disabled={busy !== null}
          onClick={createSession}
        >
          {busy === "创建会话" ? "创建中…" : "新建会话"}
        </button>
        <button
          className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-sm hover:bg-zinc-700 disabled:opacity-40"
          disabled={!currentSid || busy !== null}
          onClick={startBrowser}
        >
          启动浏览器
        </button>
        <button
          className="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-sm hover:bg-zinc-700 disabled:opacity-40"
          disabled={!currentSid || busy !== null}
          onClick={stopBrowser}
        >
          停止
        </button>
        <button
          className="rounded border border-red-900 bg-red-950 px-3 py-1 text-sm hover:bg-red-900 disabled:opacity-40"
          disabled={!currentSid || busy !== null}
          onClick={killSandbox}
        >
          销毁沙箱
        </button>
        <span className="text-xs text-zinc-500">
          {currentSid ? `CDP: ${ready ? "就绪" : "未就绪"}` : `SaaS: ${config?.saasBaseUrl ?? "…"}`}
        </span>
      </header>

      {message && (
        <div className="flex-none bg-zinc-900 px-4 py-1.5 text-xs text-amber-300">
          {message}
          <button className="ml-2 text-zinc-500 hover:text-zinc-300" onClick={() => setMessage(null)}>
            ×
          </button>
        </div>
      )}

      {currentSid && ready ? (
        <Viewer key={currentSid} sessionId={currentSid} />
      ) : (
        <main className="flex flex-1 items-center justify-center">
          <p className="text-sm text-zinc-600">
            {currentSid ? "CDP 未就绪：点击「启动浏览器」，或等待沙箱完成创建。" : "选择或新建一个会话开始测试。"}
          </p>
        </main>
      )}
    </div>
  )
}
