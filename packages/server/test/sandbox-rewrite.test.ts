import { describe, expect, test } from "bun:test"
import { SandboxRewrite } from "../src/sandbox-rewrite"

const prefix = "/api/session/ses_test123/proxy/5173"

describe("rewriteHtml", () => {
  test("injects prefix script into head", () => {
    const html = "<html><head><title>t</title></head><body></body></html>"
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`data-oc-prefix="${prefix}"`)
    expect(out).toContain("window.__OC_PROXY_PREFIX__")
    expect(out).toContain("window.fetch=function")
    expect(out).toContain("window.WebSocket=function")
    expect(out).toContain("XMLHttpRequest.prototype.open")
  })

  test("rewrites src/href to prefixed paths", () => {
    const html = `<html><head><script src="/src/main.tsx"></script><link href="/style.css"></head></html>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`src="${prefix}/src/main.tsx"`)
    expect(out).toContain(`href="${prefix}/style.css"`)
  })

  test("does not double-prefix already-prefixed paths", () => {
    const html = `<script src="${prefix}/src/main.tsx"></script>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`src="${prefix}/src/main.tsx`)
    expect(out).not.toContain(`src="${prefix}${prefix}/`)
  })

  test("does not touch protocol-relative or absolute URLs", () => {
    const html = `<script src="//cdn.example.com/x.js"></script><link href="https://a.com/b.css">`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`src="//cdn.example.com/x.js"`)
    expect(out).toContain(`href="https://a.com/b.css"`)
  })

  test("rewrites inline import statements", () => {
    const html = `<script>import "/@react-refresh"; import x from "/src/x.js"</script>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`import "${prefix}/@react-refresh"`)
    expect(out).toContain(`from "${prefix}/src/x.js"`)
  })

  test("rewrites JSDoc-adjacent imports (v1 T11.40 regression)", () => {
    const html = `<script>/** 中文说明 */ import __vite__cjsImport3_react from "/node_modules/.vite/deps/react.js?v=abc"</script>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`from "${prefix}/node_modules/.vite/deps/react.js`)
  })

  test("does not rewrite 'from' in prose strings", () => {
    const html = `<script>const msg = 'Learn from "/docs"';</script>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`Learn from "/docs"`)
  })

  test("rewrites dynamic import()", () => {
    const html = `<script>const m = await import("/src/lazy.ts")</script>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`import("${prefix}/src/lazy.ts")`)
  })

  test("rewrites export default resource paths only", () => {
    const html = `<script>export default "/src/assets/bg.png"</script>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`export default "${prefix}/src/assets/bg.png"`)
    const html2 = `<script>export default "/api/users"</script>`
    const out2 = SandboxRewrite.rewriteHtml(prefix, html2)
    expect(out2).toContain(`export default "/api/users"`)
  })

  test("rewrites location assignments", () => {
    const html = `<script>location.href = "/about"; window.location = "/home"</script>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out).toContain(`location.href = "${prefix}/about"`)
    expect(out).toContain(`window.location = "${prefix}/home"`)
  })

  test("injects into body when no head", () => {
    const html = `<body><p>x</p></body>`
    const out = SandboxRewrite.rewriteHtml(prefix, html)
    expect(out.indexOf("data-oc-prefix")).toBeLessThan(out.indexOf("<body"))
  })
})

describe("rewriteJs", () => {
  test("rewrites static imports", () => {
    const js = `import { a } from "/src/a.js";\nimport "/src/b.css";`
    const out = SandboxRewrite.rewriteJs(prefix, js)
    expect(out).toContain(`from "${prefix}/src/a.js"`)
    expect(out).toContain(`import "${prefix}/src/b.css"`)
  })

  test("rewrites dynamic imports with comments", () => {
    const js = `const r = await import(/* @vite-ignore */ "/node_modules/x.js")`
    const out = SandboxRewrite.rewriteJs(prefix, js)
    expect(out).toContain(`"${prefix}/node_modules/x.js"`)
  })

  test("rewrites export default resource paths", () => {
    const js = `export default "/src/assets/bg.png"`
    const out = SandboxRewrite.rewriteJs(prefix, js)
    expect(out).toContain(`"${prefix}/src/assets/bg.png"`)
  })

  test("rewrites __webpack_require__.p", () => {
    const js = `__webpack_require__.p = "/_next/"`
    const out = SandboxRewrite.rewriteJs(prefix, js)
    expect(out).toContain(`__webpack_require__.p="${prefix}/_next/"`)
  })

  test("rewrites HMR placeholders for vite client", () => {
    const js = `const base = __BASE__; const hmr = __HMR_BASE__`
    const out = SandboxRewrite.rewriteJs(prefix, js, true)
    expect(out).toContain(JSON.stringify(prefix + "/"))
  })

  test("does not double-prefix", () => {
    const js = `import "${prefix}/src/a.js"`
    const out = SandboxRewrite.rewriteJs(prefix, js)
    expect(out.match(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))?.length).toBe(1)
  })
})

describe("rewriteCss", () => {
  test("rewrites url() paths", () => {
    const css = `body { background: url(/img/bg.png) }`
    const out = SandboxRewrite.rewriteCss(prefix, css)
    expect(out).toContain(`url(${prefix}/img/bg.png)`)
  })

  test("does not touch protocol-relative or data URLs", () => {
    const css = `body { background: url(//cdn.example.com/x.png); mask: url(data:image/png;base64,abc) }`
    const out = SandboxRewrite.rewriteCss(prefix, css)
    expect(out).toContain(`url(//cdn.example.com/x.png)`)
    expect(out).toContain(`url(data:image/png`)
  })
})

describe("rewriteKind", () => {
  test("html by content-type", () => {
    expect(SandboxRewrite.rewriteKind("text/html; charset=utf-8", "/")).toBe("html")
  })
  test("js by content-type and path", () => {
    expect(SandboxRewrite.rewriteKind("application/javascript", "/x.js")).toBe("js")
    expect(SandboxRewrite.rewriteKind("", "/src/main.tsx")).toBe("js")
  })
  test("css by content-type and path", () => {
    expect(SandboxRewrite.rewriteKind("text/css", "/x.css")).toBe("css")
    expect(SandboxRewrite.rewriteKind("", "/style.css")).toBe("css")
  })
  test("binary passthrough", () => {
    expect(SandboxRewrite.rewriteKind("image/png", "/x.png")).toBe("binary")
    expect(SandboxRewrite.rewriteKind("application/json", "/api/test")).toBe("binary")
  })
})
