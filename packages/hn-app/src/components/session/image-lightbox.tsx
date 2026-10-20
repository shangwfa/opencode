/**
 * 图片预览弹窗（消息内 file part 的 image/* 分支）。
 * 源：xybot-front-opencode-ui src/ui/components/image-preview.tsx（对话中点击图片放大）。
 * 远程 URL（OSS 附件）与 dataUrl 均可用；点击背景或 Esc 关闭。
 */
import { useEffect } from "react"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type ImagePreviewTarget = { url: string; name?: string } | undefined

export function ImageLightbox({
  target,
  onOpenChange,
}: {
  target: ImagePreviewTarget
  onOpenChange: (open: boolean) => void
}) {
  // 打开时锁背景滚动
  useEffect(() => {
    if (!target) return
    const previous = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = previous
    }
  }, [target])

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[min(1100px,94vw)] gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none sm:max-w-[min(1100px,94vw)]"
      >
        <DialogTitle className="sr-only">{target?.name ?? "图片预览"}</DialogTitle>
        {target && (
          <button
            type="button"
            aria-label="关闭预览"
            className="group relative flex max-h-[86vh] w-full cursor-zoom-out items-center justify-center overflow-hidden rounded-xl"
            onClick={() => onOpenChange(false)}
          >
            <img
              src={target.url}
              alt={target.name ?? "图片"}
              className={cn("max-h-[86vh] w-auto max-w-full rounded-xl bg-white object-contain shadow-2xl")}
            />
            {target.name && (
              <span className="absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-md bg-black/55 px-2 py-1 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100">
                {target.name}
              </span>
            )}
          </button>
        )}
      </DialogContent>
    </Dialog>
  )
}