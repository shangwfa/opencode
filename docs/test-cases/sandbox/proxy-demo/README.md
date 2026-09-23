# Sandbox Proxy 预览台（proxy-demo）

零依赖静态页面，用于连接 opencode SaaS 的沙箱代理接口，预览沙箱内 dev server 并验证 HMR 热更新。

## 启动

```bash
# 任选一种静态服务方式（不要用 file://，fetch 需要 http origin）
cd docs/test-cases/sandbox/proxy-demo
python3 -m http.server 8088
# 打开 http://localhost:8088/
```

## 使用步骤

| 步骤 | 操作 | 说明 |
|---|---|---|
| 1 | 填 BASE / Session ID / Port → 「连接」 | BASE 默认 `http://localhost:14096`；session 不存在可点「新建 session」 |
| 2 | 「keep-alive + boot 沙箱」 | 远程创建沙箱并保活（组合 1 约 10-60s） |
| 3 | 「初始化」 | 在沙箱 `/workspace/vite-app` 创建 Vite + React Router 多路由 SPA（Home / About / Contact），含 npm install（1-3 分钟） |
| 4 | 「启动 dev server」 | `nohup` 方式启动 Vite（脱离 exec 生命周期，不会被 async exec 超时杀掉） |
| 5 | 预览 | 右侧 iframe 通过 SaaS `/session/:id/proxy/:port/` 访问；可新窗口打开 |
| 6 | 「修改代码（触发 HMR）」 | 通过 exec API 修改沙箱内 About.tsx 的 `hot-demo-vN` 标记。HMR 正常时，预览**无需刷新**自动显示新版本号与时间 |

## 验证要点

- **多路由**：预览中点击 Home / About / Contact 导航，URL 为 `/about` 形式（BrowserRouter + `window.__OC_PROXY_PREFIX__` basename 适配），刷新不丢路由
- **热更新**：点击 HMR 按钮后，iframe 内 About 页自动变化；控制台无 `[vite] failed to connect to websocket` 报错说明 HMR WebSocket（经 SaaS proxy → Sandbox Server Proxy → 沙箱）链路正常

## 已知实现要点（对应 sandbox-proxy.ts）

- 预览统一走 SaaS `/session/:id/proxy/:port/`（资源路径重写 + HMR WebSocket 转发都在 proxy 内完成），不直连 OpenSandbox Server proxy（path 前缀会导致 Vite 根相对资源与 HMR ws 错位）
- HMR WebSocket outbound 使用原生 WebSocket 桥接（`Socket.makeWebSocket` 在 raw route 下握手挂起）
- `@vite/client` 响应做占位符全量替换 + 启动时间戳 cache-bust + `Cache-Control: no-cache`，防止浏览器旧缓存 client 处理 HMR 消息
- proxy 路由显式经 Sandbox Server Proxy（`getSandboxEndpoint(..., useServerProxy)`），不经沙箱 Pod IP
- Vite HMR WebSocket 握手必须带 `Sec-WebSocket-Protocol: vite-hmr`，否则 Vite 静默忽略 upgrade
- `exec/async` 的 `timeoutSeconds` 到期会连带杀掉启动的 dev server；长驻进程需 `nohup` 脱离
- node_modules 依赖模块不做 BrowserRouter 替换（避免 react-router-dom 内部重复声明崩溃）

## 实测记录

| 日期 | 对象 | 端口 | 结果 |
|---|---|---|---|
| 2026-08-31 | 内置 3 路由 demo 模板 | 5174 | 连接/初始化/启动/多路由（Home/About/Contact + deep-link）/HMR v1→v2 无刷新/资源 193×200+18×304 零失败 ✅ |
| 2026-08-31 | xybot 真实业务项目（新增 about/contact 页面） | 5173 | deep-link `/about`、`/contact`、HMR 无刷新、资源 377×200+52×304 零失败 ✅ |

详见 [sandbox-proxy-endpoint.md 复测记录第四轮](../sandbox-proxy-endpoint.md)。

> **注意**：`previewUrl` 在「连接」时按端口计算；改端口后需**重新点「连接」**，iframe 才指向新端口（「启动 dev server」「触发 HMR」用的是输入框当前端口，与 iframe 所示端口可能不同）。
