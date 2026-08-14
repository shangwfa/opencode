import { useState } from "react"
import { RefreshCw, Settings } from "lucide-react"
import type { LocalAgentHealth } from "../types"
import { getSaasBase, setSaasBase } from "../api"
import { Button } from "@/components/ui/button"

interface AgentStatusProps {
  agent: LocalAgentHealth | null
  connected: boolean
  onRefresh: () => void
}

export function AgentStatus({ agent, connected, onRefresh }: AgentStatusProps) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState(getSaasBase())

  return (
    <div className="flex items-center gap-3">
      {agent ? (
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className="size-2 rounded-full bg-emerald-500" />
          本地 Agent：{agent.workdir}
          {!connected && <span className="text-muted-foreground">（未连接 SaaS）</span>}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-muted-foreground/40" />
          未检测到本地 Agent（:17790）
        </span>
      )}
      <button
        onClick={onRefresh}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="刷新"
      >
        <RefreshCw className="size-3.5" />
      </button>
      <button
        onClick={() => {
          setUrl(getSaasBase())
          setOpen(true)
        }}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="SaaS 服务地址"
      >
        <Settings className="size-3.5" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOpen(false)}
        >
          <div
            className="w-96 rounded-xl border bg-card p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-3 text-sm font-semibold">SaaS 服务地址</h3>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:14096"
              className="mb-3 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/50"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  setSaasBase(url)
                  setOpen(false)
                  onRefresh()
                }}
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
