# opencode Server 容器化部署指南

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  K8s Pod                                            │
│  ┌──────────────────────────────────────────────┐   │
│  │  opencode-server container                   │   │
│  │  bun run src/index.ts serve                  │   │
│  │  :4096                                       │   │
│  └──────────┬───────────────────┬───────────────┘   │
│             │                   │                    │
│             ▼                   ▼                    │
│     PostgreSQL              OpenSandbox              │
│     (外部 PG)               (K8s Runtime)           │
└─────────────────────────────────────────────────────┘
```

## 前置依赖

| 组件 | 说明 |
|------|------|
| PostgreSQL | 存储 sessions、messages、auth 等全部数据 |
| OpenSandbox K8s Runtime | 提供 sandbox 容器执行代码/命令 |
| LLM Provider API Key | 如 Kimi（moonshotai-cn）、OpenAI 等 |

## 一、构建镜像

```bash
# 在仓库根目录执行
docker build -f docker/Dockerfile -t opencode-server:latest .
```

### 镜像信息

- **基础镜像**: `oven/bun:1.3.11-alpine`
- **额外依赖**: `git`, `ripgrep`（代码搜索）
- **暴露端口**: `4096`
- **健康检查**: `wget http://localhost:4096/`（30s 间隔）
- **WORKDIR**: `/app/packages/opencode`

## 二、启动容器

### 最小启动命令

> ⚠️ 以下为**最小可运行配置**，仅用于快速验证。生产部署请使用下方"完整环境变量"。

```bash
docker run -d \
  --name opencode-server \
  -p 4096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://user:pass@pg-host:5432/opencode \
  -e OPENCODE_SANDBOX_ENABLED=true \
  -e OPENCODE_SANDBOX_DOMAIN=sandbox-host:30040 \
  -e OPENCODE_SANDBOX_API_KEY=your-api-key \
  -e OPENSANDBOX_INSECURE_SERVER=YES \
  opencode-server:latest
```

> **常见遗漏**：`OPENCODE_SANDBOX_ENABLED=true` 是启用远程 sandbox 的**必要条件**，不设则所有代码执行在容器本地运行。

### 完整环境变量（含 PVC 持久化 + 认证）

```bash
docker run -d \
  --name opencode-server \
  -p 4096:4096 \
  \
  `# ── 基础配置 ──` \
  -e OPENCODE_DATABASE_URL=postgresql://user:pass@pg-host:5432/opencode \
  -e OPENCODE_SERVER_HOSTNAME=0.0.0.0 \
  -e OPENCODE_SERVER_PORT=4096 \
  -e OPENCODE_SERVER_PASSWORD=your-secure-password `# 强烈建议设置，否则无认证` \
  -e OPENCODE_DISABLE_EMBEDDED_WEB_UI=1 \
  -e OPENCODE_DISABLE_AUTOUPDATE=1 \
  \
  `# ── Sandbox 配置 ──` \
  -e OPENCODE_SANDBOX_ENABLED=true `# 必须设为 true` \
  -e OPENCODE_SANDBOX_DOMAIN=sandbox-host:30040 `# 不含协议前缀` \
  -e OPENCODE_SANDBOX_API_KEY=your-api-key \
  -e OPENSANDBOX_INSECURE_SERVER=YES \
  \
  `# ── PVC 持久化 ──` \
  -e OPENCODE_SANDBOX_VOLUME_TYPE=pvc \
  -e OPENCODE_SANDBOX_PVC_CLAIM=sandbox-test \
  -e OPENCODE_SANDBOX_IDLE_KILL_SEC=60 \
  -e OPENCODE_SANDBOX_MAX_TTL_SEC=3600 \
  opencode-server:latest
