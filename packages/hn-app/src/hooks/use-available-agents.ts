/**
 * 可用 agent 列表（从 SaaS 读取）。
 * 用途：阶段配置里的 agent（如 specer）由 harness 注入，本地/精简环境可能不存在，
 * 此时回退到 build，避免会话卡在“思考中”。
 */
import { useEffect, useState } from "react"
import { opencodeSaasBaseUrl } from "@/utils/opencode-saas-base"

export function useAvailableAgents(): string[] {
  const [names, setNames] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    void fetch(`${opencodeSaasBaseUrl().replace(/\/+$/, "")}/agent`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: unknown) => {
        if (!alive || !Array.isArray(data)) return
        const list = data
          .map((x) => (x && typeof x === "object" ? (x as { name?: unknown }).name : undefined))
          .filter((x): x is string => typeof x === "string")
        setNames(list)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  return names
}

/** 首选 agent 不在可用列表时回退 build（列表为空视为未知，保持原值） */
export function pickAvailableAgent(preferred: string | undefined, available: string[]): string {
  const target = preferred?.trim() || "build"
  if (available.length === 0) return target
  if (available.includes(target)) return target
  return available.includes("build") ? "build" : available[0]!
}
