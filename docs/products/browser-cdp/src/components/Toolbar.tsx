import { useState } from "react"
import type { TargetInfo, ViewerStatus } from "@/useCdpViewer"

interface ToolbarProps {
  targets: TargetInfo[]
  currentId: string | null
  status: ViewerStatus
  currentUrl: string
  fps: number
  onSwitch: (id: string) => void
  onRefresh: () => void
  onNewTab: () => void
  onCloseTab: () => void
  onNavigate: (url: string) => void
}

const STATUS_TEXT: Record<ViewerStatus, string> = {
  idle: "未连接",
  connecting: "连接中…",
  live: "已连接",
  down: "已断开(重连中)",
}

export function Toolbar(props: ToolbarProps) {
  const [urlInput, setUrlInput] = useState("")
  const dot = props.status === "live" ? "bg-emerald-500" : props.status === "down" ? "bg-red-500" : "bg-amber-500"

  return (
    <header className="flex flex-none flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
      <span className={`size-2.5 flex-none rounded-full ${dot}`} title={STATUS_TEXT[props.status]} />
      <select
        className="max-w-56 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
        value={props.currentId ?? ""}
        onChange={(e) => props.onSwitch(e.target.value)}
      >
        {props.targets.length === 0 && <option value="">无标签页</option>}
        {props.targets.map((t) => (
          <option key={t.id} value={t.id}>
            {(t.title || t.url).slice(0, 60)}
          </option>
        ))}
      </select>
      <button className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm hover:bg-zinc-700" onClick={props.onRefresh}>
        刷新
      </button>
      <button className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm hover:bg-zinc-700" onClick={props.onNewTab}>
        新标签
      </button>
      <button
        className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm hover:bg-zinc-700 disabled:opacity-40"
        disabled={!props.currentId}
        onClick={props.onCloseTab}
      >
        关闭
      </button>
      <form
        className="flex min-w-40 flex-1 items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault()
          if (urlInput.trim()) props.onNavigate(urlInput.trim())
        }}
      >
        <input
          className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200 placeholder:text-zinc-600"
          placeholder={props.currentUrl || "输入 URL 导航"}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
        />
        <button className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm hover:bg-zinc-700" type="submit">
          打开
        </button>
      </form>
      <span className="flex-none text-xs text-zinc-600">{props.fps} 帧/10s</span>
    </header>
  )
}
