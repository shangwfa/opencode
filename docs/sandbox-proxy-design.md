# Sandbox Proxy 代理设计文档

面向沙箱内 dev server 的 HTTP/WebSocket 反向代理，支持任意前端框架（Vite、Next.js 等）的热更新和自动错误检测。

---

## 一、架构总览

```
浏览器                              opencode 服务                        沙箱
  │                                     │                                │
  │  GET /session/{sid}/proxy/3000/     │                                │
  │────────────────────────────────────►│                                │
  │                                     │  GET http://sandbox:3000/      │
  │                                     │───────────────────────────────►│
  │                                     │  200 <html>...</html>          │
  │                                     │◄───────────────────────────────│
  │                                     │  注入 <script> 拦截器            │
  │  200 <html>+注入（不重写路径）         │                                │
  │◄────────────────────────────────────│                                │
  │                                     │                                │
  │  GET /session/{sid}/proxy/3000/     │  ← 浏览器拦截器自动加 prefix     │
  │      _next/static/chunks/*.js       │                                │
  │────────────────────────────────────►│                                │
  │                                     │  GET sandbox:3000/_next/...    │
  │                                     │───────────────────────────────►│
  │                                     │  200 JS                        │
  │                                     │◄───────────────────────────────│
  │                                     │  删除 content-encoding         │
  │  200 JS (原样透传)                   │  直接透传                       │
  │◄────────────────────────────────────│                                │
  │                                     │                                │
  │  WS /session/{sid}/proxy/3000/      │                                │
  │      _next/webpack-hmr              │  ← 浏览器拦截器自动加 prefix     │
  │═══════════════════════════════════►│                                │
  │  (浏览器 WebSocket 拦截器             │  WS sandbox:3000/_next/...     │
  │   自动加 proxy prefix)              │════════════════════════════════│
  │  双向转发                           │  双向转发                       │
  │◄══════════════════════════════════►│◄══════════════════════════════►│
  │                                     │                                │
  │  img beacon → __error_report        │                                │
  │────────────────────────────────────►│  存入 proxyErrors Map          │
  │                                     │  Bus.publish(ProxyError)       │
```

### 核心设计原则

1. **不修改前端项目本身** — 通过代理层 + 客户端注入脚本实现
2. **框架无关** — HTTP 代理适用于所有 dev server，错误捕获基于浏览器原生 API
3. **零配置** — 接入方只需在浏览器访问 proxy URL，无需任何额外设置
4. **客户端优先** — 路径改写由浏览器端拦截器在运行时完成（借鉴 bilibili/carocut），服务端只做 HTML 注入 + 纯透传

### 架构演进

| 版本 | 服务端职责 | 客户端职责 |
|---|---|---|
| v1（初始） | HTTP 转发 + HTML/JS 正则路径重写 + HTML 注入 | WS 拦截 + 错误上报 |
| **v2（当前）** | HTTP 转发 + HTML 注入 + **HTML 内联 `<script>` import 重写** + JS `import`/`from` 重写 | **13 个 API 拦截**（路径改写在客户端运行时完成）+ WS 拦截 + 错误上报 |

---

## 二、API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| ALL | `/session/:sid/proxy/:port/*` | HTTP 代理到沙箱 dev server |
| GET (WS) | `/session/:sid/proxy/:port/*` | WebSocket 升级代理（HMR） |
| GET | `/session/:sid/proxy/:port/__errors` | 查询该 port 的浏览器错误 |
| GET | `/session/:sid/proxy/:port/__error_report?e=...` | 浏览器错误上报（img beacon） |
| GET | `/session/:sid/proxy-errors` | 聚合该 session 所有端口的错误 |
| POST | `/session/:sid/kill-sandbox` | 按 session 销毁沙箱（PVC 保留） |
| POST | `/instance/dispose` | 销毁所有沙箱 + 实例 |

### 路径映射

