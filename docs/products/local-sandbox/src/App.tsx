import { useCallback, useEffect, useState } from "react"
import { MessageSquare } from "lucide-react"
import type { LocalAgentHealth, SessionInfo } from "./types"
import * as api from "./api"
import { Sidebar } from "./components/Sidebar"
import { Chat } from "./components/Chat"
import { AgentStatus } from "./components/AgentStatus"

const MODEL_KEY = "local-sandbox:model"
const DEFAULT_MODEL: api.ModelRef = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }

function loadModel(): api.ModelRef {
  try {
    const raw = localStorage.getItem(MODEL_KEY)
    if (raw) return JSON.parse(raw) as api.ModelRef
  } catch {
    // ignore
  }
  return DEFAULT_MODEL
}

export default function App() {
  const [agent, setAgent] = useState<LocalAgentHealth | null>(null)
  const [agentConnected, setAgentConnected] = useState(false)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeID, setActiveID] = useState<string | null>(null)
  const [localBound, setLocalBound] = useState<Set<string>>(new Set())
  const [creating, setCreating] = useState(false)
  const [saasError, setSaasError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: "error" | "info"; text: string } | null>(null)
  const [model, setModel] = useState<api.ModelRef>(loadModel)

  const notify = useCallback((text: string, type: "error" | "info" = "info") => {
    setToast({ type, text })
    setTimeout(() => setToast(null), 4000)
  }, [])

  const refreshAgent = useCallback(async () => {
    const [health, agents] = await Promise.all([
      api.detectLocalAgent(),
      api.listAgents().catch(() => [] as Array<{ agentID: string; boundSessions?: string[] }>),
    ])
    setAgent(health)
    setAgentConnected(!!health && agents.some((a) => a.agentID === health.agentID))
    // 从 SaaS 恢复会话绑定状态（agent 重连/前端刷新后 boundSessions 仍在）
    const bound = agents.flatMap((a) => a.boundSessions ?? [])
    if (bound.length > 0) {
      setLocalBound((prev) => {
        const next = new Set(bound)
        for (const id of prev) next.add(id)
        return next
      })
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await api.listSessions())
      setSaasError(null)
    } catch (err) {
      setSaasError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    refreshAgent()
    refreshSessions()
    const timer = setInterval(refreshAgent, 5000)
    return () => clearInterval(timer)
  }, [refreshAgent, refreshSessions])

  async function handleCreate() {
    if (creating) return
    setCreating(true)
    try {
      const session = await api.createSession(`会话 ${new Date().toLocaleTimeString()}`)
      if (agent?.agentID && agentConnected) {
        try {
          await api.bindLocalAgent(session.id, agent.agentID)
          setLocalBound((prev) => new Set(prev).add(session.id))
        } catch (err) {
          notify(`绑定本地 Agent 失败：${err instanceof Error ? err.message : err}`, "error")
        }
      }
      setSessions((prev) => [session, ...prev])
      setActiveID(session.id)
    } catch (err) {
      notify(`创建会话失败：${err instanceof Error ? err.message : err}`, "error")
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(sessionID: string) {
    setSessions((prev) => prev.filter((s) => s.id !== sessionID))
    if (activeID === sessionID) setActiveID(null)
    try {
      await api.deleteSession(sessionID)
    } catch (err) {
      notify(`删除会话失败：${err instanceof Error ? err.message : err}`, "error")
      refreshSessions()
    }
  }

  function handleModelChange(next: api.ModelRef) {
    setModel(next)
    localStorage.setItem(MODEL_KEY, JSON.stringify(next))
  }

  const sandboxMode = activeID ? (localBound.has(activeID) ? "local" : "remote") : null

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 shrink-0 items-center justify-between border-b px-5">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" />
          <span className="text-[13px] font-semibold tracking-tight">Local Sandbox</span>
          {saasError && (
            <span className="text-[11px] text-red-500">SaaS 连接失败：{saasError.slice(0, 80)}</span>
          )}
        </div>
        <AgentStatus
          agent={agent}
          connected={agentConnected}
          onRefresh={() => {
            refreshAgent()
            refreshSessions()
          }}
        />
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 border-r bg-sidebar">
          <Sidebar
            sessions={sessions}
            activeSessionID={activeID}
            localBound={localBound}
            creating={creating}
            onSelect={(s) => setActiveID(s.id)}
            onCreate={handleCreate}
            onDelete={handleDelete}
          />
        </aside>
        <main className="min-w-0 flex-1">
          <Chat sessionID={activeID} sandboxMode={sandboxMode} model={model} onModelChange={handleModelChange} />
        </main>
      </div>

      {toast && (
        <div className="fixed right-4 top-14 z-50">
          <div
            className={
              "rounded-lg border px-4 py-2 text-sm shadow-lg " +
              (toast.type === "error"
                ? "border-red-200 bg-red-50 text-red-600"
                : "border-border bg-card")
            }
          >
            {toast.text}
          </div>
        </div>
      )}
    </div>
  )
}
