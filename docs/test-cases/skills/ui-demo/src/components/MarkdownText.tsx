import { memo } from "react"
import { Streamdown } from "streamdown"
import { code } from "@streamdown/code"

export const MarkdownText = memo(function MarkdownText({
  children,
  animated = false,
}: {
  children: string
  animated?: boolean
}) {
  return (
    <div className="text-sm text-gray-800 [&_h1]:mb-3 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_p]:mb-2 [&_p]:leading-relaxed [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_blockquote]:border-l-2 [&_blockquote]:border-gray-300 [&_blockquote]:pl-3 [&_blockquote]:text-gray-500 [&_table]:mb-2 [&_table]:w-full [&_table]:border-collapse [&_th]:border-b-2 [&_th]:border-gray-300 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_td]:border-b [&_td]:border-gray-200 [&_td]:px-3 [&_td]:py-2 [&_code:not(pre_code)]:rounded-md [&_code:not(pre_code)]:bg-gray-100 [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:text-pink-600">
      <Streamdown plugins={{ code }} animated={animated}>
        {children}
      </Streamdown>
    </div>
  )
})
