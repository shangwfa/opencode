import { useEffect, useState } from "react"
import {
  ChevronDown,
  ListTree,
} from "lucide-react"
import { Streamdown } from "streamdown"
import type { TaskInfo, Message, ApiMessage } from "../types"
import { streamdownPlugins } from "../constants"
import { normalizeMessages } from "../utils"
import { apiRequest } from "../api"

export function TaskCard({ task, parentSessionId }: { task: TaskInfo; parentSessionId: string }) {
  const running = task.status === "running" || task.status === "pending"
  const [open, setOpen] = useState(running)
  const [childId, setChildId] = useState(task.childId)
  const [childMessages, setChildMessages] = useState<Message[]>([])

  useEffect(() => {
    if (running) setOpen(true)
  }, [running])
  useEffect(() => {
    if (task.childId) setChildId(task.childId)
  }, [task.childId])

  useEffect(() => {
    if (!open) return
    let stopped = false
    let timer = 0
    async function load() {
      let cid = childId
      if (!cid) {
        try {
          const children = await apiRequest<Array<{ id: string; title?: string }>>(
            `/session/${parentSessionId}/children`,
          )
          const match =
            children.find((child) => task.description && child.title?.startsWith(task.description)) ??
            children[children.length - 1]
          if (match) {
            cid = match.id
            setChildId(cid)
          }
        } catch {
          // 子会话尚未创建，下一轮继续
        }
      }
      if (cid) {
        try {
          const remote = await apiRequest<ApiMessage[]>(`/session/${cid}/message`)
          if (!stopped) setChildMessages(normalizeMessages(remote))
        } catch {
          // 转录拉取失败，下一轮继续
        }
      }
      if (!stopped && running) timer = window.setTimeout(load, 2000)
    }
    void load()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [open, childId, running, parentSessionId, task.description])

  const visibleMessages = childMessages.filter((message) => message.role !== "user")
  return (
    <div className={`task-card ${running ? "running" : ""}`}>
      <button type="button" className="task-card-head" onClick={() => setOpen((current) => !current)}>
        <ListTree size={14} />
        <span className="task-desc">{task.description ?? "子任务"}</span>
        {task.subagent && <em>@{task.subagent}</em>}
        <span className={`task-status ${task.status ?? "running"}`}>
          {running ? "执行中" : task.status === "completed" ? "已完成" : (task.status ?? "")}
        </span>
        <ChevronDown size={12} className={`task-chevron ${open ? "open" : ""}`} />
      </button>
      {open && (
        <div className="task-card-body">
          {visibleMessages.map((message) =>
            message.role === "tool" ? (
              <div className="subtask-tool" key={message.id}>
                {message.text}
              </div>
            ) : (
              <div className="subtask-msg" key={message.id}>
                <span className="subtask-agent">{message.agent}</span>
                {message.reasoning && (
                  <details className="subtask-reasoning">
                    <summary>思考过程</summary>
                    <div>{message.reasoning}</div>
                  </details>
                )}
                {message.text && (
                  <div className="markdown-content">
                    <Streamdown plugins={streamdownPlugins}>{message.text}</Streamdown>
                  </div>
                )}
              </div>
            ),
          )}
          {running && visibleMessages.length === 0 && <div className="subtask-loading">子任务执行中…</div>}
        </div>
      )}
    </div>
  )
}
