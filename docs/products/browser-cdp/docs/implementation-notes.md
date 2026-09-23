# 实现过程与踩坑记录

> 记录 browser-cdp 从镜像改造到前端测试台端到端打通的完整过程：每一步的实际操作、
> 遇到的问题、定位手段与修复。架构背景见 [`architecture.md`](./architecture.md)，
> 复现验证步骤见 [`testing.md`](./testing.md)。
>
> 时间线：2026-08-28 单日完成。环境：macOS (OrbStack) + 组合 3（本地 PG + 本地 OpenSandbox）。

## 1. 沙箱镜像层（packages/opencode/docker/browser-cdp）

### 1.1 前置调研

动镜像前先摸清 OpenSandbox 机制（结论影响全部后续设计）：

- 沙箱容器 entrypoint 被 OpenSandbox server 注入的 bootstrap 接管，镜像自身
  `ENTRYPOINT` **不参与启动**，也没有 bootstrap.d 之类的自启目录约定
  → 常驻浏览器只能显式拉起（脚本 / 仓库侧 runInSession），不能塞 ENTRYPOINT；
- 仓库既有先例 `session-plugin-runtime.ts`：`runInSession(...setsid ... &) +
  getEndpoint(sessionID, port) 健康轮询` 拉起常驻服务 —— 后续 exec 拉起照此模式；
- endpoint API（direct ingress）返回 ingress 形态地址（`ip:mappedPort/proxy/<port>`）；
- `docker/Dockerfile` 的构建上下文是 `packages/opencode/`（`COPY docker/opt/...`）。

### 1.2 组件设计（结论先行，踩坑见 §2）

- **Chromium 只绑 127.0.0.1:9221**，对外统一经 `cdp-gateway`（0.0.0.0:9222）——
  解决 Chrome Host 校验 / webSocketDebuggerUrl 回显 / Origin 三个远程化坑
  （细节见 architecture.md §3.1）；
- 实时画面走 CDP `Page.startScreencast`（JPEG 帧 + ack 流控），不引 VNC 全家桶，
  极简镜像零新增依赖；
- gateway 顺带 serve `/viewer` 独立画面页（一个端口搞定 HTTP/WS/页面）。

### 1.3 镜像内端到端验证（8/8）

构建 `opencode-saas-browser-cdp:test`（上下文 `packages/opencode/`），起容器
（`--entrypoint sleep ... infinity`，注意镜像 `ENTRYPOINT ["/bin/bash"]` 会吞 CMD）
后由 `cdp-browser.sh` 管理进程，node 脚本断言：

| # | 用例 | 结果 |
|---|---|---|
| 1 | gateway 就绪（/json/version 200） | PASS |
| 2 | `webSocketDebuggerUrl` 重写为请求 Host | PASS |
| 3 | 伪造 proxy 域名 Host（Chrome 本应 400）经网关 200 | PASS |
| 4 | 伪造 Host + `x-forwarded-proto: https` → 重写为 `wss://` | PASS* |
| 5 | browser 级 WS upgrade + `Browser.getVersion` | PASS |
| 6 | page 级 WS + `Page.startScreencast` 收帧（9020B JPEG, 1440x757） | PASS |
| 7 | GET /viewer 返回页面 | PASS |
| 8 | start 幂等 / status / restart / stop | PASS |

\* 第 4 项首测 FAIL 是 node fetch (undici) 忽略自定义 Host 头的测试假象，
curl 复测通过（`wss://test-opencode.shadow-rpa.net/...`）。**教训：测 Host 相关
逻辑不要用 undici fetch 发自定义 Host。**

**踩坑 1**：`set -u` 下 `cdp-browser.sh` 引用未定义的 `$CDP_ARGS` 直接 unbound
variable 退出 → 修为 `${CDP_ARGS:-}`。容器里验证比本地 shell 检查多挡一层。

## 2. 结合 opencode SaaS（本地组合 3）

### 2.1 环境切换与核心链路

按 `docs/local-test-env.md` 组合 3 切换（原环境是组合 1）：

1. 重定向 15432 转发：远端 PG `172.18.32.14:5432` → 本地 `127.0.0.1:5432`；
2. 启动本地 OpenSandbox server：`uvx opensandbox-server`（`~/.sandbox.toml` 的
   `runtime.execd_image` 为新版必填，首次 uvx 拉依赖耗时数分钟）；
3. 重建 `opencode-saas-test` 容器（local PG + `host.docker.internal:8080` +
   `OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local`）。

**踩坑 2**：`POST /session` 的 `sandbox` 对象 `cpu`/`memory` 是必填字段，
只传 `image` 返回 `_tag: "BadRequest"`。正确请求：

