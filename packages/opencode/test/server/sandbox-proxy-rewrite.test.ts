import { describe, expect, test } from "bun:test"
import { rewriteCss, rewriteHtml, rewriteJs } from "../../src/server/sandbox-proxy"

const PREFIX = "/session/ses_testid0/proxy/5173"

// 计算文本中 PREFIX 出现次数，用于断言「恰好重写一次」
function countPrefix(text: string): number {
  return text.split(PREFIX).length - 1
}

describe("rewriteJs - 静态 import（回归）", () => {
  test("import BgPic from \"/src/...\" 重写", () => {
    const out = rewriteJs(PREFIX, `import BgPic from "/src/assets/bg.png?import";`)
    expect(out).toBe(`import BgPic from "${PREFIX}/src/assets/bg.png?import";`)
  })

  test("import \"...\" 无命名导入重写", () => {
    const out = rewriteJs(PREFIX, `import "/src/styles.css";`)
    expect(out).toBe(`import "${PREFIX}/src/styles.css";`)
  })

  test("export { x } from \"/src/...\" 重写", () => {
    const out = rewriteJs(PREFIX, `export { helper } from "/src/helper.ts";`)
    expect(out).toBe(`export { helper } from "${PREFIX}/src/helper.ts";`)
  })

  test("export * from \"/src/...\" 重写", () => {
    const out = rewriteJs(PREFIX, `export * from "/src/reexport.ts";`)
    expect(out).toBe(`export * from "${PREFIX}/src/reexport.ts";`)
  })

  test("from 后带空格的重写", () => {
    const out = rewriteJs(PREFIX, `import x from  "/src/a.ts";`)
    expect(out).toBe(`import x from  "${PREFIX}/src/a.ts";`)
  })

  test("单引号 import 重写", () => {
    const out = rewriteJs(PREFIX, `import x from '/src/a.ts';`)
    expect(out).toBe(`import x from '${PREFIX}/src/a.ts';`)
  })
})

describe("rewriteJs - 动态 import（本次修复）", () => {
  test("动态 import 本地模块路径重写", () => {
    const out = rewriteJs(PREFIX, `const mod = await import("/src/lazy.ts");`)
    expect(out).toBe(`const mod = await import("${PREFIX}/src/lazy.ts");`)
  })

  test("动态 import node_modules 预构建依赖重写（含 query）", () => {
    const out = rewriteJs(PREFIX, `const _ = await import("/node_modules/.vite/deps/lodash-es.js?v=4234cbbc");`)
    expect(out).toBe(`const _ = await import("${PREFIX}/node_modules/.vite/deps/lodash-es.js?v=4234cbbc");`)
  })

  test("动态 import 紧凑形式 import(\"...\") 重写", () => {
    const out = rewriteJs(PREFIX, `const m = import("/src/x.ts");`)
    expect(out).toBe(`const m = import("${PREFIX}/src/x.ts");`)
  })

  test("动态 import 括号后空格重写", () => {
    const out = rewriteJs(PREFIX, `const m = await import( "/src/x.ts" );`)
    expect(out).toBe(`const m = await import( "${PREFIX}/src/x.ts" );`)
  })

  test("单引号动态 import 重写", () => {
    const out = rewriteJs(PREFIX, `const m = await import('/src/x.ts');`)
    expect(out).toBe(`const m = await import('${PREFIX}/src/x.ts');`)
  })

  test("__vitePreload 包裹的动态 import 重写", () => {
    const out = rewriteJs(PREFIX, `__vitePreload(() => import("/src/chunk.ts"), __vite__mapDeps([]))`)
    expect(out).toContain(`import("${PREFIX}/src/chunk.ts")`)
  })

  test("同一 JS 内多处动态 import 全部重写（全局替换）", () => {
    const src = `const a = await import("/src/a.ts");\nconst b = await import("/src/b.ts");\nconst c = await import("/src/c.ts");`
    const out = rewriteJs(PREFIX, src)
    expect(countPrefix(out)).toBe(3)
    expect(out).not.toContain(`import("/src/`)
  })

  test("裸模块说明符（Vite 转换后必为绝对路径，源码形态不误伤）", () => {
    // rewriteJs 只处理 Vite 转换产物（/ 开头路径）；裸说明符 "lodash-es" 无需处理
    const out = rewriteJs(PREFIX, `const _ = await import("lodash-es");`)
    expect(out).toBe(`const _ = await import("lodash-es");`)
  })
})

