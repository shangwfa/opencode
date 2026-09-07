# browser-cdp 镜像 — 常驻 CDP 浏览器 + 实时画面 viewer

`docker/browser` 镜像的变体：内置常驻 headless Chromium，通过 **CDP 网关**透出 `0.0.0.0:9222`，
外部可直接控制沙箱中的浏览器，并可用内嵌的 **/viewer 页面**实时观看操作画面（基于 CDP
`Page.startScreencast`，无需 VNC）。其余内容（Node/pnpm/Playwright Chromium/codegraph/LSP
daemon/插件 agent/PTY agent）与 `docker/browser` 完全一致。

## 架构

```
外部客户端(Playwright/Puppeteer/前端页面)
   │  direct endpoint (pod-ip:9222)  或  sandbox-proxy (/session/:id/proxy/9222/...)
   ▼
cdp-gateway (node, 0.0.0.0:9222)        viewer.html (GET /viewer)
   │  改写 Host 头（绕过 Chrome 对非 IP/localhost Host 的 400 校验）
   │  改写 /json* 响应中的 webSocketDebuggerUrl（127.0.0.1 → 外部地址）
   │  WebSocket upgrade 双向透传
   ▼
Chromium headless (127.0.0.1:9221, CDP)
```

| 文件 | 安装位置 | 作用 |
|---|---|---|
| `cdp-gateway.mjs` | `/opt/cdp-browser/` | HTTP/WS 转发 + Host/URL 重写 + serve viewer |
| `viewer.html` | `/opt/cdp-browser/` | 实时画面页：screencast 播放 + 鼠标/键盘回传控制 |
| `cdp-browser.sh` | `/opt/cdp-browser/` | `start/stop/status/restart` 管理 |

零新增 npm 依赖；gateway 为纯 Node 实现。

## 构建

```bash
cd packages/opencode
docker build -t opencode-saas-sandbox-cdp:<tag> -f docker/browser-cdp/Dockerfile .
```

## 沙箱内启动

entrypoint 被 OpenSandbox 接管，浏览器不会随沙箱自启，需拉起一次（幂等，重复执行安全）：

```bash
/opt/cdp-browser/cdp-browser.sh start
```

仓库侧若要随会话自动拉起，仿照 `session-plugin-runtime.ts` 的
`runInSession(...) + getEndpoint(sessionID, port) 健康轮询` 模式执行上述命令即可。

## 连接方式

设 `EP` 为沙箱 CDP endpoint（二选一）：

```bash
# 直连（K8s 内网可达时）：GET /session/:sid/endpoint/9222 返回 directUrl
EP=http://<pod-ip>:9222
# 或经 sandbox-proxy：
EP=https://<opencode-host>/session/<sid>/proxy/9222
```

**实时画面（前端页面显示）**：浏览器打开

```
${EP}/viewer
```

页面自动适配直连/代理、ws/wss；支持多标签页切换、新建标签页，并把鼠标点击/滚轮/键盘
回传给沙箱浏览器（即 viewer 本身也能操控浏览器）。可将该 URL 用 iframe 嵌入前端。

**外部控制（Playwright / Puppeteer）**：

```ts
// Playwright：拿到的是 http(s) endpoint，直接 connectOverCDP
const browser = await chromium.connectOverCDP(EP)
```

```js
// Puppeteer
const browser = await puppeteer.connect({ browserURL: EP })
```

**沙箱内 agent-browser 复用同一浏览器**（避免它另行拉起实例）：

```bash
agent-browser --cdp 9222 snapshot
```

## 配置（环境变量，均有默认值）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CDP_GATEWAY_PORT` | `9222` | 网关对外端口（endpoint 解析用这个） |
| `CDP_UPSTREAM_PORT` | `9221` | Chromium CDP 端口（仅绑 127.0.0.1） |
| `CDP_WINDOW_SIZE` | `1440,900` | 浏览器视口大小 |
| `CDP_START_URL` | `about:blank` | 启动时打开的页面 |
| `CDP_ARGS` | 空 | 追加的 chromium 启动参数 |
| `CDP_LOG_FILE` | `/tmp/cdp-browser.log` | chromium + gateway 日志 |

## 注意事项

- Chromium 以 `--headless=new --no-sandbox` 运行（root 容器），复用 Playwright 安装的
  Chromium（`$CHROME_PATH`），与 `docker/browser` 镜像不重复占体积。
- 直连 Chrome 的两个经典坑已由网关解决：经域名代理访问的 Host 校验 400、
  `/json/version` 返回 `ws://127.0.0.1` 导致外部客户端连不上。外部永远连网关 9222，
  不要绕过网关直连 9221。
- screencast 为 JPEG 帧流（默认 quality 65，上限 1920x1080），适合监控与演示；需要
  60fps 丝滑画面时用 `docs/products/cloud-browser` 的 noVNC 方案。
- 排查看 `/tmp/cdp-browser.log`（容器内文件，`docker logs` 不覆盖沙箱内进程）。
