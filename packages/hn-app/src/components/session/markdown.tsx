/**
 * Markdown 渲染（marked + DOMPurify 消毒）。
 * 模型输出不可信，必须过 DOMPurify 再注 DOM。
 *
 * 沙箱文件链接（file:///workspace/x.html）点击后由 onFileLink 拦截，交给预览弹窗，
 * 避免浏览器直接打开 file:// 失败。
 */
import { useEffect, useMemo, useState } from "react"
import { marked } from "marked"
import DOMPurify from "dompurify"
import { guessMimeType, isPreviewableFileHref, parseSandboxFileHref, previewKindOf, sandboxPreviewFile } from "./file-preview-url"
import { readSandboxFile } from "@/lib/rest"

marked.setOptions({ gfm: true, breaks: true })
marked.use({
  tokenizer: {
    url(source) {
      const match = /^(?:https?:\/\/|www\.)[^\s<>]+/i.exec(source)
      if (!match) return false
      const boundary = match[0].search(/[，。；：！？、（）【】「」『』《》]/)
      if (boundary < 0) return false
      const raw = match[0].slice(0, boundary).replace(/[.,;:!?]+$/, "")
      if (!raw) return false
      return { type: "link", raw, text: raw, href: /^www\./i.test(raw) ? `http://${raw}` : raw, tokens: [{ type: "text", raw, text: raw }] }
    },
  },
})

/**
 * DOMPurify 默认 `ALLOWED_URI_REGEXP` 不含 `file:`，会剥掉模型写的 `[x](file://…)` 的 href，
 * 实测表现为链接 `href=""`、点击无反应。这里放宽协议表；随后由 linkify 把 file: 链接改写为
 * `data-sandbox-href` 并移除 href —— DOM 中不留可导航的 file: 地址，点击统一由事件委托接管。
 */
const ALLOWED_URI_REGEXP =
  /^(?:(?:(?:https?|ftps?|mailto|tel|callto|sms|cid|xmpp|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$)))/i