describe("rewriteJs - export default 资源字符串（本次修复）", () => {
  test("Vite 静态资源默认导出重写", () => {
    const out = rewriteJs(PREFIX, `export default "/src/assets/bg.png"`)
    expect(out).toBe(`export default "${PREFIX}/src/assets/bg.png"`)
  })

  test("export default 带 query 的资源重写", () => {
    const out = rewriteJs(PREFIX, `export default "/src/assets/logo.svg?t=raw"`)
    expect(out).toBe(`export default "${PREFIX}/src/assets/logo.svg?t=raw"`)
  })

  test("export default 多空格变体重写", () => {
    const out = rewriteJs(PREFIX, `export  default  "/src/assets/a.png"`)
    expect(out).toBe(`export  default  "${PREFIX}/src/assets/a.png"`)
  })

  test("export default node_modules 依赖资源重写", () => {
    const out = rewriteJs(PREFIX, `export default "/node_modules/.vite/deps/worker.js?worker_file"`)
    expect(out).toBe(`export default "${PREFIX}/node_modules/.vite/deps/worker.js?worker_file"`)
  })

  test("export default 非路径字符串不误伤", () => {
    const out = rewriteJs(PREFIX, `export default "hello-world"`)
    expect(out).toBe(`export default "hello-world"`)
  })

  test("export default 相对路径不处理（浏览器相对当前模块 URL 解析，天然走 prefix）", () => {
    const out = rewriteJs(PREFIX, `export default "./assets/bg.png"`)
    expect(out).toBe(`export default "./assets/bg.png"`)
  })

  test("export default 对象字面量内的字符串不误伤", () => {
    const out = rewriteJs(PREFIX, `export default { path: "/api/users", name: "x" }`)
    expect(out).toBe(`export default { path: "/api/users", name: "x" }`)
  })
})

describe("rewriteJs - 防御性守卫", () => {
  test("已带 prefix 的静态 import 不二次重写", () => {
    const src = `import x from "${PREFIX}/src/y.ts";`
    expect(rewriteJs(PREFIX, src)).toBe(src)
  })

  test("已带 prefix 的动态 import 不二次重写", () => {
    const src = `const m = await import("${PREFIX}/src/y.ts");`
    expect(rewriteJs(PREFIX, src)).toBe(src)
  })

  test("已带 prefix 的 export default 不二次重写", () => {
    const src = `export default "${PREFIX}/src/assets/bg.png"`
    expect(rewriteJs(PREFIX, src)).toBe(src)
  })

  test("协议相对 URL（//）不重写", () => {
    const out = rewriteJs(PREFIX, `import x from "//cdn.example.com/lib.js";`)
    expect(out).toBe(`import x from "//cdn.example.com/lib.js";`)
  })

  test("import.meta.url 不受影响", () => {
    const src = `RefreshRuntime.__hmr_import(import.meta.url).then((m) => {});`
    expect(rewriteJs(PREFIX, src)).toBe(src)
  })

  test("https:// 绝对 URL 不重写", () => {
    const out = rewriteJs(PREFIX, `const r = await fetch("https://api.example.com/data");`)
    expect(out).toBe(`const r = await fetch("https://api.example.com/data");`)
  })

  test("含正则特殊字符的 prefix（sessionID 形态）不破坏正则", () => {
    // escapedPrefix 路径：prefix 含 regex 特殊字符时构造不抛错且行为正确
    const trickyPrefix = "/session/ses(a)[b]/proxy/5173"
    const out = rewriteJs(trickyPrefix, `import x from "/src/a.ts";`)
    expect(out).toBe(`import x from "${trickyPrefix}/src/a.ts";`)
  })
})

describe("rewriteJs - webpack 与 Vite 占位符（回归）", () => {
  test("__webpack_require__.p 重写（压缩产物无空格形态）", () => {
    const out = rewriteJs("/session/ses_x/proxy/3000", `__webpack_require__.p="/_next/";`)
    expect(out).toBe(`__webpack_require__.p="/session/ses_x/proxy/3000/_next/";`)
  })

  test("__BASE__ / __HMR_BASE__ 重写", () => {
    const out = rewriteJs(PREFIX, `const base = "__BASE__"; const hmr = "__HMR_BASE__";`)
    expect(out).toContain(`"${PREFIX}/"`)
    expect(out).not.toContain("__BASE__")
    expect(out).not.toContain("__HMR_BASE__")
  })

  test("isViteClient 时补齐 HMR 占位符（真实产物：占位符裸露无引号）", () => {
    const out = rewriteJs(PREFIX, `const p = __HMR_PORT__; const t = __WS_TOKEN__; const h = __SERVER_HOST__;`, true)
    expect(out).toContain(`const p = undefined`)
    expect(out).toContain(`const t = ""`)
    expect(out).toContain(`const h = "localhost"`)
  })

  test("isViteClient 时 \${\"/\"} 模板替换", () => {
    const out = rewriteJs(PREFIX, `const u = base + \${"/"} + path;`, true)
    expect(out).toContain(`\${"${PREFIX}/"}`)
  })
})