```bash
-d '{"sandbox":{"cpu":"1","memory":"2Gi","image":"opencode-saas-browser-cdp:test"}}'
```

核心链路（建会话 → keep-alive boot → exec 拉浏览器 → `GET /session/:sid/proxy/9222/json/version`
返回 Chrome/151）验证通过后进入前端开发。

**踩坑 3（重要）**：宿主仓库修了 `cdp-browser.sh` 后，**已运行的沙箱容器里仍是旧
脚本**（镜像构建时 COPY 进去的），复现同样的 unbound variable 报错 →
重建镜像（COPY 层之后才有缓存失效，秒级）+ `POST /session/:sid/kill-sandbox`
销毁旧沙箱重新 boot。**改镜像内文件后必须重建镜像并重建沙箱，docker cp 只救急。**

### 2.2 ingress 不转发 WebSocket（本设计最关键的发现）

现象：SaaS sandbox-proxy 的 HTTP 代理一切正常（/json/list 200），但 **WS upgrade
握手后永久挂起**（无响应、无错误），前端画面黑屏。

逐层隔离定位：

```
node ws client → vite /cdp 代理 → ???（OPEN 但消息不回 / 握手挂起，分阶段两轮）
node ws client → SaaS proxy 直连     → 30s 挂起
node ws client → 沙箱 ingress 直连   → 30s 挂起（HTTP 却 200）
node ws client → 沙箱裸 IP:9222 直连 → OPEN + 消息往返 ✓
```

结论：**OpenSandbox ingress（direct 模式的 `/proxy/:port` 转发，容器 44772 端口）
不转发 WebSocket upgrade**。SaaS sandbox-proxy 的 WS 转发最终也走这层 ingress，
所以一起挂。文档 `sandbox-proxy-endpoint.md` 的 WS 用例（T11.31）验证的是
dev server HMR 的 patch 场景，未覆盖此限制。

**修复（三层）**：
1. SaaS server 新增 `GET /session/:sid/host-ip`（沙箱内 `hostname -I` 上报裸 IP）；
2. 测试台插件 upstream 解析优先用 host-ip 直连 `http://<裸IP>:9222`（HTTP+WS 通吃）；
3. endpoint directUrl 降级为仅 HTTP 场景使用。

**踩坑 3.1**：`host-ip` 初版 `runInSession` 失败且错误被 `Effect.catch` 吞掉。
加 `Effect.tapError` 打日志后看到根因：**workingDirectory 默认是宿主机项目路径
（`/Users/ruomu/code/opencode`），沙箱内不存在**——`exec` handler 有 `toSandboxCwd`
转换而新接口没有。指定 `workingDirectory: "/tmp"` 修复。教训：**runInSession 必须
显式给沙箱内存在的 workingDirectory**。

## 3. 前端测试台

### 3.1 项目骨架

vite 8 + react 19 + tailwind v4（`@tailwindcss/vite`，无 postcss/tailwind.config），
tsconfig 三件套与依赖版本对齐 `docs/products/cloud-browser`。`server/plugin.ts`
为 vite 插件（`apply: "serve"`），中间件挂 `/api/*` 与 `/cdp/:sid/*`。

### 3.2 调试纪实（按定位顺序）

以下每条都是「现象 → 定位 → 根因 → 修复」，方法比结论更值得沉淀。

**（a）浏览器 WS 全挂，node WS 全通 —— 浏览器代理**

- 现象：`agent-browser` 驱动的 Chrome 里 `ws://localhost:5174/...` 永远 CONNECTING，
  同 URL 的 node ws client 却秒 OPEN；HTTP fetch 一切正常。
- 定位：查 Chrome 主进程启动参数发现 `--proxy-server=http://127.0.0.1:7897`
  且无 bypass-list（系统代理被自动带入）。
- 修复：`agent-browser close --all` 后带
  `agent-browser --proxy-bypass "localhost,127.0.0.1" open ...` 重启。
  注意 `agent-browser kill` **不是合法命令**，旧实例会一直复用。

**（b）vite 只监听 IPv6 ::1 —— 127.0.0.1 ECONNREFUSED**

- 现象：bypass 后 `ws://127.0.0.1:5174` 快速失败 1006；node 直测
  `127.0.0.1 → ECONNREFUSED`、`[::1] → OPEN` —— vite dev 默认只绑 ::1。
- 修复：`vite.config.ts` `server.host: true`（双栈监听）。浏览器对 `localhost`
  的解析顺序不确定，双栈是一劳永逸的做法。

**（c）WS 代理握手竞态 —— 消息静默丢失**