/** 裸 file:// 路径（marked/GFM autolink 只认 http(s)/www/mailto，需自行链接化） */
const FILE_URL_RE = /file:\/\/\/[^\s"'<>)\]，。；：、]+/g

/**
 * 裸沙箱绝对路径（模型常只写 `/workspace/x.html`）。
 * 限定沙箱常见根目录 + 可预览扩展名，避免把 `/usr/bin` 之类误链化；href 统一补 `file://`。
 */
const BARE_SANDBOX_PATH_RE =
  /(?<![\w:/.-])(?:\/(?:workspace|root|tmp|home)\/|(?:\.\/)?output\/)[^\s"'<>)\]，。；：、`]+?\.(?:html?|md|png|jpe?g|gif|webp|svg|avif|ico|json|csv|txt|pdf|docx?|xlsx?|pptx|od[tpfs]|rtf|mp[34]|webm|wav|ogg|m4a|mov)\b/gi

function sandboxHref(raw: string) {
  return raw.startsWith("file://") ? raw : raw.startsWith("/") ? `file://${raw}` : `file:///workspace/${raw.replace(/^\.\//, "")}`
}

/** 把文本节点里的沙箱文件引用转成 <a>（跳过 a/code/pre，避免破坏已有链接与代码块） */
export function linkifySandboxFileUrls(html: string): string {
  if (typeof DOMParser === "undefined") return html
  if (!html.includes("<a") && !html.includes("file://") && !html.includes("/workspace/") && !html.includes("output/")) return html
  const doc = new DOMParser().parseFromString(`<div id="hb-root">${html}</div>`, "text/html")
  const root = doc.getElementById("hb-root")
  if (!root) return html

  // 行内代码只有在完整内容就是文件路径时才可点；命令、示例代码和 fenced code 保持原样。
  for (const code of root.querySelectorAll("code")) {
    if (code.closest("pre, a") || code.children.length) continue
    const raw = code.textContent?.trim() ?? ""
    if (!/^(?:file:\/\/\/|\/(?:workspace|root|tmp|home)\/|(?:\.\/)?output\/)/i.test(raw) || /(?:^|\/)\.\.(?:\/|$)/.test(raw) || !isPreviewableFileHref(sandboxHref(raw))) continue
    const anchor = doc.createElement("a")
    anchor.setAttribute("data-sandbox-href", sandboxHref(raw))
    code.replaceWith(anchor)
    anchor.appendChild(code)
  }

  const targets: Text[] = []
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const value = node.nodeValue
    if (!value) continue
    if (node.parentElement?.closest("a, code, pre")) continue
    if (!value.includes("file://") && !value.includes("/workspace/") && !value.includes("output/")) continue
    targets.push(node)
  }

  for (const node of targets) {
    const text = node.nodeValue ?? ""
    const fragment = doc.createDocumentFragment()
    const pattern = new RegExp(`${FILE_URL_RE.source}|${BARE_SANDBOX_PATH_RE.source}`, "gi")
    let cursor = 0
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
      if (/(?:^|\/)\.\.(?:\/|$)/.test(raw)) continue
      const index = match.index ?? 0
      if (index > cursor) fragment.appendChild(doc.createTextNode(text.slice(cursor, index)))
      const anchor = doc.createElement("a")
      anchor.setAttribute("data-sandbox-href", sandboxHref(raw))
      anchor.textContent = raw
      fragment.appendChild(anchor)
      cursor = index + raw.length
    }
    if (cursor < text.length) fragment.appendChild(doc.createTextNode(text.slice(cursor)))
    node.parentNode?.replaceChild(fragment, node)
  }

  // 模型写的 [x](file://…) 同样改写为 data-sandbox-href，避免浏览器默认导航
  for (const anchor of [...root.querySelectorAll("a[href^='file://']")]) {
    const href = anchor.getAttribute("href") ?? ""
    anchor.setAttribute("data-sandbox-href", href)
    anchor.removeAttribute("href")
  }
  for (const anchor of root.querySelectorAll("a[data-sandbox-href]")) {
    anchor.setAttribute("role", "button")
    anchor.setAttribute("tabindex", "0")
    anchor.setAttribute("title", "预览文件")
    anchor.classList.add("cursor-pointer")
  }
  for (const anchor of root.querySelectorAll("a[href]")) {
    if (!/^https?:\/\//i.test(anchor.getAttribute("href") ?? "")) continue
    anchor.setAttribute("target", "_blank")
    anchor.setAttribute("rel", "noopener noreferrer")
  }

  return root.innerHTML
}

/** marked → DOMPurify（放宽 file: 协议）→ file 链接改写与链接化 */
export function renderMarkdownHtml(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ["target"], ALLOWED_URI_REGEXP })
  return linkifySandboxFileUrls(clean)
}

export function Markdown({
  content,
  className,
  onFileLink,
  sessionId,
  directory,
}: {
  content: string
  className?: string
  /** 点击沙箱文件链接（file:// 或绝对路径）时回调 */
  onFileLink?: (href: string) => void
  sessionId?: string
  directory?: string
}) {
  const html = useMemo(() => renderMarkdownHtml(content), [content])
  const images = useMemo(() => {
    if (!sessionId || typeof DOMParser === "undefined") return []
    const doc = new DOMParser().parseFromString(html, "text/html")
    return [...new Set([...doc.querySelectorAll("a[data-sandbox-href]")].map((node) => node.getAttribute("data-sandbox-href") ?? "").filter((href) => previewKindOf(href) === "image"))]
  }, [html, sessionId])

  return (
    <>
    <div
      data-slot="markdown"
      className={cnMarkdown(className)}
      onClick={
        onFileLink
          ? (event) => {
              const anchor = (event.target as HTMLElement | null)?.closest?.("a")
              const href = anchor?.getAttribute("data-sandbox-href") ?? anchor?.getAttribute("href")
              if (!href) return
               if (!parseSandboxFileHref(href)) return
               if (window.getSelection()?.toString()) return
              event.preventDefault()
              onFileLink(href)
            }
          : undefined
      }
      onKeyDown={onFileLink ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        const anchor = (event.target as HTMLElement | null)?.closest?.("a[data-sandbox-href]")
        const href = anchor?.getAttribute("data-sandbox-href")
        if (!href || !parseSandboxFileHref(href)) return
        event.preventDefault()
        onFileLink(href)
      } : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
    {images.length > 0 && <div aria-label="截图预览" className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{images.map((href) => <SandboxImage key={href} href={href} sessionId={sessionId!} directory={directory} onFileLink={onFileLink} />)}</div>}
    </>
  )
}

