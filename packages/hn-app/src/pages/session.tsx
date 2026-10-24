import { useParams } from "react-router"
import { Suspense } from "react"
import { LazySessionInsights } from "@/components/context-insights/entry"

export function SessionPage() {
  const { sessionId } = useParams()
  return <div className="h-full overflow-y-auto"><Suspense fallback={<p role="status">…</p>}>{sessionId && <LazySessionInsights key={sessionId} sessionID={sessionId} />}</Suspense></div>
}