```

### 环境变量说明

#### 基础配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENCODE_DATABASE_URL` | **是** | - | PostgreSQL 连接串，设置后自动启用 PG 模式（session/message 全走 PG） |
| `OPENCODE_AUTH_PROVIDER` | 否 | `auto` | Auth 存储模式：`auto`（跟随 DATABASE_URL）/ `pg`（强制 PG）/ `file`（强制本地文件） |
| `OPENCODE_SERVER_HOSTNAME` | 否 | `127.0.0.1` | 监听地址，容器部署需设为 `0.0.0.0` |
| `OPENCODE_SERVER_PORT` | 否 | `4096` | 监听端口 |
| `OPENCODE_SERVER_PASSWORD` | 否 | - | HTTP Basic Auth 密码，**不设则无认证**（日志会警告） |
| `OPENCODE_SERVER_USERNAME` | 否 | `opencode` | HTTP Basic Auth 用户名 |
| `OPENCODE_DISABLE_EMBEDDED_WEB_UI` | 否 | `false` | 设为 `1` 禁用内嵌 Web UI |
| `OPENCODE_DISABLE_AUTOUPDATE` | 否 | `false` | 设为 `1` 禁用自动更新（容器部署建议开启） |

#### Sandbox 配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENCODE_SANDBOX_ENABLED` | **是** | `false` | **必须设为 `true`** 才能启用远程 sandbox |
| `OPENCODE_SANDBOX_DOMAIN` | **是** | `localhost:8080` | OpenSandbox K8s Runtime 地址（不含协议前缀） |
| `OPENCODE_SANDBOX_API_KEY` | **是** | - | OpenSandbox API Key |
| `OPENCODE_SANDBOX_USE_SERVER_PROXY` | 否 | `false` | 设为 `true` 让 sandbox 通过 server 代理 |
| `OPENCODE_SANDBOX_IMAGE` | 否 | 内置默认 | Sandbox 容器镜像地址 |
| `OPENCODE_SANDBOX_TIMEOUT` | 否 | `600` | 无 PVC 时 sandbox 空闲超时（秒），SDK 自动销毁 |
| `OPENSANDBOX_INSECURE_SERVER` | 否 | - | 设为 `YES` 跳过 TLS 验证 |

#### Sandbox PVC 持久化配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENCODE_SANDBOX_VOLUME_TYPE` | 否 | `none` | 存储类型：`none`（无持久化）/ `pvc`（K8s PVC）/ `host`（主机挂载） |
| `OPENCODE_SANDBOX_PVC_CLAIM` | 否 | `sandbox-test` | PVC claim 名称（`VOLUME_TYPE=pvc` 时有效） |
| `OPENCODE_SANDBOX_IDLE_KILL_SEC` | 否 | `3600` | sandbox 空闲多久后销毁（秒），PVC 数据保留 |
| `OPENCODE_SANDBOX_MAX_TTL_SEC` | 否 | `3600` | sandbox 最大存活时间（秒），兜底强制销毁 |

#### Auth 认证

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENCODE_AUTH_PROVIDER` | 否 | `auto` | Auth 存储模式 |

- `auto`（默认）：跟随 `DATABASE_URL`——设了 PG 连接串则走 PG Auth，否则走文件 Auth
- `pg`：强制 PG Auth，即使 `DATABASE_URL` 未设置也用 PG（需 `DATABASE_URL` 已配置）
- `file`：强制文件 Auth，即使配了 PG 也存本地文件

#### 工作目录

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENCODE_DEFAULT_DIRECTORY` | 否 | - | 覆盖 `process.cwd()` 作为默认工作目录。SaaS 容器化部署时建议设为 `/workspace`（空目录），避免容器内源码被 Agent 当作项目上下文 |

优先级：`?directory=` 请求参数 → `x-opencode-directory` Header → `OPENCODE_DEFAULT_DIRECTORY` → `process.cwd()`

