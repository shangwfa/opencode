# Browser Use 迁移与验收（2026-10-28）

## 范围与入口

- 源：`/Users/ruomu/yd/xybot-front-opencode-ui` 的 `dev` 分支。
- 目标：`packages/hn-app`，不修改官方 `packages/app` 前端。
- 入口：`/#/cdp`，另有 `/cdp/sessions`、`/cdp/scripts`、`/cdp/scripts/:scriptId`、`/cdp/session/:sessionId`。
- UI 复用当前全局图标导航、shadcn 组件、聊天时间线、Composer、文件预览；桌面双栏，窄屏切换聊天/浏览器。
- 包含普通任务、UI 走查、已发布脚本执行、实时画面、标签页、地址导航/历史、刷新、接管、中文组合输入、滚轮、文件浏览、表单回答、脚本发布/diff/版本/可见性/删除。

## 架构适配

原来的 Harness/MySQL 接口不搬入本项目。新接口统一为 `hn-base-server` 的 `/api/browser/*`：

| 接口                                                | 用途                                    |
| --------------------------------------------------- | --------------------------------------- |
| `/sessions`、`/sessions/:id`                        | 创建、个人历史、删除会话并回收沙箱      |
| `/sessions/:id/start`、`/stop`                      | 幂等启动、停止 Chromium                 |
| `/sessions/:id/targets`                             | 标签页发现、创建；`/:target` 删除       |
| `/sessions/:id/targets/:target/frames`              | 携带 Bearer 的实时 JPEG SSE             |
| `/sessions/:id/targets/:target/command`             | 有 run 权限的 CDP 输入/导航；命令白名单 |
| `/sessions/:id/files`、`/files/:name`               | 沙箱脚本发现/限长读取                   |
| `/sessions/:id/forms`、`/forms/:form/reply`         | 待确认问题与人工回答                    |
| `/scripts`、`/scripts/:id`、`/scripts/:id/versions` | PG 脚本元数据、版本与乐观锁             |

浏览器 → 基础服务鉴权 → SaaS 会话命令/端口代理 → OpenSandbox 控制面 → Chromium。
基础服务不访问沙箱容器 IP。画面订阅持有请求内连接；输入请求独立连接同一 CDP target，不要求 pod 亲和。
SaaS Basic 凭据不下发浏览器，不放到 URL。客户端断连回收 CDP 连接；写出帧后 ack，限制慢客户端积压。

数据表位于基础服务的 PG schema：`browser_session`、`browser_script`、`browser_script_version`。
`schema.ts` 与 `ensure-schema.ts` 同步，启动时幂等建表。会话继续使用已有 ReBAC owner/viewer/run 权限。
私有脚本仅创建人可见，公开脚本所有登录用户可读/选择执行，仅创建人可修改。

启动复用现有镜像 `/opt/cdp-browser/cdp-browser.sh`，先命令探活再访问代理。
浏览器会话注入会话级 AGENTS.md 和 agent-browser skill，明确禁止误用桌面 browser.\* 工具。
脚本执行将指定版本写入同会话 `/workspace/output/published-script.js`，不引入外部脚本注册中心。

## 多沙箱后端兼容

浏览器访问层不区分后端：`hn-base-server → SaaS 会话代理 → provider.endpoint`。
opensandbox 走控制面网关，E2B/阿里云/Vercel 走云端端口域名（HTTPS + 访问令牌），
WS 也由同一代理转发，因此输入、画面、标签页代码不需要按后端分支。

差异只在沙箱内运行时。启动前先探测（`lib/browser-cdp.ts`）：

| 探测结果                                 | 处理                                                   |
| ---------------------------------------- | ------------------------------------------------------ |
| `/opt/cdp-browser/cdp-browser.sh` 可执行 | 直接 `script start`（仓库 opensandbox 镜像、E2B 模板） |
| 仅有 Chromium + `cdp-gateway.mjs` + node | 用网关参数直接拉起 Chromium（自建模板）                |
| 其他                                     | 返回明确错误，说明缺什么以及两种补齐方式               |

Chromium 的 Host 校验会拒绝云端沙箱的 `9222-xxx.e2b.app` 域名，所以网关是云端后端的硬要求。
`OPENCODE_BROWSER_START_COMMAND` 可整体覆盖启动命令，供自备运行时的后端（可先安装再启动）。

