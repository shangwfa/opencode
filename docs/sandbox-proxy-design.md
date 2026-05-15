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
  │                                     │  重写路径 → 加 proxy prefix     │
  │  200 <html>+注入+重写                │                                │
  │◄────────────────────────────────────│                                │
  │                                     │                                │
  │  GET /session/{sid}/proxy/3000/     │                                │
  │      _next/static/chunks/*.js       │                                │
  │────────────────────────────────────►│                                │
  │                                     │  GET sandbox:3000/_next/...    │
  │                                     │───────────────────────────────►│
  │                                     │  200 JS (gzip)                 │
  │                                     │◄───────────────────────────────│
  │                                     │  删除 content-encoding         │
  │  200 JS (decoded, 不重写)            │  直接透传                       │
  │◄────────────────────────────────────│                                │
  │                                     │                                │
  │  WS /session/{sid}/proxy/3000/      │                                │
  │      _next/webpack-hmr              │                                │
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

1. **不修改前端项目本身** — 通过代理层路径重写 + 注入脚本实现
2. **框架无关** — HTTP 代理适用于所有 dev server，错误捕获基于浏览器原生 API
3. **零配置** — 接入方只需在浏览器访问 proxy URL，无需任何额外设置

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
                         │     → HTML 重写分支（注入脚本 + 路径重写）
                         │
响应到达 ────────────────┤─ Content-Type: JS 且 非 _next/static/chunks/ ?
                         │     → JS 重写分支（路径重写）
                         │
                         └─ 其他（CSS、图片、字体、chunk JS...）
                               → 透传（仅删除 content-encoding）
```

### 3.3 HTML 处理

在 `<head>` 后注入：

```html
<head>
  <script data-oc-prefix="/session/{sid}/proxy/{port}"></script>
  <script>
    // WebSocket 构造函数拦截器
    // console.error / window.error / unhandledrejection 捕获
    // img beacon 错误上报
  </script>
```

然后对整个 HTML 执行路径重写正则。

### 3.4 路径重写正则

```javascript
/(["'])((?!{escapedPrefix}|\/\/)/[^"'>]*)(?=["'])/g
→ $1{prefix}$2
```

**含义**：匹配单/双引号包裹的、以 `/` 开头的路径，在前面加 proxy prefix。

**排除**：
- 已包含 prefix 的路径（避免重复）
- `//` 开头的协议相对 URL（`//cdn.example.com`）
- 引号后跟 `>` 的自闭合标签（`<meta />`）

### 3.5 Chunk 跳过策略

```javascript
const skipRewrite = /\/_next\/static\/chunks\//.test(target.pathname)
```

**为什么必须跳过？**

Next.js webpack/turbopack chunks 是编译产物，内含：
- `eval()` 包裹的模块代码
- 字符串中的正则字面量（如 `react-refresh-runtime` 的 `/regex/flags`）

路径重写正则会误匹配正则字面量中的 `/` 字符，导致：
```
Uncaught SyntaxError: Invalid regular expression flags
```

chunk 内的路径引用已是正确的相对路径，无需重写。

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

`PROXY_INJECT_SCRIPT(prefix)` 是一个函数，生成闭包脚本：

```
┌─────────────────────────────────────────────────────┐
│  PROXY_INJECT_SCRIPT(prefix)                        │
│                                                     │
│  1. WebSocket 拦截器                                 │
│     - 覆盖 window.WebSocket                          │
│     - 以 / 开头的 URL → 加 prefix                    │
│     - 含 host 但无 prefix 的 URL → 插入 prefix        │
│     - 保留 prototype + 静态属性                       │
│                                                     │
│  2. console.error 拦截                               │
│     - 保留原始输出                                    │
│     - 额外上报 {type:"runtime", message, timestamp}  │
│                                                     │
│  3. window error 事件                                │
│     - 捕获未处理异常                                  │
│     - 上报 message + filename + line + col + stack   │
│                                                     │
│  4. unhandledrejection 事件                          │
│     - 捕获未处理 Promise 拒绝                         │
│     - 上报 reason.message + reason.stack             │
│                                                     │
│  5. __ocReport(errs)                                │
│     - img beacon → prefix + /__error_report?e=...   │
└─────────────────────────────────────────────────────┘
```

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

| 测试项 | Vite (latest, 6.x) | Next.js 16.2.6 (Turbopack) |
|---|---|---|
| HTTP 代理首页 200 | ✅ | ✅ |
| HTML 注入（prefix + WS拦截 + 错误捕获） | ✅ | ✅ |
| 无 `<base>` 标签 | ✅ | ✅ |
| JS 资源可达 | ✅ | ✅ |
| CSS 加载 | ✅ | ✅ (5318 bytes) |
| content-encoding 已删除 | ✅ | ✅ |
| 路径重写正确 | ✅ | ✅ |
| WebSocket HMR 连接 | ✅ (upgrade 成功) | ✅ (turbopack-connected) |
| 错误上报端点 | ✅ | ✅ |
| 错误查询端点 | ✅ | ✅ |
| proxy-errors 聚合 | ✅ | ✅ |

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
| 2 | `Invalid regular expression flags` | chunk 内 `eval()` 中的正则字面量被路径重写误匹配 | `skipRewrite` 跳过框架 bundle 目录 |
| 3 | Next.js hydration mismatch | `<base href=".../">` 尾斜杠导致 SSR/Client href 不一致 | 移除 `<base>` 标签 |
| 4 | WebSocket HMR 失败 | chunk 中 `"/_next/webpack-hmr"` 被跳过重写，浏览器连错路径 | 注入 WebSocket 拦截器自动加 prefix |
| 5 | 自闭合标签误匹配 | `<meta />` 中的 `/` 被正则当作路径开头 | 正则排除引号后紧跟 `>` 的情况 |
| 6 | 协议相对 URL 误匹配 | `"//cdn.example.com"` 被当作路径 | 正则负向前瞻排除 `//` |
| 7 | CSS 不加载 | Next.js App Router 需要在 layout 中 `import "./globals.css"` | 不是代理问题，是项目配置 |

---

## 九-B、安全与健壮性加固（代码审查后修复）

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

## 十、源码位置

| 文件 | 职责 | 核心行 |
|---|---|---|
| `src/server/instance/index.ts` | 代理路由 + 注入脚本 + 错误存储 | L35-310 |
| `src/session/index.ts` | `Session.Event.ProxyError` 事件定义 | +16 行 |
| `src/tool/sandbox-provider.ts` | `getEndpoint(sessionID, port)` | +13 行 |
| `src/tool/bash.ts` | `background: true` 后台化 + keepAlive | 已有 |
| `src/session/run-state.ts` | `onIdle` 检查 keepAlive | 已有 |

---

## 十一、接入方使用指南

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

## 十二、后续计划

- [ ] 沙箱镜像升级 Node >= 22.12，支持 Vite 6 原生
- [ ] 路径重写改为 context-aware（HTML 用 attribute parser，JS 只重写 `fetch()`/`import()` 参数）
- [ ] 错误存储持久化到 PG（当前为内存，重启丢失）
- [ ] 支持 SSE 实时推送错误到前端（基于已有 Bus 事件）
- [ ] `/instance/dispose` 职责拆分
- [ ] 代理逻辑抽成独立模块 `sandbox-proxy.ts`（当前内联在 InstanceRoutes）
