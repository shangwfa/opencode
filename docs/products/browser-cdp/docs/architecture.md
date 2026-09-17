# 架构设计

> browser-cdp 能力的三层构成：沙箱镜像（常驻 CDP 浏览器）、SaaS server（直连地址接口）、
> 前端测试台（画面 + 控制）。本文说明组件职责、数据链路与关键设计决策。
> 实现过程中的调试细节见 [`implementation-notes.md`](./implementation-notes.md)，
> 验证步骤见 [`testing.md`](./testing.md)。

## 1. 背景与需求

在 OpenSandbox 沙箱镜像（`packages/opencode/docker/browser`）基础上实现：

1. **透出 CDP 端口**——外部（Playwright / Puppeteer / agent-browser / 前端页面）可控制沙箱中的浏览器；
2. **实时画面**——浏览器操作画面可在前端页面实时显示（基于 CDP `Page.startScreencast`，无需 VNC）。

衍生约束：能力随 opencode SaaS 会话使用（会话级指定沙箱镜像）、本地与远端环境均可运行、
前端全程同源访问（规避 CORS 与 Chrome 的 Host/Origin 校验）。

## 2. 总体链路

```
┌────────────────────────── 本机 / 前端用户 ──────────────────────────┐
│  browser-cdp 测试台 (vite dev, :5174)                                │
│   ├─ /api/*                server/plugin.ts → opencode SaaS server   │
│   │    POST /session       {sandbox:{cpu,memory,image}} 会话级指定镜像 │
│   │    POST .../keep-alive {boot:true}    立即创建沙箱                │
│   │    POST .../exec                 拉起 /opt/cdp-browser/cdp-browser.sh │
│   │    GET  .../host-ip             沙箱裸 IP（新增接口，见 §4）        │
│   └─ /cdp/:sid/*           HTTP + WebSocket 代理（upstream 解析 §4.2）│
└──────────────────────────────┬───────────────────────────────────────┘
                               │ 直连 http(s)://<沙箱IP>:9222
┌──────────────────────────────▼─── 沙箱容器 ──────────────────────────┐
│  cdp-gateway (node, 0.0.0.0:9222)                                    │
│   ├─ 改写 Host 头 → 绕过 Chrome 对非 IP/localhost Host 的 400 校验     │
│   ├─ 改写 /json* 的 webSocketDebuggerUrl（127.0.0.1 → 外部地址）       │
│   ├─ WebSocket upgrade 双向透传                                       │
│   └─ GET /viewer 内嵌画面页                                           │
│                               │ ws 127.0.0.1:9221                    │
│  Chromium headless (--headless=new, --remote-allow-origins=*)        │
└──────────────────────────────────────────────────────────────────────┘
```

## 3. 沙箱镜像层（`packages/opencode/docker/browser-cdp/`）

`docker/browser` 镜像的变体：内容完全一致（ubuntu:24.04 + Node 24 + pnpm + Playwright
Chromium + codegraph + LSP daemon + 插件/PTY agent），追加 `/opt/cdp-browser/`：

| 文件 | 职责 |
|---|---|
| `cdp-gateway.mjs` | 纯 Node（零依赖）HTTP/WS 反向代理 + URL 重写 + serve viewer |
| `viewer.html` | 独立画面页：screencast 播放 + 鼠标/滚轮/键盘回传（不经 SaaS 也可用） |
| `cdp-browser.sh` | `start/stop/status/restart`，幂等，`setsid` 脱离 exec 会话存活，就绪轮询 |

### 3.1 为什么不能直接透出 Chrome 的调试端口

Chromium 以 `--remote-debugging-port=9221` 绑定 `127.0.0.1`（有意不绑 0.0.0.0），
外部访问必须经过网关，直接透出会踩三个坑：

1. **Host 校验**：DevTools HTTP server 只接受 IP / localhost 形态的 Host 头，
   经 sandbox-proxy 域名访问直接 400 —— 网关按请求改写 Host 后转发；
2. **webSocketDebuggerUrl 回显**：`/json/version`、`/json/list` 返回
   `ws://127.0.0.1:9221/...`，Playwright/Puppeteer 拿到后连不上 ——
   网关按请求 Host（及 `x-forwarded-proto`）重写为外部可达地址；
3. **Origin 校验**：非空 Origin 的 WS 连接默认被拒 —— 启动参数
   `--remote-allow-origins=*` 放行。

### 3.2 实时画面方案选型

选用 **CDP `Page.startScreencast`**（JPEG 帧流 + `Page.screencastFrameAck` 流控）：

- 复用既有 CDP 通道，沙箱内无需 X server / VNC / websockify，镜像零新增依赖；
- 与 noVNC 方案（`docs/products/cloud-browser`）的取舍：screencast 为按需 JPEG 帧
  （实测 quality 65 / 1920x1080，每帧 ~9KB），适合监控与演示；需要 60fps 丝滑
  操作体验时用 noVNC。
- 帧流需要 ack 流控（不 ack 则 Chrome 停发），并周期性重发 `startScreencast`
  兜底导航等场景的停发。

## 4. SaaS server 层（`packages/opencode/src/server/sandbox-proxy.ts`）

### 4.1 会话级镜像指定（既有能力）

`POST /session` 的 `sandbox.image` 字段（`session.ts` SandboxResource）：

