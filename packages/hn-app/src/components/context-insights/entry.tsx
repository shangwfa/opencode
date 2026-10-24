import { lazy, Suspense } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

export const LazySessionInsights = lazy(() => import("./session-insights").then((module) => ({ default: module.SessionInsights })))

export function ContextDialog({ sessionID, open, onOpenChange }: { sessionID: string; open: boolean; onOpenChange: (value: boolean) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent aria-describedby={undefined} className="h-[90dvh] max-w-[95vw] overflow-y-auto sm:max-w-6xl"><DialogTitle className="sr-only">Context insights</DialogTitle>{open && <Suspense fallback={<p role="status">…</p>}><LazySessionInsights key={sessionID} sessionID={sessionID} embedded /></Suspense>}</DialogContent></Dialog>
}