#### SaaS 进阶配置

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `OPENCODE_PERMISSION` | 否 | - | 权限模式：`ask`（每次确认）/ `auto-ask`（自动但受限）/ `trust`（完全信任） |
| `OPENCODE_ENABLE_QUESTION_TOOL` | 否 | `false` | 设为 `true` 启用 question 工具（HTTP API 模式下建议开启） |
| `OPENCODE_MODELS_URL` | 否 | - | 自定义 models.json URL，可用于管控可用模型列表 |
| `OPENCODE_SKIP_MIGRATIONS` | 否 | `false` | 设为 `true` 跳过数据库迁移（已手动迁移时使用） |
| `OPENCODE_EXPERIMENTAL_WORKSPACES` | 否 | `false` | 设为 `true` 启用多 workspace 支持 |
| `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | 否 | - | bash 命令默认超时（毫秒） |
| `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | 否 | - | LLM 输出 token 上限 |

#### Sandbox 生命周期策略

```
┌──────────────────────────────────────────────┐
│  PVC 模式：双层超时保护                        │
│                                              │
│  L1 Idle Kill (IDLE_KILL_SEC)                │
│  ├─ 默认 60s 无命令执行 → 销毁 sandbox        │
│  ├─ PVC 数据保留，下次请求自动重建             │
│  └─ 定时器每 30s 检查一次                     │
│                                              │
│  L2 Max TTL (MAX_TTL_SEC)                    │
│  ├─ 默认 3600s（1 小时），绝对上限             │
│  └─ 即使持续有请求也会被强制销毁               │
│                                              │
│  非 PVC 模式：                                │
│  └─ TIMEOUT（默认 600s）SDK 层自动回收         │
└──────────────────────────────────────────────┘
```

## 三、添加 LLM Provider

容器启动后不含任何 LLM API Key，需通过 HTTP API 热加载：

```bash
# 添加 Kimi
curl -X PUT http://localhost:4096/auth/moonshotai-cn \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-your-kimi-api-key"}'

# 验证
curl http://localhost:4096/provider

# 删除
curl -X DELETE http://localhost:4096/auth/moonshotai-cn
```

Provider 添加后**无需重启**，server 自动热加载。数据持久化到 PG。

### 常用 Provider ID

| Provider | ID | API Key 来源 |
|----------|----|-------------|
| Kimi | `moonshotai-cn` | platform.moonshot.cn |
| OpenAI | `openai` | platform.openai.com |
| Anthropic | `anthropic` | console.anthropic.com |

## 四、API 使用

### 创建 session 并对话

```bash
# 创建 session
SID=$(curl -s -X POST http://localhost:4096/session \
  -H 'Content-Type: application/json' \
  -d '{"title":"my-task"}' | jq -r '.id')

# 发送消息
curl -X POST "http://localhost:4096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"你好"}],
    "agent": "build",
    "model": {"providerID":"moonshotai-cn","modelID":"kimi-k2.6"}
  }'
```

### 查询数据

```bash
# 所有 sessions
curl http://localhost:4096/session

# 某个 session 详情
curl http://localhost:4096/session/$SID

# 已配置的 providers
curl http://localhost:4096/provider
```

## 五、Drizzle Studio（数据库浏览器）

```bash
# 在 packages/opencode 目录下
cd packages/opencode
bun drizzle-kit studio --config drizzle.pg.config.ts
# 打开 https://local.drizzle.studio
```

## 六、Docker Desktop for Mac 注意事项

Docker Desktop 的 `--network=host` **不是真正的宿主机网络**。容器访问宿主机服务需：

1. 使用 `host.docker.internal` 代替 `127.0.0.1`
2. 或在宿主机启动 TCP 转发器：

```bash
# 宿主机转发 PG（容器通过 host.docker.internal:15432 访问）
python3 -c "
import socketserver, socket
class F(socketserver.ThreadingTCPServer): allow_reuse_address = True
class H(socketserver.BaseRequestHandler):
    def handle(self):
        back = socket.create_connection(('172.18.32.14', 5432))
        import select
        while True:
            r,_,_ = select.select([self.request, back], [], [])
            if self.request in r:
                d = self.request.recv(65536)
                if not d: break
                back.sendall(d)
            if back in r:
                d = back.recv(65536)
                if not d: break
                self.request.sendall(d)
F(('0.0.0.0', 15432), H).serve_forever()
"
```