```bash
curl -X POST $BASE/session -d '{"sandbox":{"cpu":"1","memory":"2Gi","image":"opencode-saas-browser-cdp:test"}}'
```

注意 `cpu` / `memory` 为必填（缺省 BadRequest）。启动优先级：
`sandbox.snapshotId` → 会话自动快照 → `sandbox.image` → 部署默认镜像。

### 4.2 新增接口 `GET /session/:sid/host-ip`

**动机**：OpenSandbox 的 endpoint API（direct ingress）返回的是 **ingress 形态地址**
（如 `172.16.21.16:43502/proxy/9222`），其 `/proxy/:port` 转发**不支持 WebSocket
upgrade**（HTTP 正常、WS 挂起，实测定位，见 implementation-notes §2.1）。
SaaS sandbox-proxy 的 WS 转发同样经该 ingress，因此 WS 挂起。
需要 WS 直连沙箱内服务的场景（CDP 画面/控制是典型）必须拿**裸容器 IP**。

实现：`sandbox.runInSession` 在沙箱内执行 `hostname -I`（`workingDirectory: "/tmp"`
—— 默认 workingDirectory 是宿主机项目路径，沙箱内不存在会失败），返回：

```json
{ "ip": "192.168.215.4", "ips": ["192.168.215.4"], "sandboxId": "..." }
```

K8s 环境返回 pod IP，语义一致。不写 exec_log（轻量探测）。

### 4.3 CDP upstream 解析（测试台插件内）

```
env BROWSER_CDP_DIRECT_BASE            显式指定（最高）
 → GET /session/:sid/host-ip           http://<裸IP>:9222   （HTTP + WS 均可用）
 → GET /session/:sid/endpoint/9222     directUrl 原样       （仅 HTTP 可用）
 → SaaS sandbox-proxy 路径             兜底                 （仅 HTTP 可用）
```

候选逐个 `probeBase`（GET /json/version，1.5s 超时），命中缓存 30s；
全部失败降级 SaaS proxy 路径（HTTP 可用，WS 受限时画面不工作但接口不崩）。

## 5. 前端测试台层（`docs/products/browser-cdp/`）

| 模块 | 职责 |
|---|---|
| `server/plugin.ts` | vite 插件：`/api/*`（SaaS 编排）+ `/cdp/:sid/*`（HTTP/WS 代理） |
| `server/config.ts` | env 装载：`OPENCODE_SAAS_BASE_URL` / `BROWSER_CDP_IMAGE` / CPU/内存 |
| `src/useCdpViewer.ts` | CDP 连接生命周期 hook：target 列表、screencast 收帧+ack、输入命令、重连 |
| `src/components/Viewer.tsx` | 输入事件 → CDP 坐标/键值转换（含双击计数、修饰键掩码） |
| `src/components/Screen.tsx` | 帧渲染（等比缩放无黑边，事件坐标映射无需处理 letterbox） |
| `src/components/Toolbar.tsx` | target 下拉、刷新、新建/关闭标签、地址栏、fps |

设计要点：

- **同源代理**：页面只访问 `/cdp/:sid/...`，由 vite 插件转发。规避浏览器 CORS
  （gateway 未带 CORS 头）与 Chrome Origin 校验，也不受用户浏览器代理配置影响。
- **WS 代理的握手竞态**：client 在 upstream OPEN 前发送的消息必须缓冲
  （`pending` 数组，OPEN 后 flush），否则静默丢失（见 implementation-notes §2.4）。
- **输入映射**：鼠标坐标按 `帧尺寸 / 显示尺寸` 比例映射回沙箱 viewport；
  键盘按 CDP 规则分发——可打印字符 `keyDown + text`、Enter 补 `\r`、
  其余 `rawKeyDown`；modifiers 掩码 Alt=1 / Ctrl=2 / Meta=4 / Shift=8。

## 6. 环境拓扑（本地组合 3）

```
宿主机 macOS
 ├─ 本地 PG (Homebrew :5432, 用户 local 无密码)
 │    └─ TCP 转发 0.0.0.0:15432 → 127.0.0.1:5432
 ├─ 本地 OpenSandbox server (:8080, uvx opensandbox-server, Docker runtime)
 ├─ opencode SaaS server
 │    ├─ 容器形态 (:14096, opencode-saas-sandbox-test 镜像) —— 不含 host-ip 新接口
 │    └─ 宿主机直跑形态 (:14097, bun run src/index.ts serve) —— 开发迭代用 ★
 └─ browser-cdp 测试台 (:5174, OPENCODE_SAAS_BASE_URL=http://localhost:14097)
```

★ 宿主机直跑绕过镜像重建，改 server 代码即时生效（`docs/local-test-env.md` 备选方案）。
容器形态长期使用需重建 `opencode-saas-sandbox-test` 镜像。

## 7. 与其它方案的关系

| 方案 | 场景 | 与 browser-cdp 关系 |
|---|---|---|
| `docker/browser` 镜像 | 沙箱内 agent 用 agent-browser 自用浏览器 | browser-cdp 复用其全部内容，追加常驻 CDP |
| `docs/products/cloud-browser` | noVNC 60fps 云浏览器产品 | 画面方案互补；其 vite 插件 WS 缓冲模式被本测试台借鉴 |
| sandbox-proxy / endpoint API | dev server 代理与直连 | 本设计复用其 API，但不经其转发 WS（ingress 限制），另加 host-ip 直连接口 |
