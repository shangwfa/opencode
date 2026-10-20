import * as React from "react"
import { cn } from "@/lib/utils"
import { XIcon } from "lucide-react"
import { registerToastHandler } from "@/ui/components/toast"

export type ToastItem = {
  id: number
  variant?: "default" | "destructive" | "error"
  title: string
  description?: string
}

type ToastInput = Omit<ToastItem, "id">

const ToastContext = React.createContext<(t: ToastInput) => void>(() => {})

export function useToast() {
  return React.useContext(ToastContext)
}

/** 极简 toast（Solid 版为 @/ui/components/toast；后续可换 sonner） */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([])
  const seq = React.useRef(0)

  const push = React.useCallback((t: ToastInput) => {
    const id = ++seq.current
    setItems((prev) => [...prev, { ...t, id }])
    window.setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.id !== id))
    }, 4000)
  }, [])

  // 注册到 showToast 桥：移植过来的纯逻辑文件可直接调 showToast（"error" 归一为 destructive 样式）
  React.useEffect(() => {
    registerToastHandler(push)
    return () => registerToastHandler(null)
  }, [push])

  const dismiss = (id: number) => setItems((prev) => prev.filter((i) => i.id !== id))

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-100 flex flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className={cn(
              "bg-card text-card-foreground pointer-events-auto flex w-80 flex-col gap-1 rounded-lg border p-4 shadow-lg",
              t.variant === "destructive" && "border-destructive/50",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm font-semibold">{t.title}</div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            {t.description ? (
              <div className="text-muted-foreground text-xs break-all">{t.description}</div>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
