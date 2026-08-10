import { useState } from 'react'
import { ArrowUp, Globe, Loader2 } from 'lucide-react'
import { Button } from './ui/button'
import { cn } from '../lib/utils'

interface Props {
  onSubmit: (prompt: string) => Promise<void>
}

const EXAMPLES = [
  '抓取一级方程式赛车车手积分榜 (formula1.com)',
  '打开 GitHub Trending，总结今天的热门项目',
  '搜索最新的 AI 新闻并整理成列表',
]

export default function AgentHome({ onSubmit }: Props) {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit() {
    const text = prompt.trim()
    if (!text || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(text)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8">
      <div className="w-full max-w-2xl space-y-8">
        <div className="flex items-center justify-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Globe className="size-5" />
          </div>
          <h1 className="font-heading text-2xl font-semibold">Cloud Browser Agent</h1>
        </div>

        <div
          className={cn(
            'rounded-2xl border bg-card shadow-sm transition-shadow',
            'focus-within:ring-2 focus-within:ring-ring/50',
          )}
        >
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
            }}
            placeholder="描述你的需求，AI 将打开云端浏览器执行..."
            rows={4}
            disabled={submitting}
            className="w-full resize-none rounded-t-2xl bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">⌘+Enter 发送</span>
            <Button
              size="icon"
              onClick={handleSubmit}
              disabled={!prompt.trim() || submitting}
              className="rounded-full"
            >
              {submitting ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-center text-xs text-muted-foreground">试试这些示例</p>
          <div className="flex flex-wrap justify-center gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                onClick={() => setPrompt(example)}
                className="rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
