import { cn } from "@/lib/utils"

export { cn }

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground",
        className,
      )}
      aria-label="loading"
    />
  )
}
