import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

type SkeletonPageProps = {
  title: string
  feature: string
  pending: string[]
}

/** 骨架页统一模板：说明该域已规划、核心逻辑待迁移（见 MIGRATION.md） */
export function SkeletonPage({ title, feature, pending }: SkeletonPageProps) {
  return (
    <div className="space-y-4 overflow-y-auto p-6">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            迁移状态 <Badge variant="secondary">骨架就绪 · 逻辑待迁</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">源功能域：{feature}</p>
          <ul className="list-disc space-y-1 pl-5">
            {pending.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