| 后端                         | 浏览器运行时                                       | 实测                          |
| ---------------------------- | -------------------------------------------------- | ----------------------------- |
| opensandbox（本地/远端镜像） | 仓库 `packages/containers/sandbox/Dockerfile` 内置 | ✅ 2026-10-28，8/8            |
| e2b                          | `packages/containers/sandbox/e2b` 模板             | ✅ 2026-10-28，8/8            |
| vercel                       | `packages/containers/sandbox/vercel` 自定义镜像    | ✅ 2026-10-29，8/8            |
| aliyun                       | `packages/containers/sandbox/aliyun` 模板          | ⚠️ 链路 6/6，模板构建待控制台 |

### 自定义镜像（按各后端官方文档）

- **Vercel**：官方方案是从 Managed Image 派生 Dockerfile → 推 Vercel Container Registry（VCR）→ 沙箱按 `image` 启动。
  基础镜像必须写完整 VCR 地址 `vcr.vercel.com/vercel/sandbox/universal:latest`；默认 Ubuntu 26.04 无 apt chromium，镜像内改用 Playwright Chromium 并固定 `PLAYWRIGHT_BROWSERS_PATH`。
  实测镜像 `opencode-sandbox:20261029b`（amd64、1.3GB、VCR Ready）：8/8 通过，包括实时 JPEG 16119B、中文输入接管、脚本版本/PG、真实模型用 `agent-browser --cdp` 取标题、`execute` 返回 42、关闭标签页与回收。
  首版 `20261029` 漏装 `agent-browser`，模型退回 curl+CDP；`20261029b` 已修正并复测。
- **阿里云**：官方模板接口 `POST /templates`（E2B 兼容，需 `dockerfile` 字段）可接受请求并返回 202，但本轮所有构建都立即 `error` 且无日志端点：
  最小 `FROM e2bdev/base` + `RUN echo ok`、`FROM ubuntu:24.04`、`FROM` 本账号 ACR 镜像三种结果一致；账号里仍是 2026-10-25 的 `base-5wa5`/`code-interpreter-v1`。
  所以阿里云侧没能在本轮交付浏览器镜像，判为平台构建服务问题（需控制台或工单确认基础镜像来源/网络/配额），不是代码分支问题。
  代码侧已就绪：`OPENCODE_ALIYUN_TEMPLATE` 指向含 `/opt/cdp-browser` 的模板即可，契约与 E2B 模板一致。探针模板已删除，账号只剩原有两个模板。
- **自举兜底**（不建议生产）：`OPENCODE_BROWSER_AUTO_INSTALL=1` 会在沙箱内用 Playwright 安装并下发内置网关。
  实测阿里云 `trixie-security` 对 chromium 返回 404（发行版包不可用），因此自举也只能走 Playwright；该路径仅在没有自定义镜像时使用。

### 阿里云实测（2026-10-29）

两轮结果：

1. **链路一次成功**（`base-5wa5` + `OPENCODE_BROWSER_AUTO_INSTALL=1`）：创建会话、沙箱内测试页、实时 JPEG 16132B、中文输入接管、脚本版本/PG 归属、删除与回收 6/6 通过；模型轮次因自举漏装 `agent-browser` 绕路超时。
2. **运行时自举不可用于云端**：补装 `agent-browser` 后安装 8 分钟仍未完成（Playwright 下载 + apt 依赖），创建接口虽已异步化（`preparing` 状态 + 轮询），最终仍判失败。

官方模板构建接口经专项排查确认不可用（2026-10-29）：

- `POST /templates` 对正确 Dockerfile、带 `startCmd/readyCmd`、最小 `FROM e2bdev/base`、`FROM ubuntu:24.04`、本账号 ACR 基础镜像，以及**故意非法**的 Dockerfile，全部返回 202 后在 0.5 秒内转为 `error`；
- 构建日志端点 `GET /templates/{alias}/builds/{id}/logs` 存在但恒为 `{"logs":[]}`，说明构建从未真正启动；
- 请求体校验本身正常（`dockerfile` 传数组返回 400 并指出 Go 结构字段是 string；缺 `dockerfile` 返回 400）；
- `PATCH /templates/{alias}` 接受 `dockerfile` 返回 200，但不触发重建（`buildCount` 不变、状态仍 error）；
- 结论：构建调度/worker 或账号构建权限问题，不是参数问题，代码侧无法绕过。
  故阿里云要用浏览器只有两条路：控制台构建含 `/opt/cdp-browser` 的模板（Dockerfile 见 `packages/containers/sandbox/aliyun`），
  或让平台修复模板构建 API。模板可用后设置 `OPENCODE_ALIYUN_TEMPLATE=<别名>`，代码无需改动。