```
浏览器请求:  /session/{sid}/proxy/3000/products
代理到:      http://{sandbox-endpoint}:3000/products

浏览器请求:  /session/{sid}/proxy/5173/src/App.jsx
代理到:      http://{sandbox-endpoint}:5173/src/App.jsx
```

---

## 三、HTTP 代理处理流程

### 3.1 请求处理

```
1. 解析 sessionID + port
2. SandboxProvider.getEndpoint(sessionID, port) → 获取沙箱 endpoint URL
3. 构造目标 URL = endpoint + subPath + queryString
4. 转发请求（剔除 host/connection header，redirect: "manual"）
5. 根据响应 Content-Type 决定处理策略
```

### 3.2 响应决策树

```
                           ┌─ Content-Type: text/html ?
                           │     → HTML 注入 + HTML 属性重写 + 内联 script import 重写
                           │
响应到达 ────────────────┤
                           │
                           ├─ Content-Type: javascript/ecmascript ?
                           │     → JS import/from 路径重写
                           │
                           └─ 其他（CSS/图片/字体/...）
                                 → 透传（仅删除 content-encoding）
```

> **v1 → v2 变更**：移除了 JS 暴力全量正则路径重写。改为三层精确重写：服务端 HTML 属性 + 内联 script + JS import/from，客户端 13 个 API 拦截器处理运行时路径。

### 3.3 HTML 处理

HTML 响应经过三层服务端改写：

**第一层：HTML 属性重写**

```javascript
// 匹配 src/href 属性中以 / 开头的路径（排除 // 协议相对 URL）
text.replace(/((?:src|href)\s*=\s*["'])\/(?!\/)/g, `$1${prefix}/`)
```

处理 `<script src="/...">`, `<link href="/...">`, `<img src="/...">` 等 HTML 标签属性。

**第二层：内联 `<script>` import 重写**

```javascript
// 匹配内联 <script> 块中的 import/from 语句
rewritten.replace(/(<script[^>]*>)([\s\S]*?)(<\/script>)/gi, (..., open, code, close) => {
  if (/\ssrc\s*=/i.test(open)) return open + code + close  // 有 src 的跳过
  return open + code.replace(/((?:import|from)\s*(?:["']))\/(?!\/)/g, `$1${prefix}/`) + close
})
```

关键原因：Vite 注入的 `@react-refresh` preamble 是内联 `<script type="module">`：
```html
<script type="module">import { injectIntoGlobalHook } from "/@react-refresh";
```
如果不重写 `from "/@react-refresh"` → 浏览器直接请求 `/@react-refresh`（绕过 proxy）→ 返回 HTML（opencode 主页）→ MIME type 错误 + `$RefreshReg$` 未定义 → Vite 白屏。

**第三层：注入拦截脚本**

```html
<head>
  <script data-oc-prefix="/session/{sid}/proxy/{port}"></script>
  <script>
    // 13 个浏览器 API 拦截器（见第六节完整列表）
  </script>
```

**服务端对 HTML 和 JS 做精确的路径重写**（不做暴力全量正则替换），客户端拦截器处理运行时路径。

### 3.6 Content-Encoding 处理

**所有响应**（不论是否重写）都删除 `content-encoding`：

| 分支 | 原因 |
|---|---|
| HTML/JS 重写 | 修改了 body，原编码失效 |
| 透传（含 chunk） | 沙箱响应可能带 gzip/br，代理层 `fetch()` 自动解码后 body 已是明文，但 header 还带 `content-encoding`，浏览器二次解码导致 `ERR_CONTENT_DECODING_FAILED` |

同时删除 `content-length`（重写后长度变化）和 `transfer-encoding`。

### 3.7 重定向处理

```javascript
if (location && location.startsWith("/")) {
  resHeaders.set("location", prefix + location)
}
```

---

## 四、WebSocket 代理

### 4.1 服务端（opencode → 沙箱）

