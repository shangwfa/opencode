import { Link } from "react-router"
import { Button } from "@/components/ui/button"

export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <div className="text-muted-foreground text-4xl font-semibold">404</div>
      <p className="text-muted-foreground text-sm">页面不存在</p>
      <Button asChild variant="outline" size="sm">
        <Link to="/">返回首页</Link>
      </Button>
    </div>
  )
}