- 现象：代理后 ws OPEN 但任何 CDP 消息无响应（端到端 screencast 无帧）。
- 定位：在代理转发两端加字节日志，抓到
  `client->upstream 66B (upstream state 0)` —— client 在 upstream 仍 CONNECTING
  时发消息，代码里 `if (upstream.readyState === OPEN) send` 直接丢弃。
- 根因：`wss.handleUpgrade` 回调里才 `new WebSocket(upstreamUrl)`，而 client
  侧收到 101 即触发 onopen 发消息，竞态窗口必然存在。
- 修复：pending 缓冲（`upstreamReady` 标记 + 数组缓冲，OPEN 后 flush）——
  与 cloud-browser 的 `forwardCdpConnection` 同款方案（先例本就解决了这个问题，
  初版图省事简化掉了，教训：**转发类组件的消息缓冲不是可选优化**）。

**（d）hook 的 WS URL 少冒号 —— 错误被 async 吞掉**

- 现象：代理层全部打通后，页面 UI 仍无帧；手动 eval 同 URL 的 WS 一切正常，
  hook 的 ws 连 open/close/error 日志都没有。
- 定位：逐段加日志，`connecting ws//localhost:5174/...` —— **URL 是 `ws//`**！
  `const proto = "ws"` + `${proto}//${host}` 少了 `:`。`new WebSocket("ws//...")`
  抛 SyntaxError，发生在 async 函数里无 catch，成为 unhandled rejection，
  表现为「静默无事发生」。
- 修复：`proto` 直接含 scheme（`"wss://" : "ws://"`）。
- 教训：**async 事件链里 new WebSocket 之类的构造抛错不会有任何可见症状**，
  怀疑「代码没执行」时先验证构造参数。

**（e）会话列表截断导致目标不可见**

- 14097 视角 `/session` 返回 68 条，插件 `slice(0, 50)` 且服务端排序非按时间，
  新建的测试会话不在前 50。修复：按 `time.updated` 降序再截断。
- 顺带发现：**会话列表按 project 隔离**——14096 容器建的会话在 14097 宿主机
  server 的列表里不存在（默认 directory 不同），测试必须在同一 server 上闭环。

**（f）测试操作类小坑**

- 页面有两个 `<header>`（App 顶栏 + Viewer 工具栏），`querySelectorAll('input')[0]`
  拿到的是镜像输入框，导航 URL 填错框；
- React 受控 `<select>` 用 `new Event('change')` 触发不可靠（native setter 可行
  但 agent-browser eval 跨 realm 报 Illegal invocation），用 playwright 语义的
  `agent-browser select <ref> <value>` 最稳；
- undici fetch 忽略自定义 Host 头（见 §1.3 注）。

### 3.3 最终验证（UI 级）

`agent-browser`（bypass 代理实例）驱动测试台页面：

1. 选择会话 → 状态点变绿（live），画面渲染 `about:blank`（FRAME 918x483）；
2. 地址栏输入 `example.com` → 打开 → 沙箱内 `json/list` 确认 url 变为
   `https://example.com/`，画面实时渲染 Example Domain；
3. 画面上点击链接（dispatchMouseEvent 经 hook 转发）→ 沙箱浏览器导航到新页面，
   画面与 target 标题（`frameNavigated`）同步更新。

本地网络把 example.com 的部分链接解析劫持到了其它站点（clash 规则），不影响
「点击 → CDP 输入 → 沙箱响应 → 画面更新」链路的验证结论。

## 4. 交付物清单

| 层 | 文件 | 说明 |
|---|---|---|
| 镜像 | `packages/opencode/docker/browser-cdp/Dockerfile` | browser 镜像 + CDP 段（§10） |
| 镜像 | `.../cdp-gateway.mjs` / `viewer.html` / `cdp-browser.sh` / `README.md` | 网关 / 画面页 / 管理脚本 / 用法 |
| SaaS | `packages/opencode/src/server/sandbox-proxy.ts` | 新增 `GET /session/:sid/host-ip` |
| 前端 | `docs/products/browser-cdp/`（server/ + src/ + 配置） | 测试台全量 |
| 前端 | `docs/products/browser-cdp/docs/`（本文档三篇） | 架构 / 过程 / 测试 |

## 5. 遗留与建议

- `opencode-saas-sandbox-test` 容器镜像为旧代码（无 host-ip），长期方案需重建镜像
  并双推送（origin + gitlab）；
- upstream 合并时注意 `sandbox-proxy.ts` 新增路由与 `docs/upstream-merge-guide.md`
  的冲突点；
- gateway 暂未加 CORS 头：第三方前端直连（非同源）需先补
  `Access-Control-Allow-Origin` + OPTIONS 预检处理；
- screencast 为 JPEG 帧流（quality 65），高帧率需求场景切 noVNC 方案
  （`docs/products/cloud-browser`）。