```javascript
// Hono upgrade 中间件
.get("/session/:sid/proxy/:port/*", upgrade(async (c) => {
  // 1. 获取沙箱 endpoint
  // 2. 构造 ws:// URL
  // 3. 透传 Sec-WebSocket-Protocol
  // 4. 双向转发（String + ArrayBuffer + ArrayBufferView）
  // 5. 关闭/错误时清理
}))
```

关键点：
- 透传客户端 `Sec-WebSocket-Protocol` header（不硬编码子协议）
- 支持文本和二进制消息
- 任一端关闭时同步关闭另一端

### 4.2 浏览器端（注入的拦截器）

```javascript
var _origWS = window.WebSocket;
window.WebSocket = function(url, protocols) {
  // 以 / 开头的相对路径 → 加 prefix
  if (typeof url === "string" && url.charAt(0) === "/") {
    url = prefix + url;
  }
  // 包含 location.host 但不包含 prefix → 插入 prefix
  else if (url.indexOf(location.host) !== -1 && url.indexOf(prefix) === -1) {
    url = url.replace(location.host, location.host + prefix);
  }
  return protocols ? new _origWS(url, protocols) : new _origWS(url);
};
```

**效果**：

| 框架 | 原始 WS URL | 拦截后 |
|---|---|---|
| Next.js HMR | `/_next/webpack-hmr` | `/session/{sid}/proxy/3000/_next/webpack-hmr` |
| Vite HMR | `ws://host/session/{sid}/proxy/5173/` | 不变（已包含 prefix） |

---

## 五、错误捕获

### 5.1 拦截的浏览器事件

| 事件 | 捕获信息 |
|---|---|
| `window.addEventListener("error")` | message, filename, line, col, stack |
| `console.error(...)` | 所有参数拼接为 message |
| `window.addEventListener("unhandledrejection")` | reason.message, reason.stack |

### 5.2 上报机制

```javascript
function __ocReport(errs) {
  var img = new Image();
  img.src = prefix + "/__error_report?e=" + encodeURIComponent(JSON.stringify(errs));
}
```

使用 img beacon 的优势：
- 不受 CORS 限制
- 页面卸载时也能发送
- 不阻塞渲染

### 5.3 服务端存储

```typescript
const proxyErrors = new Map<string, ProxyError[]>()  // key: "{sessionID}:{port}"
const MAX_ERRORS = 100                                // FIFO 淘汰

type ProxyError = {
  type: "runtime" | "network" | "compile"
  message: string
  url?: string
  line?: number
  col?: number
  stack?: string
  timestamp: number
}
```

### 5.4 Bus 事件通知

```typescript
Session.Event.ProxyError = BusEvent.define("session.proxy.error", {
  sessionID, port, errors
})
```

每次上报通过 Bus 发布，支持 SSE 实时推送给前端。

---

## 六、注入脚本完整功能

`INJECT_SCRIPT(prefix)` 是一个函数，生成闭包脚本。借鉴 bilibili/carocut 方案，在浏览器运行时拦截所有路径相关 API，自动加 proxy 前缀。

### 核心路径改写函数

```javascript
// f(u): 给以 / 开头的绝对路径加 prefix，跳过 // 开头的协议相对 URL
function f(u) {
  return typeof u === "string" && u.charAt(0) === "/" && u.charAt(1) !== "/" && !u.startsWith(P) ? P + u : u
}

// fUrl(u): 处理 WebSocket URL（支持绝对 URL 如 ws://host/path）
function fUrl(u) {
  if (typeof u !== "string") return u;
  if (u.charAt(0) === "/" && u.charAt(1) !== "/") return P + u;
  // 解析绝对 URL，同 host 时加 prefix
  try { var x = new URL(u); if (x.host === location.host && ...) return ... } catch(e) {}
  return u;
}
```

### 拦截的 13 个浏览器 API

