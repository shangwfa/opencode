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

  test("export default API 路径常量不误伤（无资源扩展名，本次修复）", () => {
    const out = rewriteJs(PREFIX, `export default "/api/users"`)
    expect(out).toBe(`export default "/api/users"`)
  })

  test("export default 常见资源扩展名重写不受影响", () => {
    for (const p of ["/src/assets/bg.png", "/src/assets/logo.svg?t=raw", "/src/style.css", "/src/fonts/x.woff2", "/src/media/v.mp4"]) {
      const out = rewriteJs(PREFIX, `export default "${p}"`)
      expect(out).toContain(PREFIX)
    }
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

  test("字符串文案里的单词 from 不误伤（语句锚定，本次修复）", () => {
    const out = rewriteJs(PREFIX, `var tip = 'Learn from "/docs" page';var s2 = "data from /old";`)
    expect(out).toBe(`var tip = 'Learn from "/docs" page';var s2 = "data from /old";`)
  })

  test("minified 语句形态的 from 重写不受影响", () => {
    const out = rewriteJs(PREFIX, `;import{useState}from"/node_modules/.vite/deps/react.js?v=x";export{helper}from"/src/helper.ts";`)
    expect(out).toContain(`from"${PREFIX}/node_modules/.vite/deps/react.js?v=x"`)
    expect(out).toContain(`from"${PREFIX}/src/helper.ts"`)
  })

  test("import * as ns from 重写（语句锚定）", () => {
    const out = rewriteJs(PREFIX, `import * as ns from "/src/ns.ts";`)
    expect(out).toBe(`import * as ns from "${PREFIX}/src/ns.ts";`)
  })

  test("JSDoc 块注释与 import 挤同一行重写（esbuild 保留源码注释的真实产物，T11.40）", () => {
    // esbuild 转换 TSX 时保留顶部 JSDoc，产物为 "...;\n/**\n * 中文说明\n */ import x from ..."：
    // */ 不在标点锚定集合里 → 漏改写 → 根路径请求 → SPA HTML → Strict MIME 拒执行
    const src = `var _s = $RefreshSig$();\n/**\n * 客户健康度看板首页 — 支持在线数据刷新\n */ import __vite__cjsImport3_react from "/node_modules/.vite/deps/react.js?v=be51c6fe"; const React = 1;`
    const out = rewriteJs(PREFIX, src)
    expect(out).toContain(`from "${PREFIX}/node_modules/.vite/deps/react.js?v=be51c6fe"`)
    expect(out).not.toContain(`from "/node_modules/`)
  })

  test("单行块注释 + import 同行重写", () => {
    const out = rewriteJs(PREFIX, `;/* 说明 */import x from "/src/a.ts";`)
    expect(out).toBe(`;/* 说明 */import x from "${PREFIX}/src/a.ts";`)
  })

  test("行注释 + 换行 import 重写", () => {
    const out = rewriteJs(PREFIX, `;// note\nimport x from "/src/a.ts";`)
    expect(out).toBe(`;// note\nimport x from "${PREFIX}/src/a.ts";`)
  })

  test("注释夹在 import 与 from 之间重写（vite esbuild 转换罕见形态，固化行为）", () => {
    const out = rewriteJs(PREFIX, `import/*interop*/y from "/src/a.ts";`)
    expect(out).toBe(`import/*interop*/y from "${PREFIX}/src/a.ts";`)
  })

  test("多星注释结尾 **/import 重写（锚定 \\*+/? 分支）", () => {
    const out = rewriteJs(PREFIX, `;/*x**/import x from "/src/a.ts";`)
    expect(out).toBe(`;/*x**/import x from "${PREFIX}/src/a.ts";`)
  })

  test("注释掉的 import 块内路径被改写（无害：注释不执行；换行锚定独立生效且回溯有界）", () => {
    const out = rewriteJs(PREFIX, `;/* unclosed\nimport x from "/src/a.ts";`)
    expect(out).toBe(`;/* unclosed\nimport x from "${PREFIX}/src/a.ts";`)
  })

  test("同一行未闭合块注释吞掉的 import 不重写（无锚定可达，性能有界）", () => {
    const src = `;/* x import y from "/src/a.ts"`
    expect(rewriteJs(PREFIX, src)).toBe(src)
  })

  test("字符串内嵌「语句头+注释+import from」形态会被改写（已知边界：正则无法区分字符串与代码）", () => {
    // 实际影响仅在字符串被当作模块路径 eval/import 时产生，与收紧前泛匹配版本的取舍一致
    const out = rewriteJs(PREFIX, `var doc = ';\n/** note */ import y from "/src/x.ts"';`)
    expect(out).toContain(`from "${PREFIX}/src/x.ts"`)
  })

  test("JSDoc 注释 + export from 重写", () => {
    const out = rewriteJs(PREFIX, `/** helpers */export { helper } from "/src/helper.ts";`)
    expect(out).toContain(`from "${PREFIX}/src/helper.ts"`)
  })

  test("注释中间行不构成锚定：仅跨越空白与 */，文本不误伤", () => {
    const src = `var tip = "Learn from /docs";`
    expect(rewriteJs(PREFIX, src)).toBe(src)
  })

  test("import \"/x\" 无 from 形态重写保留（import 关键字直接跟引号）", () => {
    const out = rewriteJs(PREFIX, `import "/src/styles.css";`)
    expect(out).toBe(`import "${PREFIX}/src/styles.css";`)
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
    // 运行时硬跳转兜底 patch：pushState/replaceState 第三参、window.open 首参走 f() 加前缀
    expect(out).toContain(`history.pushState=function`)
    expect(out).toContain(`history.replaceState=function`)
    expect(out).toContain(`window.open=function`)
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

  test("内联 script 中 export default 资源字符串重写（与 rewriteJs 语义一致）", () => {
    const html = `<html><head></head><body><script type="module">export default "/src/assets/inline.png";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`export default "${PREFIX}/src/assets/inline.png"`)
  })
})

describe("rewriteHtml - 正则字面量防误伤（本次修复）", () => {
  test("minified 正则字面量 /'/g、/\"/g、/>/g 不被注入 prefix（code-inspector preact 产物实测样本）", () => {
    const html = `<html><head></head><body><script>var Yt=/>/g,Wt=/'/g,Ft=/"/g,z=RegExp(">|[^x]","g");</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`Wt=/'/g`)
    expect(out).toContain(`Ft=/"/g`)
    expect(out).toContain(`Yt=/>/g`)
    // 注入特征：prefix 出现在正则定界符内（/g 前粘上 prefix）
    expect(out).not.toMatch(new RegExp(`/${PREFIX.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/g`))
  })

  test("内联 script 中普通字符串路径不重写（运行时由 INJECT_SCRIPT patch 兜底）", () => {
    const html = `<html><head></head><body><script>fetch("/api/data");</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`fetch("/api/data")`)
  })

  test("常见业务正则字面量形态不被注入（URL 协议、字符类、flags 组合）", () => {
    const html = `<html><head></head><body><script>var r1=/^https?:\\/\\//;var r2=/[a-z]+/gi;var r3=/\\d{2,4}/;var r4=/[\\/]/;</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`r1=/^https?:\\/\\//`)
    expect(out).toContain(`r2=/[a-z]+/gi`)
    expect(out).toContain(`r3=/\\d{2,4}/`)
    expect(out).toContain(`r4=/[\\/]/`)
  })

  test("除法与正则混合的 minified 表达式保持原样", () => {
    const html = `<html><head></head><body><script>var pct=a/b/g;var esc=c.replace(/"/g,"&quot;");</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`a/b/g`)
    expect(out).toContain(`c.replace(/"/g,"&quot;")`)
  })
})

describe("rewriteHtml - 内联 script 静态 import（补全）", () => {
  test("内联 script 静态 import from 重写", () => {
    const html = `<html><head></head><body><script type="module">import x from "/src/inline-mod.ts";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`import x from "${PREFIX}/src/inline-mod.ts"`)
  })

  test("内联 script JSDoc 块注释与 import 挤同一行重写（与 rewriteJs 一致）", () => {
    const html = `<html><head></head><body><script type="module">/** 说明 */import x from "/src/inline-mod.ts";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`import x from "${PREFIX}/src/inline-mod.ts"`)
  })

  test("内联 script 多行 JSDoc 与 import 挤同一行重写（真实 esbuild 产物形态）", () => {
    const html = `<html><head></head><body><script type="module">var s = 1;\n/**\n * 页面说明\n */ import x from "/src/inline-mod.ts";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`import x from "${PREFIX}/src/inline-mod.ts"`)
  })

  test("vite react-refresh preamble 形态重写（内联 script 首行、/@react-refresh）", () => {
    const html = `<html><head></head><body><script type="module">import RefreshRuntime from "/@react-refresh";
import { useState } from "/node_modules/.vite/deps/react.js?v=abc";
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`from "${PREFIX}/@react-refresh"`)
    expect(out).toContain(`from "${PREFIX}/node_modules/.vite/deps/react.js?v=abc"`)
  })

  test("硬跳转路径已带 prefix 不双写", () => {
    const html = `<html><head></head><body><script>location.href = "${PREFIX}/login";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`location.href = "${PREFIX}/login"`)
    expect(out).not.toContain(`${PREFIX}/session/`)
  })

  test("内联 script 动态 import 带 /* @vite-ignore */ 注释形态重写", () => {
    const html = `<html><head></head><body><script type="module">const m = await import(/* @vite-ignore */ "/src/lazy.ts");</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`import(/* @vite-ignore */ "${PREFIX}/src/lazy.ts")`)
  })

  test("内联 script 单引号 import 重写", () => {
    const html = `<html><head></head><body><script type="module">import '/src/style.css';</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`import '${PREFIX}/src/style.css'`)
  })

  test("内联 script 协议相对与完整 URL 不重写", () => {
    const html = `<html><head></head><body><script type="module">import a from "//cdn.example.com/lib.js";import b from "https://esm.sh/x";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`import a from "//cdn.example.com/lib.js"`)
    expect(out).toContain(`import b from "https://esm.sh/x"`)
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

  test("协议相对 url(//cdn) 不破坏（本次修复）", () => {
    const out = rewriteCss(PREFIX, `.a { background: url(//cdn.example.com/x.png); } .b { background: url('//cdn.example.com/y.png'); }`)
    expect(out).toContain(`url(//cdn.example.com/x.png)`)
    expect(out).toContain(`url('//cdn.example.com/y.png')`)
  })

  test("已带 prefix 的 url() 不双写（本次修复）", () => {
    const src = `.a { background: url(${PREFIX}/assets/bg.png); }`
    expect(rewriteCss(PREFIX, src)).toBe(src)
  })
})

describe("rewriteHtml - 硬跳转路径重写（Location 无法运行时 patch，静态精准锚定）", () => {
  test("内联 script location.href 赋值重写", () => {
    const html = `<html><head></head><body><script>function logout(){location.href = "/login";}</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`location.href = "${PREFIX}/login"`)
  })

  test("minified 紧凑形态 location.href=\"/x\" 重写", () => {
    const html = `<html><head></head><body><script>location.href="/login?next=/home";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`location.href="${PREFIX}/login?next=/home"`)
  })

  test("window.location 对象赋值与 pathname 赋值重写", () => {
    const html = `<html><head></head><body><script>window.location = "/home";location.pathname = "/profile";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`window.location = "${PREFIX}/home"`)
    expect(out).toContain(`location.pathname = "${PREFIX}/profile"`)
  })

  test("location.assign / location.replace 字面量重写", () => {
    const html = `<html><head></head><body><script>location.assign("/a");location.replace("/b");</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`location.assign("${PREFIX}/a")`)
    expect(out).toContain(`location.replace("${PREFIX}/b")`)
  })

  test("协议相对与完整 URL 的硬跳转不重写", () => {
    const html = `<html><head></head><body><script>location.href = "https://sso.example.com/login";location.href = "//cdn.example.com/x";</script></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`location.href = "https://sso.example.com/login"`)
    expect(out).toContain(`location.href = "//cdn.example.com/x"`)
  })
})

describe("rewriteJs - 硬跳转路径重写（与 rewriteHtml 一致）", () => {
  test("JS 模块内 location.href 赋值重写", () => {
    const out = rewriteJs(PREFIX, `export function go(){ location.href = "/login"; }`)
    expect(out).toContain(`location.href = "${PREFIX}/login"`)
  })

  test("JS 模块内 location.assign/replace 重写", () => {
    const out = rewriteJs(PREFIX, `location.assign("/a");location.replace("/b");`)
    expect(out).toContain(`location.assign("${PREFIX}/a")`)
    expect(out).toContain(`location.replace("${PREFIX}/b")`)
  })

  test("变量赋值形态不误伤（运行时由 pushState/open patch 兜底）", () => {
    const src = `var target = "/login"; location.href = target;`
    expect(rewriteJs(PREFIX, src)).toBe(src)
  })
})

describe("rewriteHtml - 属性重写防御（本次修复）", () => {
  test("已带 prefix 的 src/href 不双写", () => {
    const html = `<html><head></head><body><script type="module" src="${PREFIX}/src/main.tsx"></script><link rel="stylesheet" href="${PREFIX}/src/a.css"></body></html>`
    const out = rewriteHtml(PREFIX, html)
    expect(out).toContain(`src="${PREFIX}/src/main.tsx"`)
    expect(out).toContain(`href="${PREFIX}/src/a.css"`)
    expect(out).not.toContain(`${PREFIX}/session/`)
  })

  test("含正则特殊字符的 prefix 不抛错且属性重写正确", () => {
    const trickyPrefix = "/session/ses(a)[b]/proxy/5173"
    const html = `<html><head></head><body><script type="module" src="/src/main.tsx"></script></body></html>`
    const out = rewriteHtml(trickyPrefix, html)
    expect(out).toContain(`src="${trickyPrefix}/src/main.tsx"`)
    expect(out).not.toContain(`${trickyPrefix}/session/`)
  })
})