然后容器 PG URL 改为：
```
postgresql://user:pass@host.docker.internal:15432/opencode
```

## 七、PG 连接串注意事项

- **不要加 `?schema=public`**，postgres.js 不识别该参数
- **推荐格式**: `postgresql://user:pass@host:5432/dbname`
- PG 模式下所有表自动创建（migration 自动执行）
- 隔离级别为 `read committed`（非 `repeatable read`，避免并发序列化错误）

## 八、数据表清单（PG 自动创建）

| 表 | 说明 |
|----|------|
| `session` | 会话 |
| `message` | 消息 |
| `message_part` | 消息分段 |
| `auth` | Provider API Key 存储（PG 模式） |
| `config` | 配置 |
| `share` | 分享 |
| `journal` | 事件日志 |
| ... | 共 16 张表 |

## 九、关键设计决策

| 决策 | 原因 |
|------|------|
| Auth 双层存储（文件/PG） | `defaultLayer` 根据 `Database.dialect` 自动选择，消费者无需改动 |
| Provider 热更新用 `Instance.disposeAll()` | 清除缓存，下次请求从 PG 重新加载，无需重启 |
| Sandbox 懒加载 `getSandbox()` | 避免启动时创建 sandbox，按需创建 |
| Sandbox 命令队列 `Semaphore(1)` | 每 session 串行化，防止并发冲突 |
| PG FK 全部 `DEFERRABLE INITIALLY DEFERRED` | 解决事务内 FK 约束顺序问题 |
| PVC 6 subPath 挂载 | K8s PVC 存储分离，session 维度隔离 |

## 十、故障排查

### 容器无法启动

```bash
# 查看日志
docker logs opencode-server

# 常见原因：
# 1. PG 连不上 → 检查 OPENCODE_DATABASE_URL 和网络
# 2. 端口冲突 → 改 OPENCODE_SERVER_PORT
```

### Sandbox 不生效 / 创建失败

```bash
# 1. 确认 OPENCODE_SANDBOX_ENABLED=true（最常见遗漏！）
docker exec opencode-server env | grep OPENCODE_SANDBOX_ENABLED
# 如果为空或 false → sandbox 不会启用

# 2. 确认 DOMAIN 格式正确（不含 http:// 前缀）
docker exec opencode-server env | grep OPENCODE_SANDBOX_DOMAIN
# 正确：sandbox-host:30040
# 错误：http://sandbox-host:30040

# 3. 检查 OpenSandbox 连通性
curl http://sandbox-host:30040/health

# 4. 确认所有 sandbox 环境变量
docker exec opencode-server env | grep OPENCODE_SANDBOX
```

### Provider 不生效

```bash
# 查看已配置的 auth
curl http://localhost:4096/auth

# 重新添加
curl -X PUT http://localhost:4098/auth/moonshotai-cn \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-xxx"}'
```

### Docker 代理问题

`~/.docker/config.json` 中的 `proxies` 字段可能导致容器无法联网。如果不需要代理，删除该字段：

```bash
# 检查
cat ~/.docker/config.json | jq '.proxies'

# 删除（如果存在）
jq 'del(.proxies)' ~/.docker/config.json > /tmp/docker-config.json
mv /tmp/docker-config.json ~/.docker/config.json
```

## 十一、相关文件

| 文件 | 说明 |
|------|------|
| `docker/Dockerfile` | Docker 镜像定义 |
| `.dockerignore` | 构建排除项 |
| `packages/opencode/drizzle.pg.config.ts` | PG drizzle 配置（Drizzle Studio 用） |
| `packages/opencode/src/auth/index.ts` | Auth 双层存储 |
| `packages/opencode/src/auth/auth.pg.ts` | PG auth 表定义 |
| `packages/opencode/src/server/control/index.ts` | HTTP API + 热更新 |
| `packages/opencode/src/tool/sandbox-provider.ts` | Sandbox 配置 + PVC |
| `packages/opencode/migration-pg/` | PG migration 文件 |