工单需要提供：账号 1740105482809769、时间 2026-10-29T14:07Z、buildID `9a88e1e7-767d-404e-8d0a-6969a3d60944`、
x-request-id `aa95082a-8caa-4209-9dbc-6eb8cc417727`、现象“202 后 0.5s 转 error，构建日志为空”。

清理：测试库 13 条 sandbox 全部 `destroyed`，会话已删除，探针模板已删除。

### 阿里云自定义模板 + 保活修复实测（2026-10-30，8/8 通过）

模板：`opencode-browser-v2`（ID `qmgb1r79ri8xz0on5bni`，别名 `opencode-browser-v2`，4 vCPU / 8 GB，构建约 2 分钟 `ready`）。

镜像是按本仓库 `packages/containers/sandbox/aliyun/Dockerfile` 构建并推送的：

- 基础镜像 `fc-e2b-registry.cn-hangzhou.cr.aliyuncs.com/runtime-v2/base:v0.0.53`（Debian 13，自带 `/.fce2b/envd` 与入口 `/.fce2b/entrypoint`，保留不覆盖）
- 叠加 Chromium 156、`rg`、`agent-browser 0.39.4`、`/opt/cdp-browser` 网关；`bun` 由 provider 准备阶段 `npm install -g bun` 补装（实测 4s）
- 推送地址 `crpi-hlpnu8kiweghie0r.cn-hangzhou.personal.cr.aliyuncs.com/shangwfa/opencode-sandbox:runtime-v2-browser-v1`
- 平台 `runtime-v2/all-in-one`（`template-h8em`）不可直接使用：它自带平台 Chrome 监听 9222，经沙箱域名访问被 Host 校验拒绝（`500 Host header is specified and is not an IP address or localhost.`），且镜像内无我们的网关

E2E（`EXPECT_SANDBOX_PROVIDER=aliyun PAGE_MODE=sandbox MODEL=Yd-DeepSeek/deepseek-v4-flash`）8/8：创建、沙箱内测试页、实时 JPEG、中文输入点击、脚本版本与 PG、真实模型工具执行与 SSE、关闭标签页、PG 删除与回收。
证据：`packages/hn-base-server/artifacts/browser-use-aliyun-fix2-20261030/`。

#### 期间发现并修复的缺陷：浏览器会话未保活沙箱

现象：模型轮次成功后，下一步关闭标签页返回 `502 浏览器执行服务返回 502`，两次复跑同点复现。

定位（有监控数据支撑）：

- 采样 PG 绑定 + 阿里云沙箱状态 + SaaS 代理，每 4s 一条：沙箱在每次 `session.execution.succeeded` 之后 5–10 秒被替换成**新的**沙箱（`sbx-4d02c232…` → `sbx-edd4869b…` → `sbx-7457311b…`）。
- 新沙箱内没有 Chromium（`/tmp/cdp-browser.log` 不存在、9221/9222 无监听），因此 9222 代理不可达，`provider.endpoint()` 返回非 resolved，SaaS 返回 `{"error":"sandbox unreachable"}`。
- 代码依据：`packages/core/src/session/execution.ts` 的 `destroyUnkeptSandbox` 在 root 轮次终态销毁未保活沙箱（`if (sandbox.enabled && !(yield* sandbox.isKeepAlive(sessionID))) yield* sandbox.destroy(sessionID)`）。
- 之前单独复现「新建/关闭标签页」始终 200，是因为没有模型轮次，沙箱不会被回收。

修复：`hn-base-server` 在 `startBrowser` 首步调用 `POST /api/experimental/session/:id/keep-alive {enabled:true}`（`src/lib/saas.ts` 新增 `saasKeepAlive`），创建与手动启动两条路径都覆盖；单测新增断言，后端 19/19 通过。

#### 已知的模型侧波动（非产品缺陷）

一次复跑中模型先调用 `tools.browser.tabs.list()`（返回 `browser.disconnected`），随后按指令改用 `agent-browser --cdp` 并拿到正确标题；E2E 的「不得误用桌面浏览器通道」断言因此判失败。重跑通过。会话指令已明确禁用 `tools.browser.*`，属模型行为波动。

#### 前端缺陷：首条消息不发送 / 已发消息被合并覆盖（2026-10-30，已修复）

联调 UI 时用户反馈「发出消息后显示思考中，消息过一会才出现」。定位到两个独立缺陷，均有实测证据：

