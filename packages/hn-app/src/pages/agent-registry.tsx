import { SkeletonPage } from "@/components/skeleton-page"

export function AgentRegistryPage() {
  return (
    <SkeletonPage
      title="Agent 注册表"
      feature="src/api/agent-registry/ + src/pages/agent-registry/"
      pending={["注册表 CRUD 界面", "by-id 解析（resolveAgentRegistryNames 已移植并测试通过）"]}
    />
  )
}
