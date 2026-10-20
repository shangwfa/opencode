import { useState } from "react"
import { providerIcon } from "@/lib/connectors"
import { cn } from "@/lib/utils"

const palettes = [
  "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "bg-violet-500/10 text-violet-700 dark:text-violet-400",
  "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
  "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  "bg-lime-500/10 text-lime-700 dark:text-lime-400",
]

function hash(value: string): number {
  let result = 0
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) >>> 0
  return result
}

export function ConnectorMark({
  service,
  name,
  iconUrl,
  homepageUrl,
  size = "md",
}: {
  service: string
  name: string
  iconUrl?: string
  homepageUrl?: string
  size?: "sm" | "md" | "lg"
}) {
  const [failed, setFailed] = useState(false)
  const initials = Array.from(name.replace(/[^\p{L}\p{N}]/gu, "")).slice(0, 2).join("").toUpperCase() || "?"
  const src = providerIcon({ iconUrl, homepageUrl })
  const dimensions = size === "sm" ? "size-7" : size === "lg" ? "size-12" : "size-9"
  const imageSize = size === "sm" ? "size-5" : size === "lg" ? "size-8" : "size-6"

  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg",
        src && !failed ? "border bg-white" : palettes[hash(service) % palettes.length],
        dimensions,
        !src || failed ? (size === "sm" ? "text-[10px]" : size === "lg" ? "text-sm" : "text-[11px]") : "",
        !src || failed ? "font-semibold" : "",
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className={cn("object-contain", imageSize)}
          onError={() => setFailed(true)}
        />
      ) : (
        initials
      )}
    </span>
  )
}