1. **首页首条任务消息从未发出**（dev + StrictMode）。
   `pages/cdp/session.tsx` 的 `FirstPrompt` 用 `useRef` 做「只派发一次」标记，并在派发时立刻 `navigate(replace, state: null)`。
   StrictMode 的「运行→清理→再运行」把正在轮询的 effect 清理掉（`stopped = true`），第二次运行又被 ref 标记挡住，首条消息永远不发。
   实测（页面内拦截 `fetch`）：`POST /api/browser/sessions` 201、`GET /messages`/`/event` 正常，但**没有** `POST /api/sessions/:id/message`，库里只有准备阶段的 shell 消息。
   修复：改为模块级 `firstTasks`/`sentFirstTasks`，清理后重挂仍能取回任务，发送前先占位保证只发一次，失败回滚占位并还原草稿。复测只有一次 `POST /message`（200），消息落库。

2. **已显示的用户消息被服务端合并覆盖**（浏览器会话特有）。
   浏览器会话准备阶段会先写入 shell 消息，因此 `loadMessages` 拿到的服务端列表非空；`context/data.tsx` 只对「空结果」保留本地乐观消息，非空时直接用服务端列表替换，尚未落库的乐观用户消息被冲掉，直到落库后才重新出现。
   修复：`optimisticPending` 记录待落库消息 id，合并时保留；服务端回显同 id 后清理。
   单测 `src/context/data-optimistic.test.tsx` 覆盖该场景（去掉修复逻辑即失败）。真实 UI 复测：连续 12 次采样消息始终可见；前端全量 544 通过（1 条既有失败 `route-repo.test.ts`）。

#### 前端缺陷：失败轮次没有任何反馈（2026-10-30，已修复）

现象（用户反馈）：发出消息后一直等，界面没有「思考中」、也没有任何中间态，不知道发生了什么。

复盘（有 PG 与会话日志证据，会话 `ses_e72f43cc…`）：

- `21:45:11` 用户发消息，`0.7s` 后就写入 `idle outcome=failed`，**没有任何 assistant 消息**——所以 `working` 立刻变 false，`SessionTimeline` 的「思考中」行随之消失。
- 该轮失败原因记录为 `session.execution.failed`：`Failed query: select "value" from "kv" where "kv"."key" = ? params: websearch:provider`。
  根因是 `kv.value` 用 drizzle `text({ mode: "json" })` 存 JSON，我在排障时手工写入未加引号的 `exa`（应为 `"exa"`），读取时 JSON 解析抛错。**这是排障副作用，不是产品缺陷**，已改回合法值并复验。
- 真正的产品缺口：`session_error` 只在 `pages/app-detail.tsx` 渲染，`free-chat`/浏览器会话（共用 `FreeChatCore`）完全没有展示。失败轮次没有 assistant 消息承载错误，界面就成了「一片空白」。

修复：`SessionTimeline` 新增 `executionError`，`!working` 时渲染「执行失败 + 原因」；`optimisticAdd` 清空上一轮错误，避免横幅残留。单测 `src/components/session/session-timeline-error.test.tsx`（2 项，且已验证执行中不显示旧错误）。

另外确认「发出即有思考中」本来就有：真实 UI 采样（free-chat 与 `/cdp/session/:id` 各一次）在 1.2s 内即出现「思考中」+ 三点动画。用户看到的空白是上面那个瞬时失败造成的。

顺带修复的配置问题：本环境未选默认 websearch provider，导致每次 `websearch` 先弹「选择 provider」表单（1 分钟超时后报 `Web search cancelled`，模型改为 `webfetch` 绕行）。
已把 `kv['websearch:provider']` 设为 `"exa"`（JSON 字符串）后，`POST /api/websearch` 默认走 exa，实测 200 / 4.6s，会话内 `websearch` 工具 `completed`。
**未解决**：会话级表单（`/api/session/:id/form`）目前只有浏览器会话在基础服务里有代理与 UI，聊天会话没有表单入口，用户无法自己选 provider；需要补齐通用表单能力。

### 阿里云 all-in-one 模板实测（2026-10-30，未通过）

模板：`qr7ss60nhi0exznnf4b4`（别名 `template-h8em`，镜像 `fc-e2b-registry.cn-hangzhou.cr.aliyuncs.com/runtime-v2/all-in-one`，4 vCPU / 8 GB）。
构建约 20 秒即 `ready`。SaaS 镜像 `opencode-saas:aliyun-qr-e69c3c8195`（当前提交重新构建），`OPENCODE_ALIYUN_TEMPLATE=template-h8em`。

