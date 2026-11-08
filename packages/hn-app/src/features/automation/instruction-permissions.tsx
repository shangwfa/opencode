import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { baseFetch } from "@/lib/base-api"

type Request = { id: string; action: string; resources: readonly string[]; message?: string }

/** 只显示本会话尚未答复的请求；用户必须针对具体动作亲自决定。 */
export function InstructionPermissions({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [requests, setRequests] = useState<Request[]>([])
  const [error, setError] = useState("")
  const [replying, setReplying] = useState("")
  useEffect(() => {
    if (!active) { setRequests([]); return }
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await baseFetch<{ data: Request[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/permissions`)
        if (!stopped) { setRequests(result.data ?? []); setError("") }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!stopped) timer = setTimeout(poll, 2500)
      }
    }
    void poll()
    return () => { stopped = true; clearTimeout(timer) }
  }, [active, sessionId])

  const answer = async (id: string, decision: "once" | "reject") => {
    setReplying(id)
    setError("")
    try {
      await baseFetch(`/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(id)}/reply`, {
        method: "POST", body: JSON.stringify({ decision }),
      })
      setRequests((current) => current.filter((request) => request.id !== id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setReplying("")
    }
  }

  if (!requests.length && !error) return null
  return <div aria-label="本次执行待确认权限" className="mt-3 space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">
    <p className="font-semibold">AI 正在等待你确认工具操作</p>
    <p>请逐项核对操作和目标；允许仅对本次请求生效。</p>
    {requests.map((request) => <div key={request.id} className="space-y-2 rounded-md border border-amber-200 bg-white p-2">
      <p className="font-medium">操作：{request.action}</p>
      {request.message && <p className="whitespace-pre-wrap break-words">{request.message}</p>}
      <p className="break-all">目标：{request.resources.length ? request.resources.join("、") : "未指定目标，请谨慎确认"}</p>
      <div className="flex gap-2">
        <Button size="sm" disabled={!!replying} onClick={() => void answer(request.id, "once")}>仅本次允许</Button>
        <Button size="sm" variant="outline" disabled={!!replying} onClick={() => void answer(request.id, "reject")}>拒绝</Button>
      </div>
    </div>)}
    {error && <p role="alert" className="break-words text-destructive">无法获取或回复权限请求：{error}</p>}
  </div>
}
