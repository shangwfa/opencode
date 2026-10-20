import { createContext, useContext, useMemo, type ReactNode } from "react"
import { opencodeSaasBaseUrl } from "@/utils/opencode-saas-base"

/**
 * OpenCode 服务上下文（React 版，纯 REST，无 SDK）。
 * directory 为沙箱工作目录（路由 :dir 参数，进入会话页时切换）。
 * REST 封装见 @/lib/rest。
 */
export type ServerContextValue = {
  baseUrl: string
  directory: string
}

const ServerContext = createContext<ServerContextValue | null>(null)

export function ServerProvider({ directory, children }: { directory?: string; children: ReactNode }) {
  const value = useMemo(
    () => ({ baseUrl: opencodeSaasBaseUrl(), directory: directory ?? "" }),
    [directory],
  )
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>
}

export function useSDK(): ServerContextValue {
  const ctx = useContext(ServerContext)
  if (!ctx) throw new Error("useSDK must be used within ServerProvider")
  return ctx
}