```
┌─────────────────────────────────────────────────────────────────┐
│  INJECT_SCRIPT(prefix)                                          │
│                                                                 │
│  路径改写拦截器（借鉴 carocut）                                    │
│  ─────────────────────────────                                  │
│  1. history.pushState         → f(url)                          │
│  2. history.replaceState      → f(url)                          │
│  3. window.fetch              → f(string) / fUrl(Request)       │
│  4. EventSource               → f(url)                          │
│  5. XMLHttpRequest.open       → f(url)                          │
│  6. HTMLScriptElement.src     → f(url) [defineProperty setter]  │
│  7. HTMLLinkElement.href      → f(url) [defineProperty setter]  │
│  8. HTMLImageElement.src      → f(url) [defineProperty setter]  │
│  9. HTMLMediaElement.src      → f(url) [defineProperty setter]  │
│                                                                 │
│  WebSocket 拦截器                                                │
│  ──────────────────                                              │
│  10. window.WebSocket         → fUrl(url) + 保留 prototype/常量 │
│                                                                 │
│  错误捕获                                                        │
│  ────────                                                        │
│  11. console.error            → __ocReport({type:"runtime"})    │
│  12. window.error             → __ocReport({message,line,col})  │
│  13. unhandledrejection       → __ocReport({reason.message})    │
│                                                                 │
│  上报机制                                                        │
│  ────────                                                        │
│  __ocReport(errs)             → img beacon → /__error_report    │
└─────────────────────────────────────────────────────────────────┘
```

### v1 → v2 新增的 9 个拦截器

| # | API | 拦截方式 | 用途 |
|---|-----|---------|------|
| 1 | `history.pushState` | bind 替换 | SPA 路由导航保持 proxy 前缀 |
| 2 | `history.replaceState` | bind 替换 | URL 替换保持 proxy 前缀 |
| 3 | `window.fetch` | 函数替换 | API 请求（string + Request 对象） |
| 4 | `EventSource` | 构造函数替换 | SSE 连接 |
| 5 | `XMLHttpRequest.open` | prototype 替换 | 传统 XHR 请求 |
| 6 | `HTMLScriptElement.src` | defineProperty setter | JS 脚本动态加载 |
| 7 | `HTMLLinkElement.href` | defineProperty setter | CSS 动态加载 |
| 8 | `HTMLImageElement.src` | defineProperty setter | 图片加载 |
| 9 | `HTMLMediaElement.src` | defineProperty setter | 音视频加载 |

### 边界 case 处理

| 输入 | f() 结果 | 说明 |
|------|---------|------|
| `/api/data` | `{prefix}/api/data` | 绝对路径加前缀 |
| `{prefix}/api/data` | `{prefix}/api/data` | 已有前缀，跳过 |
| `//cdn.example.com/lib.js` | `//cdn.example.com/lib.js` | 协议相对 URL，跳过 |
| `https://external.com` | `https://external.com` | 外部 URL，跳过 |
| `relative/path` | `relative/path` | 相对路径，跳过 |
| `/` | `{prefix}/` | 根路径加前缀 |

---

## 七、AI 自动错误修复流程

```
1. 用户通过浏览器访问代理页面
2. 页面 JS 执行时发生运行时错误
3. 注入脚本通过 img beacon 上报到 __error_report
4. 错误存入 proxyErrors Map + Bus 发布事件
5. AI agent 查询 __errors 端点获取错误列表
6. AI 分析错误 → 定位源码 → 自动修复
7. dev server 热更新 → 浏览器自动刷新 → 错误消失
```

---

## 八、测试验证结果

### 8.1 测试矩阵

| 测试项 | Vite 5 (Node 22.2) | Next.js 14 |
|---|---|---|
| HTTP 代理首页 200 | ✅ | ✅ |
| HTML 注入（prefix + 拦截器 + 错误捕获） | ✅ | ✅ |
| 内联 `<script>` import 重写 | ✅ `@react-refresh` 正确 prefixed | — (Next.js 无内联 import) |
| HTML src/href 属性重写 | ✅ | ✅ 全部 `_next/static/` 正确 prefixed |
| JS import/from 重写 | ✅ | ✅ |
| CSS url() 路径重写 | — | ✅ 字体 woff 正确 prefixed |
| server proxy 模式 API key | ✅ | ✅ |
| server proxy 模式 URL 构造 | ✅ | ✅ |
| Accept-Encoding: identity | ✅ | ✅ |
| WebSocket HMR | 待浏览器验证 | ✅ webpack-hmr 连接成功 |
| 错误上报端点 | ✅ | ✅ |

