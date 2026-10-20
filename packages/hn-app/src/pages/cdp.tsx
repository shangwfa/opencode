import { SkeletonPage } from "@/components/skeleton-page"

export function CdpPage() {
  return (
    <SkeletonPage
      title="浏览器 CDP"
      feature="src/features/browser-cdp/（BrowserPanel / use-cdp-viewer / PublishScriptDialog）"
      pending={["CDP viewer WebSocket", "BrowserView 面板", "发布脚本对话框（line-diff 已移植并测试通过）"]}
    />
  )
}
