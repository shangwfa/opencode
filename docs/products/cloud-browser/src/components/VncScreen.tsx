import { useEffect, useRef, useState } from 'react'
import RFB from '@novnc/novnc'
import type { RFBDisconnectEvent, RFBSecurityFailureEvent } from '@novnc/novnc'
import { Loader2, MonitorX } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent } from './ui/card'

interface Props {
  sandboxId: string
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

export default function VncScreen({ sandboxId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ConnectionState>('connecting')
  const [message, setMessage] = useState('正在连接云端浏览器...')

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const rfb = new RFB(
      container,
      `${protocol}://${window.location.host}/ws/vnc/${sandboxId}`,
    )
    rfb.scaleViewport = true
    rfb.resizeSession = false
    rfb.focusOnClick = true

    const onConnect = () => {
      setState('connected')
    }
    const onDisconnect = (event: RFBDisconnectEvent) => {
      setState(event.detail.clean ? 'disconnected' : 'error')
      setMessage(event.detail.clean ? '连接已断开' : 'VNC 连接失败')
    }
    const onSecurityFailure = (event: RFBSecurityFailureEvent) => {
      setState('error')
      setMessage(event.detail.reason || 'VNC 安全协商失败')
    }

    rfb.addEventListener('connect', onConnect)
    rfb.addEventListener('disconnect', onDisconnect)
    rfb.addEventListener('securityfailure', onSecurityFailure)

    return () => {
      rfb.removeEventListener('connect', onConnect)
      rfb.removeEventListener('disconnect', onDisconnect)
      rfb.removeEventListener('securityfailure', onSecurityFailure)
      rfb.disconnect()
      container.replaceChildren()
    }
  }, [sandboxId])

  const showOverlay = state !== 'connected'

  return (
    <div className="relative flex-1 bg-black">
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
                  <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
                    重新连接
                  </Button>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