describe("rewriteJs - 真实 Vite 编译产物样本（实测 fixture）", () => {
  test("React 组件：静态资源 import + 动态 import 混合（T11.36/T11.37 场景）", () => {
    const viteOutput = [
      `import BgPic from "/src/assets/bg.png?import";`,
      `import { useState } from "/node_modules/.vite/deps/react.js?v=4234cbbc";`,
      `const mod = await import("/src/lazy.ts");`,
      `const _ = await import("/node_modules/.vite/deps/lodash-es.js?v=4234cbbc");`,
    ].join("\n")
    const out = rewriteJs(PREFIX, viteOutput)
    expect(out).not.toMatch(/(?:import|from)\s*(?:["'])\/(?!\/|session\/)/)
    expect(out).not.toMatch(/import\(\s*(?:["'])\/(?!\/|session\/)/)
    expect(out).not.toMatch(/export\s+default\s*(?:["'])\/(?!\/|session\/)/)
    expect(countPrefix(out)).toBe(4)
  })

  test("HMR 热更新片段（import.meta.url 不被误伤）", () => {
    const src = `import.meta.hot.accept((mod) => mod);\nRefreshRuntime.__hmr_import(import.meta.url).then((currentExports) => { import.meta.hot.accept(currentExports); });`
    const out = rewriteJs(PREFIX, src)
    expect(out).toBe(src)
  })
})

describe("rewriteHtml - 与 rewriteJs 的路径重写一致性（回归）", () => {
  test("src/href 重写并注入 data-oc-prefix 与 INJECT_SCRIPT", () => {
    const html = `<html><head><title>t</title></head><body><script type="module" src="/src/main.tsx"></script><link rel="stylesheet" href="/src/a.css"></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`src="${PREFIX}/src/main.tsx"`)
    expect(out).toContain(`href="${PREFIX}/src/a.css"`)
    expect(out).toContain(`data-oc-prefix="${PREFIX}"`)
    expect(out).toContain(`window.__OC_PROXY_PREFIX__`)
    expect(out).toContain(`window.fetch=function`)
    expect(out).toContain(`window.WebSocket=function`)
  })

  test("内联 script 中动态 import 兜底重写（HTML 兜底正则，与 JS 文件修复语义一致）", () => {
    const html = `<html><head></head><body><script>const m = await import("/src/inline.ts");</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`import("${PREFIX}/src/inline.ts")`)
  })

  test("内联 script 中已带 prefix 不二次重写", () => {
    const html = `<html><head></head><body><script>const m = await import("${PREFIX}/src/inline.ts");</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    // prefix 出现 3 次：内联原样 1 + data-oc-prefix 属性 1 + INJECT_SCRIPT 的 var P 1
    expect(countPrefix(out)).toBe(3)
    // 关键：无重复拼接特征
    expect(out).not.toContain(`${PREFIX}/session/`)
  })
})

describe("rewriteCss - url() 重写（回归）", () => {
  test("绝对路径 url() 加 prefix", () => {
    const out = rewriteCss(PREFIX, `.hero { background-image: url(/assets/bg.png); }`)
    expect(out).toBe(`.hero { background-image: url(${PREFIX}/assets/bg.png); }`)
  })

  test("带引号 url() 加 prefix", () => {
    const out = rewriteCss(PREFIX, `.hero { background-image: url("/assets/bg.png"); }`)
    expect(out).toBe(`.hero { background-image: url("${PREFIX}/assets/bg.png"); }`)
  })

  test("相对路径与 data: URI 不误伤", () => {
    const src = `.a { background: url(./x.png) } .b { background: url(data:image/png;base64,AAA) }`
    expect(rewriteCss(PREFIX, src)).toBe(src)
  })
})