### 8.2 测试环境

- **沙箱 Node.js**：v22.2.0
- **Vite**：通过 `npm create vite@latest -- --template react` 创建
- **Next.js**：通过 `npx create-next-app@latest -- --js --app` 创建（16.2.6 + Turbopack）
- **opencode**：`feat/sandbox-endpoint` 分支，Docker 容器部署

### 8.3 验证的 HMR 消息

**Vite**：
```
WebSocket upgrade 成功
```

**Next.js (Turbopack)**：
```json
{"type":"isrManifest","data":{"/":true}}
{"type":"turbopack-connected","data":{"sessionId":85262462}}
{"type":"sync","errors":[],"warnings":[],"hash":"","versionInfo":{"staleness":"fresh"}}
```

---

## 九、踩坑记录与解决方案

| # | 问题 | 根因 | 解决方案 |
|---|---|---|---|
| 1 | `ERR_CONTENT_DECODING_FAILED` | `fetch()` 自动解码 gzip 但保留了 `content-encoding` header | 所有响应删除 `content-encoding` |
| 2 | `Invalid regular expression flags` | chunk 内 `eval()` 中的正则字面量被路径重写误匹配 | **v2 彻底移除服务端 JS 正则重写**，改用客户端拦截器 |
| 3 | Next.js hydration mismatch | `<base href=".../">` 尾斜杠导致 SSR/Client href 不一致 | 移除 `<base>` 标签 |
| 4 | WebSocket HMR 失败 | chunk 中 `"/_next/webpack-hmr"` 被跳过重写，浏览器连错路径 | 注入 WebSocket 拦截器自动加 prefix |
| 5 | 自闭合标签误匹配 | `<meta />` 中的 `/` 被正则当作路径开头 | **v2 已不适用**（不再做服务端正则重写） |
| 6 | 协议相对 URL 误匹配 | `"//cdn.example.com"` 被当作路径 | `f()` 函数用 `u.charAt(1) !== "/"` 排除 |
| 7 | CSS 不加载 | Next.js App Router 需要在 layout 中 `import "./globals.css"` | 不是代理问题，是项目配置 |
| 8 | JS chunk 路径错误 | 服务端正则重写会误改编译产物中的路径 | **v2 根本解决**：JS 文件只做 import/from 精确替换 |
| 9 | Vite 白屏：MIME type text/html + react preamble 失败 | HTML 内联 `<script type="module">` 中的 `import { injectIntoGlobalHook } from "/@react-refresh"` 路径未被重写，浏览器直接请求 `/@react-refresh`（绕过 proxy）返回 HTML | 增加内联 `<script>` import 重写（第二层）|
| 10 | server proxy 模式下 404 | `new URL(subPath, endpoint)` 当 endpoint 含路径时会覆盖整个路径。如 `new URL("/", "http://x/sandboxes/id/proxy/5173")` → `http://x/` | 改用 `new URL(endpoint + subPath)` 字符串拼接 |
| 11 | server proxy 模式下 401 | proxy fetch 未携带 `OPEN-SANDBOX-API-KEY` header | 从 `Flag.OPENCODE_SANDBOX_API_KEY` 读取并注入 header |
| 12 | server proxy 模式下 ZlibError | sandbox server proxy 返回压缩响应，Bun fetch 解压失败 | 请求头设置 `Accept-Encoding: identity` 禁止压缩 |
| 13 | Next.js 字体加载失败 OTS parsing error | CSS `@font-face { src: url(/_next/static/media/xxx.woff) }` 中的路径未被重写，浏览器请求了错误路径返回 HTML | 增加 CSS `url()` 路径重写分支 |
| 14 | SPA 客户端路由（React Router）路径不匹配 | 路由框架读 `location.pathname` 看到带 proxy prefix 的路径，匹配不到 `/about` 等路由 | **不可透明解决**：patch `location.pathname` getter 会导致 `replaceState` 无限递归；`replaceState` 去 prefix 会导致刷新 404。需应用侧配 `basename`（见下方说明）|
| 15 | webpack publicPath 未重写 | `__webpack_require__.p = "/_next/"` 在 JS 文件中，动态 chunk 加载路径错误 | JS 重写中匹配 webpack publicPath |

