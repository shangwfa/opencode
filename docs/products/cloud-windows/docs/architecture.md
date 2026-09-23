# Cloud Browser 架构设计

## 概述

Cloud Browser 是一个云端浏览器产品，提供两种使用方式：

1. **手动模式**：创建云端 Chrome 沙箱，通过 noVNC 直接操作
2. **Agent 模式**：输入自然语言需求，由 AI（opencode SaaS）驱动浏览器自动执行，实时预览执行过程

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 前端 (React + shadcn/ui)          http://localhost:5173      │
│  ├─ 手动模式：沙箱列表 + noVNC 画面                            │
│  └─ Agent 模式：对话流（SSE） + Browser 预览 + 会话历史         │
└──────────────────┬──────────────────────────────────────────┘
                   │ HTTP / WebSocket
┌──────────────────▼──────────────────────────────────────────┐
│ Vite 插件后端（server/，运行于 dev server Node 进程）           │
│  ├─ /api/sandboxes/*        沙箱 CRUD                        │
│  ├─ /api/sandboxes/:id/browser/*  浏览器操作 API（CDP 控制）   │
│  ├─ /api/agents/*           Agent 会话管理                    │
│  ├─ /api/agents/:id/events  SSE 代理 → opencode SaaS         │
│  ├─ /ws/vnc/:id             noVNC WebSocket 转发              │
│  └─ server/data/cloud-browser.db   SQLite 持久化（agent + sandbox）  │
└───────┬──────────────────────┬──────────────────┬───────────┘
        │                      │                  │
        ▼                      ▼                  ▼
┌───────────────┐   ┌───────────────────┐   ┌──────────────────┐
│ OpenSandbox    │   │ opencode SaaS     │   │ chrome-novnc 沙箱 │
│ server :8080   │   │ server :14096     │   │ 容器（Docker）    │
│ （容器编排）     │   │ （AI 能力）        │   │                  │
└───────┬───────┘   └─────────┬─────────┘   │ ├─ Chrome :9222  │
        │                     │             │ ├─ socat :9223   │
        │ 创建/销毁容器         │ 创建 AI 沙箱  │ │  (CDP 转发)    │
        ▼                     ▼             │ ├─ Xtigervnc :1  │
   Docker 容器           AI 沙箱容器          │ └─ websockify    │
                        （执行 bash）        │    :6080→5901   │
                                            └──────────────────┘
```

## 核心流程

### Agent 任务执行流程

1. 用户在前端输入需求（如"抓取 F1 车手积分榜"）
2. `POST /api/agents`：
   - 创建 chrome-novnc 沙箱（VNC + CDP）
   - 创建 opencode SaaS session
   - 注册 `cloud-browser` skill（包含浏览器操作 API 用法 + 该沙箱的 ID）
   - 发送 prompt（`prompt_async`，携带 `skills: ["cloud-browser"]`）
3. AI 加载 skill，用 bash + curl 调用浏览器操作 API：
   ```
   AI 沙箱容器 → curl http://host.docker.internal:5173/api/sandboxes/:id/browser/...
   ```
4. 前端通过 SSE（`/api/agents/:id/events` → SaaS `/event`）实时接收：
   - `message.part.updated` — AI 思考/工具调用进度
   - `session.idle` — 任务完成
5. 右侧 Browser 面板通过 noVNC 实时显示浏览器画面

### 浏览器操作 API（skill 的数据面）

AI 通过 curl 调用，Vite 插件用 playwright-core 经 CDP 控制沙箱内 Chrome：

| 端点 | 说明 |
|---|---|
| `POST .../browser/navigate` | 打开 URL `{url}` |
| `GET .../browser/snapshot` | 获取可交互元素列表（带 ref 标号，如 `[e1] a "登录"`） |
| `POST .../browser/click` | 点击元素 `{ref}` |
| `POST .../browser/type` | 输入文本 `{ref, text}` |
| `POST .../browser/key` | 按键 `{key}`（Enter/Tab 等） |
| `POST .../browser/scroll` | 滚动 `{direction, amount}` |
| `GET .../browser/text` | 页面正文文本 |
| `GET .../browser/state` | 当前 URL + 标题 |
| `GET .../browser/screenshot` | 截图（base64 JPEG） |

**ref 标号机制**：snapshot 时向页面注入脚本，给可见可交互元素（a/button/input/[role] 等）标注 `data-cb-ref="eN"`，返回文本化元素列表。AI 用 ref 引用元素。每次操作后需重新 snapshot（DOM 变化后 ref 失效）。

## 关键组件

### chrome-novnc 镜像（docker/chrome-novnc/）

基于 `opensandbox/chrome:latest`：

- `Xtigervnc :1 -geometry 1280x1024` — 虚拟显示（由基础镜像 `/entrypoint` 启动）
- `websockify 0.0.0.0:6080 → 127.0.0.1:5901` — VNC WebSocket 网关
- `socat TCP-LISTEN:9223 → 127.0.0.1:9222` — CDP 端口转发（Chrome CDP 默认只绑 localhost，必须转发才能被容器外的 OpenSandbox proxy 访问）
- 中文字体（fonts-noto-cjk）

构建：`npm run image:build`

### Vite 插件（server/plugin.ts）

- `configureServer` 挂载 connect 中间件处理 `/api/*`
- 监听 httpServer `upgrade` 事件处理 `/ws/vnc/:id`（与 Vite HMR WebSocket 不冲突——HMR 只处理 `vite-hmr`/`vite-ping` 协议）
- SSE 代理用原生 `http.request` 流式转发（pipe），支持断开清理

### 数据存储（server/db.ts）

SQLite（better-sqlite3），文件 `server/data/cloud-browser.db`：

```sql
agent (id, sandbox_id, session_id, directory, prompt, title, status, created_at)
sandbox (id, created_at, status)
sandbox_alias (old_id, new_id)  -- 沙箱重建后的 ID 映射
```

- `sandbox_id` — chrome-novnc 沙箱（浏览器）
- `session_id` — opencode SaaS 会话
- 重启后沙箱可通过 `Sandbox.connect` 按 ID 重连（`requireSandbox` 懒重连）

### 沙箱重建（sandbox_alias）

浏览器沙箱有生命周期（当前 1 小时超时回收）。沙箱销毁后：

1. 前端 VNC 面板显示「重建浏览器」按钮 → `POST /api/agents/:id/rebuild-browser`
2. 后端创建新沙箱，更新 `agent.sandbox_id`，写入 `sandbox_alias(old_id → new_id)`，并向 SaaS session 重新注册 skill（同名 upsert，content 含新 ID）
3. **透明路由**：`requireSandbox` 解析 ID 时沿 alias 链跳转到当前活跃沙箱。AI 上下文中旧 skill 里的旧沙箱 ID 无需更新——用旧 ID 调用浏览器 API / VNC WebSocket 都会自动路由到新沙箱，AI 无感知

## 环境依赖

| 服务 | 地址 | 启动方式 |
|---|---|---|
| OpenSandbox server | `127.0.0.1:8080` | `OPENSANDBOX_INSECURE_SERVER=YES uvx opensandbox-server`（配置 `~/.sandbox.toml`，Docker runtime） |
| opencode SaaS | `:14096` | `docker run opencode-saas-sandbox-test:v2fix`（组合 3：本地 PG + 本地沙箱，见 `docs/local-test-env.md`） |
| 本地 PG 转发 | `:15432 → 127.0.0.1:5432` | node net 转发脚本 |
| Cloud Browser | `:5173` | `npm run dev` |

## 配置（.env）

```bash
OPENCODE_SANDBOX_DOMAIN=127.0.0.1:8080      # OpenSandbox server
OPENCODE_SANDBOX_API_KEY=
OPENCODE_CHROME_IMAGE=cloud-browser/chrome-novnc:latest
OPENCODE_SAAS_BASE_URL=http://localhost:14096   # opencode SaaS
OPENCODE_SAAS_MODEL=zhipuai/glm-5.1             # AI 模型
CLOUD_BROWSER_API_BASE=http://host.docker.internal:5173  # AI 沙箱访问本服务的地址
PORT=3000  # （未使用，Vite 默认 5173）
```

## 设计决策

1. **AI 与浏览器分离**：AI 在 opencode SaaS 的沙箱里执行（bash 工具），浏览器在独立的 chrome-novnc 沙箱。两者通过 cloud-browser REST API 桥接。好处：opencode SaaS 无需任何改造，沙箱镜像各自独立演进。
2. **用 skills 而非 MCP**：skill 只是 prompt 文档（SKILL.md 写入 SaaS session），AI 用内置 bash 工具 curl 调用 API。无额外协议、无进程桥接，最简集成。
3. **CDP 用 playwright-core**：不下载浏览器二进制，只作 CDP 客户端连接沙箱内 Chrome。
4. **VNC 只读预览**：AI 操作期间用户可通过 noVNC 观看；`focusOnClick` 允许用户手动介入。
