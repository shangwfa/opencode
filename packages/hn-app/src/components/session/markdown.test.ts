import { describe, expect, it } from "vitest"
import { linkifySandboxFileUrls, renderMarkdownHtml } from "./markdown"

describe("linkifySandboxFileUrls", () => {
  it("裸 file:// 路径转成链接", () => {
    const html = linkifySandboxFileUrls("<p>页面已生成：file:///workspace/a.html</p>")
    expect(html).toContain('data-sandbox-href="file:///workspace/a.html"')
    expect(html).toContain("页面已生成：")
  })

  it("同一段多个链接", () => {
    const html = linkifySandboxFileUrls("<p>见 file:///workspace/a.html 与 file:///workspace/b.png 结束</p>")
    expect(html.match(/<a /g)?.length).toBe(2)
    expect(html).toContain("结束")
  })

  it("不改动已有 <a>", () => {
    const html = linkifySandboxFileUrls('<p><a href="https://x.dev">file:///workspace/a.html</a></p>')
    expect(html).not.toContain("<a href=\"file:///workspace/a.html\"")
  })

  it("代码块内不链接化，独立行内文件路径可预览", () => {
    const html = linkifySandboxFileUrls("<pre><code>file:///workspace/a.html</code></pre>")
    expect(html).not.toContain("<a ")
    const inline = linkifySandboxFileUrls("<p><code>file:///workspace/a.html</code></p>")
    expect(inline).toContain('data-sandbox-href="file:///workspace/a.html"')
    expect(linkifySandboxFileUrls("<p><code>cat /workspace/a.html</code></p>")).not.toContain("<a ")
  })

  it("无 file:// 时原样返回", () => {
    const html = "<p>普通文本 https://example.com</p>"
    expect(linkifySandboxFileUrls(html)).toBe(html)
  })

  it("中文标点作为边界", () => {
    const html = linkifySandboxFileUrls("<p>见 file:///workspace/a.html，然后继续</p>")
    expect(html).toContain('data-sandbox-href="file:///workspace/a.html"')
    expect(html).toContain("，然后继续")
  })
})
describe("linkifySandboxFileUrls 裸路径", () => {
  it("裸 /workspace 路径补 file:// 链接", () => {
    const html = linkifySandboxFileUrls("<p>页面已生成：/workspace/preview-demo.html 请查收</p>")
    expect(html).toContain('data-sandbox-href="file:///workspace/preview-demo.html"')
    expect(html).toContain("请查收")
  })

  it("非沙箱根目录不链化（避免误判系统路径）", () => {
    const html = linkifySandboxFileUrls("<p>运行 /usr/bin/python3 与 /etc/hosts.conf</p>")
    expect(html).not.toContain("<a ")
  })

  it("沙箱根下的其它可预览扩展名也识别", () => {
    expect(linkifySandboxFileUrls("<p>/workspace/a.md</p>")).toContain('data-sandbox-href="file:///workspace/a.md"')
    expect(linkifySandboxFileUrls("<p>/workspace/a.png</p>")).toContain('data-sandbox-href="file:///workspace/a.png"')
  })
  it("会话 output 相对路径可预览，但不链接路径穿越", () => {
    expect(renderMarkdownHtml("截图：`output/buy-pricing-desktop.png`")) .toContain('data-sandbox-href="file:///workspace/output/buy-pricing-desktop.png"')
    expect(renderMarkdownHtml("`output/../secret.png`")).not.toContain("data-sandbox-href")
  })

  it("代码块里的裸路径不链化", () => {
    expect(linkifySandboxFileUrls("<pre><code>/workspace/a.html</code></pre>")).not.toContain("<a ")
  })
})