---

## 十、SPA 客户端路由的限制

### 问题

SPA 框架（React Router、Vue Router）通过 `window.location.pathname` 匹配路由。proxy prefix（如 `/session/{sid}/proxy/5173`）导致路由匹配失败。

### 尝试过的方案及结论

| 方案 | 结果 | 原因 |
|---|---|---|
| patch `location.pathname` getter 去 prefix | ❌ `replaceState` 无限递归 | 路由框架发现 pathname 和 URL 不一致，不停调 replaceState 同步 |
| `history.replaceState` 去掉 prefix | ❌ 刷新 404 | 地址栏变成干净路径，刷新请求不经过 proxy |
| patch `location.pathname` + 不拦截 pushState/replaceState | ❌ 同上递归 | 框架内部的 replaceState 仍然触发循环 |

### 最终结论

**SPA 客户端路由无法通过 proxy 层完全透明解决**。这是 path-prefix proxy 的固有限制（nginx 的 proxy_pass 也有同样问题）。

### 推荐方案

对于需要 SPA 路由的项目，应用侧需要配置 `basename`：

```tsx
// React Router — 从注入的 data-oc-prefix 读取
const prefix = document.querySelector("script[data-oc-prefix]")?.getAttribute("data-oc-prefix") || ""
<BrowserRouter basename={prefix}>

// Vue Router
const router = createRouter({
  history: createWebHistory(document.querySelector("script[data-oc-prefix]")?.getAttribute("data-oc-prefix") || "/"),
})

// Next.js — 不需要，SSR 框架路由由服务端处理，proxy 已通过 RSC 数据重写解决
```

> **注意**：Next.js App Router **不受此限制**，因为路由由服务端 RSC 数据驱动，proxy 已通过内联 script JSON 路径重写解决（见踩坑 #6）。

---

### 9.1 安全与健壮性加固（代码审查后修复）

| 类别 | 改进内容 |
|---|---|
| **DoS 防护** | `__error_report` 端点限制 query 大小 ≤ 10KB，单次最多 10 条错误，字段截断（message ≤ 2048, stack ≤ 4096） |
| **Schema 校验** | 错误上报做严格类型 map，非法 type 归为 `"runtime"`，非 array 输入直接忽略 |
| **WebSocket 竞态** | 上游连接 OPEN 前缓冲客户端消息到 queue，onopen 时 flush |
| **WebSocket 容错** | endpoint 获取失败时直接关闭 ws（1011），port 非法时返回空 handler |
| **HTTP 容错** | `fetch()` 包裹 try/catch，网络异常返回 `502 sandbox unreachable` |
| **skipRewrite 扩展** | 正则扩大到 `/_next/`, `/_nuxt/`, `/assets/`, `/build/`, `/static/` 的 `chunks/js/css/media` 子目录 |
| **大文件跳过** | JS/HTML 响应超过 5MB 时跳过路径重写（避免内存暴增） |
| **内存泄漏** | `clearErrors(sessionID)` 在 kill-sandbox 时清理该 session 的所有错误记录 |
| **Location 绝对 URL** | 重定向的 Location 如果以 endpoint URL 开头，也做前缀替换 |
| **未用导入** | 删除 `Ref` import |

---

## 十一、源码位置

