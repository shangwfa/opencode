import { useParams } from "react-router"
import { SkeletonPage } from "@/components/skeleton-page"

export function SessionPage() {
  const { sessionId } = useParams()
  return (
    <SkeletonPage
      title={`会话 ${sessionId ?? "-"}`}
      feature="src/pages/session.tsx + src/pages/session/composer/*（上游核心会话壳）"
      pending={["timeline 渲染（part: text/reasoning/tool）", "composer 发送/重试/权限应答", "diff 面板（@pierre/diffs）"]}
    />
  )
}