- 沙箱创建、SaaS 会话 shell、`agents-md`、`skills` 均正常（直接调用 API 与 SaaS 复现）。
- 镜像内没有 `/opt/cdp-browser`、没有 `chromium` 可执行文件，`bun` 缺失（provider 准备阶段会 `npm install -g bun`，实测 4 秒成功）。
- 镜像自带 Chrome（`/opt/chrome/chrome`，`--remote-debugging-port=9222`，`127.0.0.1` 监听，外层 socat 转发），由平台 `start-browsertool` 启动。
- **阻断点**：沙箱域名 `9222-sbx-….cn-hangzhou.sandbox.aliyuncs.com/json/version` 直接访问返回 `500 Host header is specified and is not an IP address or localhost.`。SaaS 代理 `proxy/9222/*` 因此返回 500，基础服务按「浏览器执行服务返回 500」记录为准备失败。
- 基础服务 `startBrowser` 的运行时探测在此镜像下找不到启动脚本与 chromium 二进制（探测命令 `command -v` 不覆盖 `/opt/chrome/chrome`）。
- 本轮 E2E 存库的错误是「浏览器执行服务返回 500」。手动复现中，代理 500 与探测缺失均已确认；但 E2E 具体是哪一步返回 500，本轮未复现确认，需要在基础服务日志中补充上游状态与响应体后再定位。
- 本轮 E2E 未通过，未产生画面。需要决定：改为停止平台 Chrome 后由我们的网关接管 9222（需新增 `/opt/chrome/chrome` 运行时分支），或换不带该 Chrome 的模板。

### E2B 实测（2026-10-28）

模板：`opencode-browser-use`（Debian 12、Chromium 156.0.8078.47、agent-browser 0.39.4、2 vCPU / 2048 MiB），构建 1m19s。
SaaS 走 E2B provider，浏览器会话创建约 35s（含每次 boot 的运行时准备）。

通过项：创建会话与浏览器、沙箱内自托管测试页、控制面代理实时 JPEG（18006 B）、
真实页面中文输入与点击（标题变为「验收通过 中文接管验证」）、脚本发布/版本/PG 归属、
真实模型 `Yd-GLM/glm-5.3-flash` 经沙箱 CLI 取得同一标题、另起一轮 `execute` 返回 42、
关闭标签页、删除会话后 PG 软删与沙箱回收。

清理：E2B 账号残留沙箱 0；专用 schema 活跃浏览器会话 0（5 条历史记录均已软删）；
SaaS 测试库 5 条 sandbox 全为 `destroyed`。

云端沙箱需要自己的测试页：`host.docker.internal` 在 E2B 内不可解析（`net::ERR_NAME_NOT_RESOLVED` 是首次失败原因），
执行器用 `PAGE_MODE=sandbox` 在沙箱内起 127.0.0.1:8080 服务。

E2B 执行 API 偶发返回 502 `temporary error`：启动命令幂等，已加最多两次重试（`isTransientSandboxFailure`），
参数/权限错误不重试。

## 验收依据

### 异步准备改造后的回归（2026-10-29）

创建接口改为 `preparing` + 后台准备后，重新跑了真实链路：

| 后端        | 结果                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| opensandbox | ✅ 8/8（画面 16094B、中文输入、脚本版本、模型 + Code Mode、回收）                                                                                                      |
| e2b         | ✅ 8/8（异步准备约 81s；画面 18006B）                                                                                                                                  |
| vercel      | ⚠️ 4 次均未复现 8/8：创建、测试页、画面（16119B）通过；3 次卡在 CDP 写操作（开标签页/输入命令）5 分钟无响应，1 次沙箱探测不到镜像内的 Chromium。改造前同一镜像曾 8/8。 |
| aliyun      | ⚠️ 链路 6/6；浏览器运行时仍卡在模板（见上）                                                                                                                            |

Vercel 的 5 分钟挂起暴露了一个真实缺陷：CDP 写操作只有 WS 握手超时，没有整体上限，云代理接受连接但不响应时会挂住 HTTP 请求。已加 `CDP_COMMAND_TIMEOUT_MS = 15s`（含握手），现在会快速返回 504 而不是挂死。该修复在 Vercel 未得到“完整 8/8”验证，需结合云侧镜像/代理排查后复测。

### 自动测试