| 文件 | 职责 | 说明 |
|---|---|---|
| `src/server/instance/sandbox-proxy.ts` | 代理核心模块（~330行） | HTTP 代理（HTML 三层重写 + JS import 重写）+ WS 代理 + 错误收集。导出 `SandboxProxyRoutes(upgrade)` + `clear(sessionID)` |
| `src/server/instance/index.ts` | 路由注册入口 | `.route("/", SandboxProxyRoutes(upgrade))` 挂载，kill-sandbox 时调用 `clearProxyErrors` |
| `src/session/index.ts` | `Session.Event.ProxyError` 事件定义 | Bus 事件 |
| `src/tool/sandbox-provider.ts` | `getEndpoint(sessionID, port)` | 沙箱地址解析 |
| `src/tool/bash.ts` | `background: true` 后台化 + keepAlive | 已有 |
| `src/session/run-state.ts` | `onIdle` 检查 keepAlive | 已有 |

---

## 十二、接入方使用指南

### 1. 启动 dev server

```
POST /session/{sid}/message
{"parts":[{"type":"text","text":"bash background:true 在 /workspace/my-app 执行 npm run dev -- --host 0.0.0.0 --port 3000"}]}
```

`background:true` 让进程后台运行，沙箱不会空闲回收。

### 2. 浏览器访问

```
http://{opencode-host}/session/{sid}/proxy/3000/
```

### 3. 查询浏览器错误

```
GET /session/{sid}/proxy/3000/__errors
→ [{"type":"runtime","message":"TypeError: ...","line":42,"timestamp":...}]
```

### 4. 让 AI 自动修复

```
POST /session/{sid}/message
{"parts":[{"type":"text","text":"检查浏览器有没有报错，如果有就修复"}]}
```

AI 内部流程：`curl __errors` → 分析 → 修改代码 → dev server 热更新。

---

## 十三、后续计划

- [ ] 沙箱镜像升级 Node >= 22.12，支持 Vite 6 原生
- [x] ~~代理逻辑抽成独立模块~~ → 已完成（`sandbox-proxy.ts`）
- [x] ~~路径重写改为 context-aware~~ → v2 采用客户端拦截方案，更彻底
- [ ] 错误存储持久化到 PG（当前为内存，重启丢失）
- [ ] 支持 SSE 实时推送错误到前端（基于已有 Bus 事件）
- [ ] `/instance/dispose` 职责拆分
- [ ] 补充 `window.open` / `Worker` / `SharedWorker` 拦截（按需）
- [ ] 浏览器测试：验证 Vite + Next.js 完整功能（需通过 SaaS API keepalive 模式启动 dev server）

---

## 十四、测试方法

### 14.1 通过 SaaS API 启动 dev server 并测试

> **重要**：必须通过 AI 执行 `bash` 工具并以 `background:true` 启动 dev server。`bash.ts` 中 `background:true` 会自动调用 `sandboxProvider.keepAlive(ctx.sessionID)`，防止沙箱被空闲回收。直接发 HTTP 请求到 proxy 不会触发 sandbox 创建。

```bash
# 1. 创建 session
SID=$(curl -s -X POST http://localhost:14096/session -H 'Content-Type: application/json' -d '{}' | jq -r .id)

# 2. 让 AI 在沙箱里创建项目并启动 Vite（background:true 触发 keepalive）
curl -X POST http://localhost:14096/session/$SID/message \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"使用 bash 工具，background:true，执行以下步骤：1. cd /workspace && bunx create-vite vite-test --template react-ts 2. cd vite-test && bun install 3. npx vite --host 0.0.0.0 --port 5173"}],
    "model": {"providerID":"moonshotai-cn","modelID":"kimi-k2.6"}
  }'

# 3. AI 执行完后，浏览器访问 proxy URL
# http://localhost:14096/session/{SID}/proxy/5173/

# 4. 验证错误上报
curl http://localhost:14096/session/$SID/proxy/5173/__errors
curl http://localhost:14096/session/$SID/proxy-errors
```

#### keepalive 机制说明