describe("renderMarkdownHtml（模型写 markdown 链接的真实场景）", () => {
  it("模型写的 [x](file://…) 链接保留可点击标记（DOMPurify 曾剥掉 href）", () => {
    const html = renderMarkdownHtml("[查看](file:///workspace/about.html)")
    expect(html).toContain('data-sandbox-href="file:///workspace/about.html"')
    expect(html).not.toContain(' href="file://')
  })

  it("裸 file:// 文本同样可点", () => {
    expect(renderMarkdownHtml("已生成：file:///workspace/a.html")).toContain(
      'data-sandbox-href="file:///workspace/a.html"',
    )
  })

  it("裸 /workspace 路径同样可点", () => {
    expect(renderMarkdownHtml("已生成 /workspace/a.html")).toContain('data-sandbox-href="file:///workspace/a.html"')
  })
  it("行内代码中的中文 Markdown 文件路径保留样式且可键盘预览", () => {
    const doc = new DOMParser().parseFromString(renderMarkdownHtml("完整版已保存到：`/workspace/output/影刀官网-产品与定价整理.md`"), "text/html")
    const anchor = doc.querySelector("a[data-sandbox-href]")
    expect(anchor?.getAttribute("data-sandbox-href")).toBe("file:///workspace/output/影刀官网-产品与定价整理.md")
    expect(anchor?.querySelector("code")?.textContent).toBe("/workspace/output/影刀官网-产品与定价整理.md")
    expect(anchor?.getAttribute("tabindex")).toBe("0")
    expect(anchor?.getAttribute("role")).toBe("button")
  })

  it("http(s) 链接不受影响，保留正常 href", () => {
    const html = renderMarkdownHtml("[官网](https://example.com)")
    expect(html).toContain('href="https://example.com"')
    expect(html).not.toContain("data-sandbox-href")
  })
  it("裸网址遇到中文括号或标点结束，不吞入后面的正文", () => {
    const text = "已打开影刀官网（https://www.yingdao.com/）并整理了产品功能与版本定价，完整版已保存到："
    const doc = new DOMParser().parseFromString(renderMarkdownHtml(text), "text/html")
    const link = doc.querySelector("a")
    expect(link?.getAttribute("href")).toBe("https://www.yingdao.com/")
    expect(link?.textContent).toBe("https://www.yingdao.com/")
    expect(doc.body.textContent).toContain("）并整理了产品功能与版本定价，完整版已保存到：")
    expect(link?.nextSibling?.textContent).toContain("）并整理")
  })
  it.each(["，", "。", "；", "：", "！", "？", "、", "）", "】", "」", "》"])("裸网址在中文 %s 前结束", (punctuation) => {
    const doc = new DOMParser().parseFromString(renderMarkdownHtml(`https://example.com/产品${punctuation}后续正文`), "text/html")
    expect(decodeURI(doc.querySelector("a")?.getAttribute("href") ?? "")).toBe("https://example.com/产品")
    expect(doc.querySelector("a")?.nextSibling?.textContent?.trim()).toBe(`${punctuation}后续正文`)
  })
  it("显式 Markdown 中文链接和代码中的网址保持原样", () => {
    const doc = new DOMParser().parseFromString(renderMarkdownHtml("[产品](https://example.com/产品，价格)\n\n`https://example.com/）示例`"), "text/html")
    expect(decodeURI(doc.querySelector("a")?.getAttribute("href") ?? "")).toBe("https://example.com/产品，价格")
    expect(doc.querySelector("code")?.textContent).toBe("https://example.com/）示例")
  })
  it.each(["http://ui.shadcn.com", "https://ui.shadcn.com"])("外部链接 %s 可安全打开新标签页", (url) => {
    const doc = new DOMParser().parseFromString(renderMarkdownHtml(`[ui.shadcn.com](${url})`), "text/html")
    const link = doc.querySelector("a")
    expect(link?.getAttribute("href")).toBe(url)
    expect(link?.getAttribute("target")).toBe("_blank")
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer")
  })

  it("script 标签被 DOMPurify 剔除", () => {
    const html = renderMarkdownHtml('<script>alert(1)</script>')
    expect(html).not.toContain("<script")
  })
  // 注：jsdom 下 DOMPurify 不剥离事件属性（实测真实浏览器已剥离 onerror，
  // 见 MIGRATION.md 第九轮记录），故此处不断言 onerror，避免测试环境差异造成误报。
})
