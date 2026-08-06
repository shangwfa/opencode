import {
  Check,
  Loader2,
  Eye,
  FileText,
  X,
} from "lucide-react"
import type { FilePreview } from "../types"

export function FileCard({ file, onPreview }: { file: FilePreview; onPreview: () => void }) {
  const name = file.filePath.split("/").pop() ?? file.filePath
  const writing = file.status !== "completed" && file.status !== "error"
  return (
    <div
      className={`relative flex cursor-pointer items-center gap-2 overflow-hidden rounded-lg border px-3 py-2 transition-colors ${
        writing
          ? "border-[#b9cdfb] bg-[#f0f4ff] hover:border-[#3159ef]"
          : "border-[#dde4ec] bg-[#f7f9fc] hover:border-[#3159ef] hover:bg-[#f0f4ff]"
      }`}
      onClick={onPreview}
      role="button"
    >
      {writing && <span className="file-writing-bar" />}
      <FileText size={14} className={`shrink-0 ${writing ? "text-[#3159ef]" : "text-[#5b8def]"}`} />
      <span className="text-xs font-semibold text-[#3d4a5c]">{name}</span>
      <span className="font-mono text-[10px] text-[#8b96a5]">{file.filePath}</span>
      {writing ? (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[#3159ef]">
          <Loader2 size={12} className="animate-spin" />
          写入中
        </span>
      ) : file.status === "error" ? (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[#d44040]">
          <X size={12} />
          失败
        </span>
      ) : (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] font-semibold text-[#3d9960]">
          <Check size={12} />
          已完成
        </span>
      )}
      <Eye size={13} className="shrink-0 text-[#8b96a5]" />
    </div>
  )
}
