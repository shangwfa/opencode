import { useEffect, useState } from "react"
import {
  ChevronDown,
  Sparkles,
} from "lucide-react"

export function ReasoningBlock({ reasoning, finished }: { reasoning: string; finished?: boolean }) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (finished) setOpen(false)
  }, [finished])
  return (
    <details className={`reasoning-block ${open ? "open" : ""}`} open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault()
          setOpen((current) => !current)
        }}
      >
        <Sparkles size={15} className="reasoning-mark" />
        <span>{finished ? "已思考" : "思考中"}</span>
        <ChevronDown size={12} className="reasoning-chevron" />
      </summary>
      <div className="reasoning-content">{reasoning}</div>
    </details>
  )
}
