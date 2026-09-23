import { BookOpen, Bug, FileText, Flame } from "lucide-react"

interface WelcomeScreenProps {
  onPrompt: (text: string) => void
}

const SUGGESTIONS = [
  {
    icon: BookOpen,
    color: "bg-blue-50 text-blue-600",
    title: "查询 Mastra 文档",
    prompt: "用 mastra skill 告诉我 Mastra 是什么，Agent 和 Workflow 的区别",
  },
  {
    icon: Flame,
    color: "bg-orange-50 text-orange-600",
    title: "TDD 红绿循环",
    prompt: "用 tdd skill 在 /workspace/calc 写一个 add(a, b) 函数，严格按 red-green-refactor 循环",
  },
  {
    icon: Bug,
    color: "bg-green-50 text-green-600",
    title: "系统化 Debug",
    prompt: "用 diagnosing-bugs skill 帮我排查一个偶发失败的测试，按 6 步循环走",
  },
  {
    icon: FileText,
    color: "bg-pink-50 text-pink-600",
    title: "生成演讲大纲",
    prompt: "用 humanize-ppt skill 把一段素材做成 AST 演讲大纲",
  },
]

export function WelcomeScreen({ onPrompt }: WelcomeScreenProps) {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">
        Skills 测试台
      </h1>
      <p className="mt-2 text-sm text-gray-400">
        注册技能后发消息测试，或在右侧配置技能后从下面的场景开始
      </p>

      <div className="mt-10 grid w-full grid-cols-2 gap-3">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            onClick={() => onPrompt(s.prompt)}
            className="group flex items-center gap-3 rounded-2xl border border-gray-200 bg-white p-4 text-left transition-all hover:border-gray-300 hover:shadow-sm"
          >
            <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${s.color}`}>
              <s.icon className="h-4.5 w-4.5" />
            </span>
            <span className="flex-1 text-sm font-medium text-gray-700">{s.title}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
