import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import type { RFBDisconnectEvent, RFBSecurityFailureEvent } from '@novnc/novnc'
import { Loader2, MonitorX } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'

interface Props {
  sandboxId: string
  onRebuild?: () => Promise<void>
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export default function VncScreen({ sandboxId, onRebuild }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [message, setMessage] = useState('正在连接云端浏览器...')
  const [retryCount, setRetryCount] = useState(0)
  const [sandboxGone, setSandboxGone] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    setState('connecting')
    setMessage('正在连接云端浏览器...')
    setSandboxGone(false)

    let rfb: RFB | null = null
    let cancelled = false

    async function connect() {
      try {
        const res = await fetch(`/api/sandboxes/${sandboxId}`)
        if (cancelled) return
        if (!res.ok) {
          setSandboxGone(true)
          setState('error')
          setMessage('浏览器沙箱已过期或被销毁')
          return
        }
      } catch {
        if (!cancelled) {
          setState('error')
          setMessage('无法连接服务器')
        }
        return
      }

      if (cancelled) return
      const target = containerRef.current
      if (!target) return

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
      rfb = new RFB(
        target,
        `${protocol}://${window.location.host}/ws/vnc/${sandboxId}`,
      )
      rfb.scaleViewport = true
      rfb.resizeSession = false
      rfb.focusOnClick = true

      rfb.addEventListener('connect', () => setState('connected'))
      rfb.addEventListener('disconnect', (event) => {
        const detail = (event as RFBDisconnectEvent).detail
        setState(detail.clean ? 'disconnected' : 'error')
        setMessage(detail.clean ? '连接已断开' : 'VNC 连接失败')
      })
      rfb.addEventListener('securityfailure', (event) => {
        const detail = (event as RFBSecurityFailureEvent).detail
        setState('error')
        setMessage(detail.reason || 'VNC 安全协商失败')
      })
    }

    connect()

    return () => {
      cancelled = true
      rfb?.disconnect()
      container.replaceChildren()
    }
  }, [sandboxId, retryCount])

  const showOverlay = state !== 'connected'

  return (
    <div className="relative flex-1 bg-white">
      <div ref={containerRef} className="h-full w-full" />
      {showOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/95">
          <Card className="w-full max-w-sm border-none shadow-none">
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              {state === 'connecting' ? (
                <>
                  <Loader2 className="size-8 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{message}</p>
                </>
              ) : (
                <>
                  <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
                    <MonitorX className="size-6 text-destructive" />
                  </div>
                  <p className="text-sm text-muted-foreground">{message}</p>
                  {sandboxGone && onRebuild ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={rebuilding}
                      onClick={async () => {
                        setRebuilding(true)
                        try {
                          await onRebuild()
                        } finally {
                          setRebuilding(false)
                        }
                      }}
                    >
                      {rebuilding && <Loader2 className="size-3 animate-spin" />}
                      重建浏览器
                    </Button>
                  ) : (
                    !sandboxGone && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRetryCount((c) => c + 1)}
                      >
                        重新连接
                      </Button>
                    )
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