```
bash.ts (background:true)
  → sandboxProvider.keepAlive(sessionID)
    → leases.add(sessionID)
    → run-state.ts onIdle 检查 isKeepAlive → 跳过回收
```

| 场景 | sandbox 行为 |
|---|---|
| 未启动 keepalive | AI 消息处理完成后（`session.idle`）立即销毁 |
| `background:true` 执行命令 | keepalive 激活，sandbox 不回收 |
| `POST /instance/dispose` | 强制销毁所有 sandbox（即使 keepalive） |

> `OPENCODE_SANDBOX_IDLE_KILL_SEC=30` 在 opencode 代码中**未被实际使用**，回收由 `run-state.ts` `onIdle` 回调控制（session runner 空闲 + 无 keepAlive 时销毁）。

#### 容器重启后注意事项

Docker 容器重启后内存中的 sandbox Map 清空，需要：
1. 创建新 session（或复用旧 session）
2. 通过 AI `bash` 工具重新启动 dev server（会自动创建新 sandbox + keepalive）
3. PVC 卷数据会保留（`OPENCODE_SANDBOX_VOLUME_TYPE=pvc`），但进程需要重启

### 14.2 本地测试环境配置

> 完整的本地测试流程（TCP 转发、容器启动、dev server 启动、keepAlive 说明、常见问题）见独立文档：
>
> **`docs/local-test-env.md`**

关键要点：
- 容器必须使用远端 PG（`172.18.32.14:5432`，含 AI provider key），不能用本地 PG
- 必须设置 `OPENCODE_SANDBOX_USE_SERVER_PROXY=true`
- Docker 容器无法直连远端 IP，需要宿主机 TCP 转发（`host.docker.internal:15432/30040`）
- 启动 dev server **必须用 `background:true`**，否则 sandbox 被立即回收


### 14.3 静态验证（不需要沙箱）

```bash
# 验证注入脚本语法
node -e "new Function('window','document','history','location','XMLHttpRequest','HTMLScriptElement','HTMLLinkElement','HTMLImageElement','HTMLMediaElement','console','Request','EventSource','Image', require('fs').readFileSync('packages/opencode/src/server/instance/sandbox-proxy.ts','utf8').match(/const INJECT_SCRIPT[^>]+<\/script>/)[0].replace(/.*<script>/,'').replace(/<\/script>.*/,''))"
```

### 14.4 测试验证清单

| # | 测试项 | 验证方法 |
|---|--------|----------|
| 1 | HTML 页面加载 | 浏览器打开 proxy URL，页面渲染 |
| 2 | CSS 样式 | 页面样式正确（HTMLLinkElement.href setter 拦截） |
| 3 | JS 加载 | DevTools Network 所有 JS 200（HTMLScriptElement.src setter 拦截） |
| 4 | WebSocket HMR | 修改文件，浏览器自动热更新 |
| 5 | SPA 路由 | 点击导航，URL 保持 proxy 前缀（history.pushState 拦截） |
| 6 | fetch 请求 | 如有 API 调用，请求路径正确（fetch 拦截器） |
| 7 | XHR 请求 | 如有旧式 XHR，请求路径正确（XMLHttpRequest.open 拦截） |
| 8 | 错误上报 | console.error / window.error → 检查 `__errors` 端点 |
| 9 | proxy-errors 聚合 | GET `/proxy-errors` 返回错误列表 |
| 10 | Next.js Turbopack | 完整测试 Next.js 16.x HMR |

---

## 十五、参考项目

| 项目 | 架构 | 客户端拦截 API 数 | 与本方案差异 |
|---|---|---|---|
| **bilibili/carocut** | 服务端 path-prefix + 客户端 JS 注入（混合） | 9 个 | 单 session 单端口（Remotion Studio），无错误上报 |
| **zts212653/clowder-ai** | 混合方案，query param 路由 | 部分 | 有 WS 修补脚本 |
| **本方案 (v2)** | 服务端 path-prefix + 客户端 JS 注入（混合） | **13 个** | 多端口支持 + 错误上报 + img beacon |
