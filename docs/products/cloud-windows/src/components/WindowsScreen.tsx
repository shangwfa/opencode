import { useEffect, useState } from 'react'
import { Loader2, MonitorOff, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'

interface Props {
  sandboxId: string
  onRebuild?: () => Promise<void>
}

export default function WindowsScreen({ sandboxId, onRebuild }: Props) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rebuilding, setRebuilding] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/sandboxes/${sandboxId}`)
      .then((res) => {
        if (!res.ok) return res.json().then((b: { error?: string }) => { throw new Error(b.error || `HTTP ${res.status}`) })
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sandboxId])

  async function handleRebuild() {
    if (!onRebuild || rebuilding) return
    setRebuilding(true)
    setError(null)
    try {
      await onRebuild()
      setLoading(true)
      const res = await fetch(`/api/sandboxes/${sandboxId}`)
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `HTTP ${res.status}`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
      setRebuilding(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <MonitorOff className="size-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{error}</p>
        {onRebuild && (
          <Button variant="outline" onClick={handleRebuild} disabled={rebuilding}>
            {rebuilding ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            重建 Windows
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="relative h-full w-full bg-black">
      <iframe
        src={`/api/sandboxes/${sandboxId}/vnc/`}
        title="Windows Desktop"
        className="h-full w-full border-0"
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </div>
  )
}