function SandboxImage({ href, sessionId, directory, onFileLink }: { href: string; sessionId: string; directory?: string; onFileLink?: (href: string) => void }) {
  const ref = parseSandboxFileHref(href)
  const [state, setState] = useState<{ url?: string; error?: string }>({})
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!ref) return
    let disposed = false, url = ""
    setState({})
    void readSandboxFile(ref.path, { sessionId, directory, mime: guessMimeType(ref.path) }).then((payload) => {
      if (disposed) return
      url = URL.createObjectURL(sandboxPreviewFile(payload.content, payload.binary, ref.path))
      setState({ url })
    }).catch((error: unknown) => { if (!disposed) setState({ error: error instanceof Error ? error.message : String(error) }) })
    return () => { disposed = true; if (url) URL.revokeObjectURL(url) }
  }, [href, sessionId, directory, revision])
  if (!ref) return null
  return <figure className="min-w-0 overflow-hidden rounded-xl border bg-slate-50">
    {state.url ? <button type="button" className="block w-full cursor-zoom-in" aria-label={`预览 ${ref.filename}`} onClick={() => onFileLink?.(href)}><img src={state.url} alt={ref.filename} loading="lazy" className="max-h-56 w-full object-contain" onError={() => setState({ error: "图片无法显示" })} /></button>
      : <div className="flex min-h-24 items-center justify-center p-3 text-xs text-muted-foreground">{state.error ? <button type="button" className="underline" onClick={() => setRevision((n) => n + 1)}>图片加载失败，点击重试</button> : "正在加载截图…"}</div>}
    <figcaption className="truncate border-t bg-white px-3 py-2 text-xs text-muted-foreground" title={ref.path}>{ref.filename}</figcaption>
  </figure>
}

function cnMarkdown(extra?: string) {
  return [
    // 正文：14px（源 --font-size-base）/ 1.75，中文长文可读性优先
    "text-sm leading-[1.75] break-words",
    // 段落节奏
    "[&>p]:my-3 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0",
    // 标题：紧凑、有层级
    "[&_h1]:mt-5 [&_h1]:mb-2.5 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:tracking-tight",
    "[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:tracking-tight",
    "[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-[15px] [&_h3]:font-semibold",
    "[&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:text-sm [&_h4]:font-semibold",
    "[&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:text-sm [&_h5]:font-medium",
    "[&_h6]:mt-3 [&_h6]:mb-1 [&_h6]:text-xs [&_h6]:font-medium [&_h6]:text-muted-foreground",
    // 列表：悬挂缩进 + 紧凑行距
    "[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ul_li]:my-1 [&_ul_li::marker]:text-muted-foreground/60",
    "[&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol_li]:my-1 [&_ol_li::marker]:text-muted-foreground/70",
    "[&_ul ul]:my-1 [&_ol ol]:my-1",
    // 代码：inline 与 block 分开
    "[&_code]:font-mono [&_code]:text-[0.86em]",
    "[&_code:not(pre_code)]:bg-muted [&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:px-1.5 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:font-medium",
    "[&_pre]:bg-muted/60 [&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:p-3.5 [&_pre]:text-[13px] [&_pre]:leading-relaxed",
    "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
    // 引用 / 分隔 / 表格 / 图片
    "[&_blockquote]:border-border/70 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3.5 [&_blockquote]:text-muted-foreground",
    "[&_hr]:my-5 [&_hr]:border-border",
    "[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm",
    "[&_th]:border-border [&_th]:border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-medium",
    "[&_td]:border-border [&_td]:border [&_td]:px-3 [&_td]:py-2",
    "[&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg",
    "[&_a]:text-foreground [&_a]:underline [&_a]:decoration-border [&_a]:underline-offset-2 [&_a:hover]:decoration-foreground",
    extra,
  ]
    .filter(Boolean)
    .join(" ")
}