- 后端：`packages/hn-base-server/test/browser.test.ts`。真实 PG、HTTP 鉴权链，SaaS/CDP 使用测试服务。
  覆盖未登录/跨用户/只读共享隔离、工作目录、启动失败可恢复、指令恢复不覆盖用户内容、标签页 URL、画面 ack/取消、脚本限长/路径/来源互斥、公私有可见性、版本并发、软删除、
  多后端运行时探测（脚本/仅 Chromium/缺失）、启动命令覆盖与 shell 转义、瞬时 502 重试判定。
- 前端：`src/lib/browser.test.ts`、`src/features/browser-cdp/{browser-panel,use-cdp-viewer}.test.tsx` 和既有 `line-diff.test.ts`。
  覆盖 URL 安全、走查/流程提示组装、缩放坐标、SSE 跨 chunk/CRLF、多行事件、表单条件、StrictMode 启动去重、切换会话和取消订阅、接管等待暂停、粘贴、AI 新任务开始后退出接管。
- 前后端类型检查、前端生产构建通过。
- 最终全量结果：后端 101/101；前端 543/544；Browser Use 相关前端测试 22/22。
- 前端全量测试中的 `route-repo.test.ts > detects unsupported preview appId` 为 `MIGRATION.md` 原已记录的失败，不归为本次新增问题。

### Docker/OpenSandbox 真实 E2E

执行器：`packages/hn-base-server/test/e2e/browser-flow.mjs`。
真实 SaaS 与基础服务均运行在 Docker，连接本机 PostgreSQL；本地 OpenSandbox 控制面管理独立沙箱。
基础服务使用 `hn_browser_verify_20261028` schema，SaaS 使用独立数据库 `opencode-v2-browser-test`，未对共享开发数据运行恢复测试。

通过项：

1. 创建浏览器会话、再次启动保持幂等。
2. 经 SaaS/OpenSandbox 代理取得真实 JPEG。
3. 对真实页面中文输入、点击，页面标题变成「验收通过 中文接管验证」。
4. 发布/追加脚本，PG 主表版本 2、版本记录 `[1, 2]`、owner 与登录用户一致；一个会话只绑定一个 running/opensandbox 沙箱。
5. 真实 `Yd-GLM/glm-5.3-flash` 经沙箱 CLI 取得相同标题，文本结果与工具证据均匹配；没有 desktop disconnected 回退。
6. 额外模型轮次实际调用 `execute` 执行 `return 40 + 2`，工具和文本均返回 `42`，确认 Code Mode 真正执行。
7. 全程订阅 `/api/session/:id/event` 输出步骤、工具、思考摘要、文本和状态；执行器支持待确认表单自动回答。
8. 关闭标签页并删除测试会话，回收沙箱。

结果与原始事件保存在基础服务包的 `artifacts/browser-use-model-20261028/`（运行产物不入库）。

### 实际 UI 验证

在 `http://localhost:15302/#/cdp` 完成登录、脚本发布、详情、选择流程、首条消息自动发送、模型读/执行脚本、文件浏览与预览。
PG 中该 UI 会话只有一条 user 消息，未因 StrictMode 重复提交。
通过画面面板的真实 UI 事件输入中文组合文本并点击，标题变成「验收通过 UI中文接管验收」。
另外验证了 200039 字节脚本的物化与读取；验收结束后，专用 schema 中未删除的浏览器会话为 0，SaaS 测试库中 running/creating 沙箱为 0。
检查了 1440px 桌面和 390px 窄屏布局。截图保存在本机临时目录 `opencode/browser-use-20261028/`。

## 修复并重测的问题

- `flock` 文件描述符被 Chromium daemon 继承，第二次启动超时：改成 `flock --close`。
- Chromium `/json/new` 不解码整个 URL 查询串：先建空白标签，再用 `Page.navigate` 保留查询参数/片段。
- 模型误选桌面浏览器通道：会话指令明确限定沙箱 CDP，E2E 增加过程断言。
- V2 `/prompt` 返回接收结果，不代表执行完成：E2E 等待会话终态事件再断言/清理。
- StrictMode 不重复执行浏览器启动请求；接管使用真实 textarea 接收 IME，队列保持输入顺序。

## 部署与未覆盖项

- 前端需要 `VITE_HN_BASE_URL` 并登录基础服务；不提供绕过鉴权的直连开发降级。
- 基础服务需配置现有 PG、SaaS 地址/服务级凭据；沙箱镜像需包含 Chromium、agent-browser、flock 和现有 CDP 网关脚本。
- 未做远端云沙箱、K8s 多 pod 实际部署、长时间压测与 PVC/snapshot 恢复验收；这些继续复用已有 SaaS 生命周期能力。
