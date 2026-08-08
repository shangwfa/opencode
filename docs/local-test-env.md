# 本地测试环境指南

本地运行 opencode SaaS 容器，PG 与 Sandbox 可各自选择本地或远端，组合成三种推荐配置：

1. **远端 PG + 远端 Sandbox（K8s）**：原始方案，完全依赖远端基础设施。
2. **远端 PG + 本地 OpenSandbox（Docker runtime）**：PG 用远端，沙箱在本机 Docker 创建，避免依赖远端 K8s。
3. **本地 PG（Homebrew）+ 本地 OpenSandbox（Docker runtime）**：PG 与沙箱均在本地，完全离线可用。

> **PG 连接配置（本地与远端区分）**：
>
> | | 远端 PG | 本地 PG |
> |---|---|---|
> | 用户 / 密码 | `app` / `8zuhlMLd4gaeUG5k` | `local` / 无密码 |
> | 连接串 | `postgresql://app:8zuhlMLd4gaeUG5k@host.docker.internal:15432/opencode` | `postgresql://local@host.docker.internal:15432/opencode` |
> | 数据完整度 | account/auth/provider 历史数据完整 | 全空，需手动补 credential + `ZHIPU_API_KEY` |

> **Docker runtime**：推荐使用 [OrbStack](https://orbstack.dev/) 替代 Docker Desktop——更轻量、启动快、镜像存储稳定。如果 Docker Desktop 出现 blob I/O error，切换到 OrbStack 即可（`docker context use orbstack`）。

---

## 一、基础设施架构

远端模式（组合 1）：

```
本机（macOS）
  ├─ Docker 容器 opencode-saas-test（localhost:14096）
  │    ├─ 通过 host.docker.internal:15432 → 宿主机转发 → 172.18.32.14:5432（远端 PG）
  │    └─ 通过 host.docker.internal:30040 → 宿主机转发 → 172.18.32.15:30040（远端 Sandbox API）
  ├─ TCP 转发进程（node，后台运行）
  │    ├─ 0.0.0.0:15432 → 172.18.32.14:5432
  │    └─ 0.0.0.0:30040 → 172.18.32.15:30040
  └─ 浏览器访问 http://localhost:14096/...
```

本地 OpenSandbox 模式（组合 2 远端 PG / 组合 3 本地 PG）：

```
本机（macOS）
  ├─ Docker 容器 opencode-saas-test（localhost:14096）
  │    ├─ 通过 host.docker.internal:15432 → 宿主机转发 → 远端 PG 172.18.32.14:5432（组合 2）或本地 PG 127.0.0.1:5432（组合 3）
  │    └─ 通过 host.docker.internal:8080 → 本地 OpenSandbox server
  ├─ OpenSandbox server（localhost:8080）
  │    └─ Docker runtime 创建 sandbox 容器
  └─ sandbox 镜像：由 packages/opencode/docker/Dockerfile 构建
```

| 组件 | 地址 | 说明 |
|---|---|---|
| opencode 容器 | `localhost:14096` | 映射容器内 4096 端口 |
| 远端 PG | `172.18.32.14:5432` | 含 AI provider key、session 数据 |
| 远端 Sandbox API | `172.18.32.15:30040` | K8s 沙箱管理服务 |
| PG 本地转发 | `localhost:15432` | 容器通过 host.docker.internal:15432 访问 |
| Sandbox 本地转发 | `localhost:30040` | 容器通过 host.docker.internal:30040 访问 |
| 本地 OpenSandbox server | `localhost:8080` | Docker runtime，本地创建 sandbox 容器 |

---

## 二、首次准备

本环境涉及**两个不同的镜像**，务必区分清楚：

| | SaaS 服务镜像 | OpenSandbox 沙箱镜像 |
|---|---|---|
| 用途 | 运行 opencode SaaS server（监听 `:4096`），即 `docker run` 启动的主容器 | 沙箱内执行 AI 工具/用户代码的容器，由 OpenSandbox server 按需拉起 |
| Dockerfile | 根目录 `Dockerfile` | `packages/opencode/docker/Dockerfile` |
| 镜像 tag | `opencode-saas-sandbox-test:v2fix` | `opencode-opensandbox:local` |
| 哪些组合需要 | **三种组合都需要** | 仅组合 2、3（本地 OpenSandbox） |
| 重新构建时机 | 根目录 `Dockerfile` 或 SaaS 代码改动时 | sandbox 内 ripgrep / Node 版本 / LSP daemon 改动时 |

> ⚠️ SaaS 镜像 tag 名 `opencode-saas-sandbox-test` 虽含 "sandbox"，但它是**服务镜像**（跑 server），不是沙箱镜像。沙箱镜像是 `opencode-opensandbox:local`，别被名字误导。

### 2.1 构建 SaaS 服务镜像（三种组合都需要）

构建组合流程中 `docker run` 使用的主容器（运行 opencode SaaS server，监听容器内 `:4096`）：

```bash
cd /Users/ruomu/code/opencode
docker build -t opencode-saas-sandbox-test:v2fix -f Dockerfile .
```

> 首次必须构建；后续仅当根目录 `Dockerfile` 或 SaaS 代码改动时才需重新构建。
>
> **固定 tag 复用风险**：`v2fix` 等固定 tag 会复用旧镜像缓存——若工作区新增源码文件（如新增模块）而未重建，旧镜像启动时会因缺文件崩溃（实测：`Cannot find module './tool-execution'` → server HTTP 000）。建议改用内容/commit hash 作 tag 以绑定源码版本：
> ```bash
> docker build -t "opencode-saas-sandbox-test:$(git rev-parse --short HEAD)" -f Dockerfile .
> ```
> 注：根 Dockerfile（SaaS server 镜像）目前**无 CI 构建**——`.github/workflows` 中 `containers.yml` 仅构建 `packages/containers/**`（dev container），`publish.yml` 的 docker/buildx 用于 CLI/desktop。SaaS 服务镜像完全依赖本地手动构建。

### 2.1.1 构建 OpenSandbox 沙箱镜像（组合 2、3 需要）

组合 2、3 使用本地 OpenSandbox server + Docker runtime 创建沙箱，需要本节构建沙箱镜像（组合 1 走远端 K8s 沙箱，可跳过）。沙箱镜像基于 `opensandbox/code-interpreter:latest`，内置 `ripgrep`、多版本 Node.js（mise 管理）和 LSP daemon，**不含 opencode 主二进制**（opencode server 跑在 SaaS 容器，不在沙箱内）。与上方 SaaS 服务镜像是**完全不同的两个镜像**（见总览表）。

> 私有 registry `registry.shadow-rpa.net` 不可达时，用公共镜像替代构建（见 7.6）：
> ```bash
> sed 's|registry.shadow-rpa.net/infra/opensandbox:2026-06-09|opensandbox/code-interpreter:latest|g' \
>   packages/opencode/docker/Dockerfile > /tmp/Dockerfile.sandbox
> docker buildx build --platform linux/arm64 -t opencode-opensandbox:local -f /tmp/Dockerfile.sandbox --load packages/opencode
> ```

```bash
cd /Users/ruomu/code/opencode/packages/opencode

# Apple Silicon（M 系列）用 arm64；Intel Mac 改为 linux/amd64
docker buildx build --platform linux/arm64 \
  -t opencode-opensandbox:local \
  -f docker/Dockerfile \
  --load .

# 验证镜像继承了 code-interpreter 入口，且 rg/node 可用。
docker image inspect opencode-opensandbox:local \
  --format 'entrypoint={{json .Config.Entrypoint}} workdir={{json .Config.WorkingDir}}'

docker run --rm --entrypoint /bin/bash opencode-opensandbox:local -lc \
  'rg --version | head -1 && node --version && python3 --version'
```

期望：
- `entrypoint` 为 `code-interpreter.sh`（私有镜像 `/opt/opensandbox/...`，公共镜像 `/opt/code-interpreter/...`）
- `workdir=/workspace`
- `ripgrep 14.1.0` 或兼容版本正常输出
- `node` / `python3` 正常输出

> 不要在 `packages/opencode/docker/Dockerfile` 里覆盖 `ENTRYPOINT`。OpenSandbox 需要继承 `code-interpreter` 的入口脚本以便注入并启动 execd；覆盖入口会导致 `commands.run()` 返回 502。

### 2.2 确认远端连通性

```bash
# 从宿主机验证远端 PG 可达
timeout 3 nc -z 172.18.32.14 5432 && echo "PG OK" || echo "PG unreachable"

# 从宿主机验证远端 Sandbox API 可达
timeout 3 nc -z 172.18.32.15 30040 && echo "Sandbox API OK" || echo "Sandbox API unreachable"
```

---

## 三、组合启动流程

每个组合是一个完整的、可照做的端到端流程：连通性检查 →（可选）本地 OpenSandbox server → TCP 转发 → 启动容器 → 基础验证。完成任一组合后，进行高级操作（dev server、exec、proxy、LSP）见本节末尾「通用验证与使用」。

> 通用前置：先按 2.1 构建 SaaS 服务镜像（三种组合都需要）；组合 2、3 还需按 2.1.1 构建 sandbox 沙箱镜像。

---

### 组合 1：远端 PG + 远端 Sandbox（K8s）

**Step 1：确认远端连通性**

```bash
timeout 3 nc -z 172.18.32.14 5432 && echo "PG OK" || echo "PG unreachable"
timeout 3 nc -z 172.18.32.15 30040 && echo "Sandbox API OK" || echo "Sandbox API unreachable"
```

**Step 2：启动 TCP 转发**（远端 PG + 远端 Sandbox）

> 每次开机或转发进程死掉后需要重新执行。

```bash
kill $(lsof -ti :15432) 2>/dev/null
kill $(lsof -ti :30040) 2>/dev/null

# 远端 PG 转发（15432 → 172.18.32.14:5432）
nohup node -e "
const net = require('net');
net.createServer(c => {
  const r = net.connect(5432, '172.18.32.14');
  c.pipe(r); r.pipe(c);
  c.on('error', () => r.destroy()); r.on('error', () => c.destroy());
}).listen(15432, '0.0.0.0', () => console.log('PG forward ready on :15432'));
" > /tmp/pg-forward.log 2>&1 &

# Sandbox API 转发（30040 → 172.18.32.15:30040）
nohup node -e "
const net = require('net');
net.createServer(c => {
  const r = net.connect(30040, '172.18.32.15');
  c.pipe(r); r.pipe(c);
  c.on('error', () => r.destroy()); r.on('error', () => c.destroy());
}).listen(30040, '0.0.0.0', () => console.log('Sandbox forward ready on :30040'));
" > /tmp/sandbox-forward.log 2>&1 &

sleep 2
lsof -i :15432 | grep LISTEN && echo "PG forward OK"
lsof -i :30040 | grep LISTEN && echo "Sandbox forward OK"
```

**Step 3：启动容器**

```bash
docker rm -f opencode-saas-test 2>/dev/null

docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://app:8zuhlMLd4gaeUG5k@host.docker.internal:15432/opencode \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:30040 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  opencode-saas-sandbox-test:v2fix

sleep 10 && docker logs opencode-saas-test 2>&1 | tail -3
# 期望：Warning: OPENCODE_SERVER_PASSWORD is not set
#        opencode server listening on http://0.0.0.0:4096
```

> **API key 说明（远端 PG）**：组合 1/2 使用远端 PG，provider API key 已持久化在 `credential` 表（历史数据完整），**容器启动无需 `-e ZHIPU_API_KEY`**，server 启动时会从 PG 加载并激活 credential。仅组合 3（本地 PG 全空）才必须传 `-e ZHIPU_API_KEY`。验证方式：`docker exec opencode-saas-test env | grep ZHIPU` 可能为空，但只要 `/message` 能收到 AI 回复即说明 credential 加载正常（2026-08-07 实测）。

**Step 4：基础验证**

```bash
# 服务健康（--noproxy 绕过本地代理）
curl -s --noproxy '*' http://localhost:14096/ -o /dev/null -w "HTTP %{http_code}\n"  # 期望 200

# 创建 session
SID=$(curl -s --noproxy '*' -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 验证 AI provider（期望看到 AI 文字回复）
curl -s --noproxy '*' --max-time 30 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:100])
"
```

> **权限配置**：当前版本默认权限已包含 `allow`，无需手动配置。如果遇到工具调用卡在 `running`，再通过 `PATCH /global/config` 配置权限（会触发实例 dispose，需重建 session）。

✅ 组合 1 启动完成。进行高级操作见本节末尾「通用验证与使用」。

---

### 组合 2：远端 PG + 本地 OpenSandbox（Docker runtime）

**Step 1：确认远端 PG 连通**

```bash
timeout 3 nc -z 172.18.32.14 5432 && echo "PG OK" || echo "PG unreachable"
```

**Step 2：启动本地 OpenSandbox server**

本地 OpenSandbox server 读取 `~/.sandbox.toml`，使用 Docker runtime 创建 sandbox 容器。

```bash
docker info >/dev/null && echo "Docker OK"

# 推荐配置：Docker runtime + direct ingress
cat > ~/.sandbox.toml <<'EOF'
[runtime]
type = "docker"

[docker]
network_mode = "bridge"

[ingress]
mode = "direct"

[egress]
image = "opensandbox/egress:v1.0.8"
mode = "dns"
EOF

# 启动本地 OpenSandbox server
kill $(lsof -ti :8080) 2>/dev/null || true
nohup env OPENSANDBOX_INSECURE_SERVER=YES uvx opensandbox-server \
  > /tmp/opensandbox-server.log 2>&1 &

# 验证健康状态
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s http://127.0.0.1:8080/health && break
  sleep 2
done
```

期望：

```json
{"status":"healthy"}
```

可选：验证 sandbox 镜像可用：

```bash
cd /Users/ruomu/code/opencode/packages/opencode

OPENCODE_SANDBOX_DOMAIN=localhost:8080 OPENCODE_SANDBOX_API_KEY= bun -e '
import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"

const sb = await Sandbox.create({
  connectionConfig: new ConnectionConfig({
    domain: "localhost:8080",
    protocol: "http",
    useServerProxy: false,
  }),
  image: "opencode-opensandbox:local",
  timeoutSeconds: 120,
})

try {
  const result = await sb.commands.run("opencode --version && rg --version | head -1 && node --version && python3 --version 2>&1")
  console.log(result.logs.stdout.map((line) => line.text).join("\n"))
} finally {
  await sb.kill().catch(() => {})
  await sb.close().catch(() => {})
}
'
```

> 返回 502 时检查：`docker image inspect opencode-opensandbox:local` 的 entrypoint 是否为 `/opt/opensandbox/code-interpreter.sh`、sandbox 容器内 `/tmp/execd.log`、`/tmp/opensandbox-server.log`、是否误用 amd64 镜像导致 QEMU 下 execd 崩溃。

**Step 3：启动远端 PG 转发**

```bash
kill $(lsof -ti :15432) 2>/dev/null

nohup node -e "
const net = require('net');
net.createServer(c => {
  const r = net.connect(5432, '172.18.32.14');
  c.pipe(r); r.pipe(c);
  c.on('error', () => r.destroy()); r.on('error', () => c.destroy());
}).listen(15432, '0.0.0.0', () => console.log('PG forward ready on :15432'));
" > /tmp/pg-forward.log 2>&1 &

sleep 2 && lsof -i :15432 | grep LISTEN && echo "PG forward OK"
```

**Step 4：启动容器**

```bash
docker rm -f opencode-saas-test 2>/dev/null

docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://app:8zuhlMLd4gaeUG5k@host.docker.internal:15432/opencode \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local \
  opencode-saas-sandbox-test:v2fix

sleep 10 && docker logs opencode-saas-test 2>&1 | tail -5
```

> 本地 OpenSandbox Docker runtime 场景说明：
> - `OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080`，SaaS 容器需从容器内访问宿主机 OpenSandbox server。
> - `OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local`，指定本地构建的 sandbox 镜像。
> - `OPENCODE_SANDBOX_USE_SERVER_PROXY=true`，SDK 在 SaaS 容器内运行，不能直连宿主机 Docker endpoint，必须经 OpenSandbox server proxy 转发到 execd。

**Step 5：基础验证**

```bash
curl -s --noproxy '*' http://localhost:14096/ -o /dev/null -w "HTTP %{http_code}\n"  # 期望 200

SID=$(curl -s --noproxy '*' -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --noproxy '*' --max-time 30 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:100])
"
```

✅ 组合 2 启动完成。进行高级操作见本节末尾「通用验证与使用」。

### 组合 3：本地 PG（Homebrew）+ 本地 OpenSandbox（Docker runtime）

**Step 1：配置本地 PG（首次）**

本地 PG 使用 `local` 用户（无密码），与远端 `app` 用户区分。首次需用超级用户创建用户和数据库：

```bash
psql postgres -c "CREATE USER local SUPERUSER;" -c "CREATE DATABASE opencode OWNER local;"
```

> 首次创建 session 前可能需修复 SQLite schema（`pvc_mode`/`app_id` 列），见常见问题表。
> **credential 激活时机**：opencode server 首次启动时会从 `~/.local/share/opencode/auth.json` 导入 credential 到 PG（默认未激活）。需在 Step 4 容器启动**之后**执行激活：`psql postgresql://local@127.0.0.1:5432/opencode -c "UPDATE credential SET active = true WHERE connector_id = 'zhipuai';"`。若已传 `-e ZHIPU_API_KEY`（Step 4），provider 可直接用环境变量 key，激活非必须。

**Step 2：启动本地 OpenSandbox server**

本地 OpenSandbox server 读取 `~/.sandbox.toml`，使用 Docker runtime 创建 sandbox 容器：

```bash
docker info >/dev/null && echo "Docker OK"

# 推荐配置：Docker runtime + direct ingress
cat > ~/.sandbox.toml <<'EOF'
[runtime]
type = "docker"

[docker]
network_mode = "bridge"

[ingress]
mode = "direct"

[egress]
image = "opensandbox/egress:v1.0.8"
mode = "dns"
EOF

# 启动本地 OpenSandbox server
kill $(lsof -ti :8080) 2>/dev/null || true
nohup env OPENSANDBOX_INSECURE_SERVER=YES uvx opensandbox-server \
  > /tmp/opensandbox-server.log 2>&1 &

# 验证健康状态
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s http://127.0.0.1:8080/health && break
  sleep 2
done
```

期望：`{"status":"healthy"}`。若返回 502，检查 sandbox 镜像 entrypoint 是否为 `/opt/opensandbox/code-interpreter.sh`（`docker image inspect opencode-opensandbox:local`）、sandbox 容器内 `/tmp/execd.log`、是否误用 amd64 镜像导致 QEMU 下 execd 崩溃。

**Step 3：启动本地 PG 转发**

Homebrew PG 只监听 `127.0.0.1:5432`，Docker 容器需经 `host.docker.internal:15432` 访问，故手动转发：

```bash
kill $(lsof -ti :15432) 2>/dev/null  # 先停掉可能存在的远端 PG 转发

nohup node -e "
const net = require('net');
net.createServer(c => {
  const r = net.connect(5432, '127.0.0.1');
  c.pipe(r); r.pipe(c);
  c.on('error', () => r.destroy()); r.on('error', () => c.destroy());
}).listen(15432, '0.0.0.0', () => console.log('Local PG forward ready on :15432 -> 127.0.0.1:5432'));
" > /tmp/pg-local-forward.log 2>&1 &

sleep 2 && lsof -i :15432 | grep LISTEN && echo "PG forward OK"
```

**Step 4：启动容器**

```bash
docker rm -f opencode-saas-test 2>/dev/null

docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://local@host.docker.internal:15432/opencode \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local \
  -e ZHIPU_API_KEY \
  opencode-saas-sandbox-test:v2fix

sleep 10 && docker logs opencode-saas-test 2>&1 | tail -3
```

> 本地 PG 场景注意：
> - `-e ZHIPU_API_KEY` 必传（本地 PG credential → 环境变量映射链路不完整，见 7.4）。
> - 若发消息报 `ProviderModelNotFoundError`，确认 key 已传入容器：`docker exec opencode-saas-test env | grep ZHIPU`。

**Step 5：基础验证**

```bash
curl -s --noproxy '*' http://localhost:14096/ -o /dev/null -w "HTTP %{http_code}\n"  # 期望 200

SID=$(curl -s --noproxy '*' -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

curl -s --noproxy '*' --max-time 30 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:100])
"
```

✅ 组合 3 启动完成。进行高级操作见下方「通用验证与使用」。

> **备选：宿主机直接跑 server（跳过 SaaS 容器）**。本地 Docker runtime 的稳定回归路径是宿主机直接启动 opencode server，规避容器内外地址转换问题：

```bash
cd /Users/ruomu/code/opencode/packages/opencode

env \
  OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:15432/opencode' \
  OPENCODE_AUTH_PROVIDER=pg \
  OPENCODE_SANDBOX_ENABLED=1 \
  OPENCODE_SANDBOX_DOMAIN=127.0.0.1:8080 \
  OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local \
  OPENCODE_SANDBOX_USE_SERVER_PROXY=false \
  OPENCODE_DEFAULT_DIRECTORY='/Users/ruomu/code/opencode' \
  OPENCODE_DISABLE_DEFAULT_PLUGINS=1 \
  OPENCODE_DISABLE_EXTERNAL_SKILLS=1 \
  bun run --conditions=browser ./src/index.ts serve --hostname 127.0.0.1 --port 14097 --print-logs --pure
```

> ⚠️ **HTTP 代理注意**：如果宿主机设置了 `http_proxy`/`https_proxy`（如 clash、v2ray），curl 请求会被代理拦截导致所有 API 返回 500。所有 curl 命令必须加 `--noproxy '*'`，或设置 `export NO_PROXY=localhost,127.0.0.1`。

### 通用验证与使用

> 以下操作对三种组合通用。需先完成上方任一组合的启动流程，并拿到 `$SID`（基础验证中创建的 session ID）。若新开 shell，重新设置：
> ```bash
> SID="你的 session ID"
> ```

**在沙箱中启动 dev server**

> ⚠️ **必须使用 `background:true`**，否则 AI 消息完成后沙箱立即被销毁，dev server 进程消失。

```bash
# --- Vite ---
# 若项目不存在，先创建（只需一次）：
curl -s --max-time 300 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行: npx create-vite@5 /workspace/vite-app --template react-ts --yes && cd /workspace/vite-app && npm install"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 启动 Vite（background:true）
curl -s --max-time 60 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 工具执行，background 必须设为 true: cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

sleep 10
curl -s http://localhost:14096/session/$SID/proxy/5173/ -o /dev/null -w "Vite: %{http_code}\n"


# --- Next.js ---
# 若项目不存在，先创建（只需一次）：
curl -s --max-time 300 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行: npx create-next-app@14 /workspace/next-app --js --app --no-eslint --no-tailwind --no-src-dir --no-import-alias --yes && cd /workspace/next-app && npm install"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 启动 Next.js（background:true）
curl -s --max-time 60 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 工具执行，background 必须设为 true: cd /workspace/next-app && npx next dev -H 0.0.0.0 -p 3000"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

sleep 20
curl -s http://localhost:14096/session/$SID/proxy/3000/ -o /dev/null -w "Next.js: %{http_code}\n"
```

**浏览器验证**

```
Vite (proxy):    http://localhost:14096/session/{SID}/proxy/5173/
Next.js (proxy): http://localhost:14096/session/{SID}/proxy/3000/
```

**Endpoint API 验证（直连模式）**

```bash
# 获取沙箱直连 IP
curl -s http://localhost:14096/session/$SID/endpoint/5173 | python3 -m json.tool

# 验证直连访问
URL=$(curl -s http://localhost:14096/session/$SID/endpoint/5173 | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")
echo "Direct URL: $URL"
curl -s --max-time 10 "$URL/" -o /dev/null -w "Direct: HTTP %{http_code}\n"
```

期望：
- `mode=direct`，`url` 为沙箱 Pod IP（如 `http://10.12.11.x:5173`）
- 直连访问 HTTP 200
- 直连模式下无 proxy prefix 注入，是原始 Vite 输出

**验证工具调用过程**

> `POST /message` 返回的是 AI 的文字总结，工具调用在前一条消息中。验证工具是否真正执行需要查完整消息列表。

```bash
curl -s http://localhost:14096/session/$SID/message | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for i, m in enumerate(msgs):
    tools = [p.get('tool','') for p in m.get('parts',[]) if p.get('type')=='tool']
    text = [p.get('text','')[:50] for p in m.get('parts',[]) if p.get('type')=='text']
    marker = '🔧' if tools else '💬'
    print(f'  {marker} [{i:2d}] tools={tools or \"-\"} text={text[:1] or \"-\"}')
')
```

**使用 exec API 程序化控制沙箱**

> 不依赖 AI 模型是否正确传递 `background:true`，直接通过 HTTP API 在沙箱中执行命令和设置 keepAlive。

```bash
# 执行命令
curl -s -X POST http://localhost:14096/session/$SID/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello-from-exec"}' | python3 -m json.tool

# 设置 keepAlive（防止 sandbox idle 被回收）
curl -s -X POST http://localhost:14096/session/$SID/keep-alive \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | python3 -m json.tool

# 设置 keepAlive + 立即启动沙箱（boot:true 无需先发 AI 消息即可创建沙箱）
curl -s -X POST http://localhost:14096/session/$SID/keep-alive \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}' | python3 -m json.tool

# 通过 exec 启动 dev server（nohup 放后台）
curl -s --max-time 10 -X POST http://localhost:14096/session/$SID/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && nohup npx vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 & echo $!"}' \
  | python3 -c "import json,sys;print('PID:', json.load(sys.stdin).get('stdout','').strip())"

sleep 8
curl -s http://localhost:14096/session/$SID/proxy/5173/ -o /dev/null -w "Vite: %{http_code}\n"
```

期望：
- exec 返回 `{exitCode: 0, stdout: "hello-from-exec\n"}`
- keep-alive（无 boot）返回 `{keepAlive: true, sandboxId: null}`
- keep-alive（`boot:true`）返回 `{keepAlive: true, sandboxId: "xxx"}`
- Vite proxy 返回 HTTP 200

---

## 四、已有测试 Session（PVC 数据持久）

PVC 卷上的文件会保留，容器重启后只需重新启动 dev server 进程即可复用。

> ⚠️ 以下 session ID 是测试过程中产生的，可能已被 cleanup 或过期，需根据实际 session 列表替换。

| Session ID | 项目 | 端口 | Proxy URL |
|---|---|---|---|
| `ses_1d53684f0ffeG7NMWxbffMudcs` | Vite 5 + React Router | 5173 | `http://localhost:14096/session/ses_1d53684f0ffeG7NMWxbffMudcs/proxy/5173/` |
| `ses_1d52f1c8cffeiSZAgZNA8XElBE` | Next.js 14 (含 about/contact 页) | 3000 | `http://localhost:14096/session/ses_1d52f1c8cffeiSZAgZNA8XElBE/proxy/3000/` |

复用已有 session 启动 dev server：

```bash
# Vite
SID="ses_1d53684f0ffeG7NMWxbffMudcs"
curl -s --max-time 60 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 工具执行，background 必须设为 true: cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# Next.js
SID="ses_1d52f1c8cffeiSZAgZNA8XElBE"
curl -s --max-time 60 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 工具执行，background 必须设为 true: cd /workspace/next-app && npx next dev -H 0.0.0.0 -p 3000"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```

---

## 五、keepAlive 机制说明

有两种方式触发 keepAlive：

### 方式一：bash 工具 `background:true`（AI 消息触发）

```
bash.ts (background:true)
  → 命令执行完后调用 sandboxProvider.keepAlive(sessionID)
    → leases.add(sessionID)
    → run-state.ts onIdle 时检查 isKeepAlive
      → true：跳过销毁，sandbox 保持
      → false：destroy(sessionID)，sandbox 立即销毁
```

### 方式二：exec + keep-alive API（程序化触发，推荐）

```
POST /session/:sessionID/keep-alive {"enabled":true}
  → sandboxProvider.keepAlive(sessionID)
  → 后续可通过 exec API 随时在沙箱中执行命令

POST /session/:sessionID/keep-alive {"enabled":true,"boot":true}
  → sandboxProvider.keepAlive(sessionID) + getOrCreate(sessionID)
  → 立即创建沙箱，无需先发 AI 消息或 exec

POST /session/:sessionID/exec {"command":"nohup npx vite ... &"}
  → 直接在沙箱中执行命令，启动 dev server 等
  → 配合 keepAlive 保证沙箱不被回收
```

> 方式二不依赖 AI 模型是否正确传递 `background:true`，更适合自动化测试和程序化控制。
> `boot:true` 适合需要预热情景——调用后沙箱立即可用，`sandboxId` 返回在响应中；boot 失败不影响 keepAlive 设置，`sandboxId` 返回 `null`。

---

## 六、常见问题

| 症状 | 原因 | 解决 |
|---|---|---|
| 502 sandbox unreachable | sandbox 被回收（没有 keepAlive）| 重新发消息用 `background:true` 启动 dev server |
| 502 "All connection attempts failed" | TCP 转发进程死了 | 重新执行对应组合的 TCP 转发步骤 |
| 404 from sandbox server proxy | `OPENCODE_SANDBOX_USE_SERVER_PROXY` 未设置 | 重新启动容器加 `-e OPENCODE_SANDBOX_USE_SERVER_PROXY=true` |
| 本地 OpenSandbox `commands.run()` 502 | sandbox 镜像覆盖了 `code-interpreter` entrypoint，或 execd 崩溃 | 确认 sandbox 镜像继承 `/opt/opensandbox/code-interpreter.sh`，不要设置 `ENTRYPOINT ["opencode"]` |
| 本地 arm64 上 execd 崩溃 | 使用了 amd64 镜像，Docker 通过 QEMU 运行 | 用 `docker buildx build --platform linux/arm64 --load` 构建本地镜像 |
| opencode 二进制 `required file not found` | Ubuntu/glibc 基础镜像复制了 `*-musl` 二进制 | `packages/opencode/docker/Dockerfile` 应复制 `dist/opencode-linux-arm64/bin/opencode` 或 `dist/opencode-linux-x64-baseline/bin/opencode` |
| 本地 OpenSandbox 找不到镜像 | SaaS 容器指定的 image 名称不是 Docker daemon 中的本地镜像名 | 先 `docker images | grep opencode-opensandbox`，并设置 `OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local` |
| 401 MISSING_API_KEY | proxy fetch 未带 API key | 检查代码是否有 `Flag.OPENCODE_SANDBOX_API_KEY` header 注入 |
| ProviderModelNotFoundError | AI provider 未配置 | 确认容器连的是远端 PG（含 account 数据），或设置 `ZHIPU_API_KEY` 环境变量 |
| 所有 API 返回 500 UnknownError | 宿主机 HTTP 代理（`http_proxy`）拦截 curl 请求 | curl 加 `--noproxy '*'`，或 `export NO_PROXY=localhost,127.0.0.1` |
| POST /session 返回 500，错误 `table session has no column named pvc_mode` | SQLite migration 缺少合并后新增的 `pvc_mode`/`app_id` 列 | 手动添加列：`docker exec -u 0 <container> bun -e 'const {Database}=require("bun:sqlite");const d=new Database("/home/opencode/.local/share/opencode/opencode-local.db");d.run("ALTER TABLE session ADD COLUMN pvc_mode TEXT");d.run("ALTER TABLE session ADD COLUMN app_id TEXT");d.close()'` |
| pg_advisory_lock 启动失败 | 远端 PG 被另一个 opencode 实例占用 | 等另一个实例退出，或停掉远端 SaaS |
| dev server 进程消失 | 容器重启后 sandbox map 清空 | PVC 文件还在，重新发消息启动进程即可 |
| psql 连接报 `role "app" does not exist` | TCP 转发的远端 PG 实例 role 配置与文档记录的 `app` 不一致 | 用 `\du` 查看 PG 实际 role 列表：`PGPASSWORD=xxx psql -h 127.0.0.1 -p 15432 -U postgres -d postgres -c '\du'`。或从 SaaS 容器内查：`docker exec opencode-saas-test env | grep DATABASE_URL` 获取实际连接串 |
| write/edit/bash 工具一直 `running` | 未配置权限，默认 `"ask"` 模式等待确认 | 通过 `PATCH /global/config` 配置权限（会触发实例 dispose，需重建 session），或通过 SSE 监听 `permission.asked` 事件后调用 `POST /session/{SID}/permission/{requestID}` 回复 |
| subagent write/edit 卡在 `running`，主 agent 正常 | **subagent session 继承的权限中 `edit` 默认为 `"ask"`，触发 `permission.asked` 事件发给 subagent sessionID，HTTP API 模式下无人应答**。主 agent 的 write 可能走不同权限路径不触发询问，但 subagent 内部调用 write 时会触发 `edit` 权限请求，反复重试无人应答后永远卡住。 | 通过 `PATCH /global/config` 配置全局权限（必须包含 `edit:allow` 和 `write:allow`，会触发实例 dispose），或在 subagent 创建时显式设置 permission |
| write 写 `/tmp/` 路径触发 `external_directory` 权限 | `/tmp/` 不在项目目录（`/workspace`）下，触发外部目录权限 | 写文件时使用项目目录内的路径，如 `/workspace/test.txt` |
| sandbox 健康检查超时 30s | `OPENCODE_SANDBOX_USE_SERVER_PROXY=true` 时 SDK 健康检查走 Pod 直连 | 属于 SDK 限制，重试通常能成功 |
| Local MCP 启动慢（npx 下载 supergateway） | sandbox 镜像未预装 supergateway，每次 `npx -y` 下载 | **待优化**：sandbox 镜像预装 `npm install -g supergateway`，后续 `connectSandboxLocal` 可去掉 `npx -y` 前缀 |

---

## 七、本地测试环境已知限制与解法

> 以下问题在 **Linux + 远端 PG + 远端 Sandbox API** 环境中不存在，均为 macOS 本地开发环境特有。

### 7.1 macOS Docker 容器 IP 不可达（proxy 502）

**症状**：SaaS 容器用 `OPENCODE_SANDBOX_USE_SERVER_PROXY=true` 时，OpenSandbox server proxy 返回 502。

**根因**：Docker Desktop for Mac 的固有限制——宿主机进程（OpenSandbox server）无法 TCP 路由到 Docker bridge 网络的容器 IP（`172.17.x.x`）。proxy 尝试直接连接容器 IP，失败。

**解法**：不用 proxy 模式。SaaS 容器用 `OPENCODE_SANDBOX_USE_SERVER_PROXY=false`，通过 endpoint rewrite 绕过（见 7.2）。

### 7.2 SaaS 容器无法访问 sandbox endpoint（地址不匹配）

**症状**：`useServerProxy=false` 时 OpenSandbox 返回 endpoint `127.0.0.1:mapped_port/proxy/44772`，但 SaaS 容器内 `127.0.0.1` 指向容器自身。

**根因**：OpenSandbox `direct` ingress 模式做 Docker 端口映射（`-p 0.0.0.0:mapped_port:44772`），返回宿主机视角的 `127.0.0.1:mapped_port`。SaaS 容器需要通过 `host.docker.internal:mapped_port` 才能访问宿主机的映射端口。

**解法**：SaaS 容器启动时设 `-e OPENCODE_SANDBOX_ENDPOINT_REWRITE='127.0.0.1:host.docker.internal'`。代码中的 fetch 拦截会将 endpoint URL 中的 `127.0.0.1` 重写为 `host.docker.internal`。

```bash
docker run -d --name opencode-saas-test \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=false \
  -e OPENCODE_SANDBOX_ENDPOINT_REWRITE='127.0.0.1:host.docker.internal' \
  ...
```

### 7.3 本地 PG 端口转发

**症状**：Docker 容器无法通过 `host.docker.internal:5432` 访问 macOS 上的本地 PG。

**根因**：Homebrew 安装的 PostgreSQL 默认只监听 `127.0.0.1`，Docker 容器通过 `host.docker.internal` 访问的是宿主机的网络接口，不是 localhost。

**解法**：手动 TCP 转发 `0.0.0.0:15432 → 127.0.0.1:5432`，SaaS 容器通过 `host.docker.internal:15432` 访问。

```bash
nohup node -e "
const net = require('net');
net.createServer(c => {
  const r = net.connect(5432, '127.0.0.1');
  c.pipe(r); r.pipe(c);
  c.on('error', () => r.destroy()); r.on('error', () => c.destroy());
}).listen(15432, '0.0.0.0', () => console.log('PG forward ready on :15432'));
" > /tmp/pg-local-forward.log 2>&1 &
```

### 7.4 AI provider API key 无法从 PG credential 加载

**症状**：发送 AI 消息返回 `ProviderModelNotFoundError`。

**根因**：credential 表有 API key（从 `~/.local/share/opencode/auth.json` 导入），但 provider 需要 `ZHIPU_API_KEY` 等环境变量。SaaS 容器内 PG credential → 环境变量的映射链路不完整。

**解法**：容器启动时直接设环境变量。

```bash
docker run -e ZHIPU_API_KEY='your-api-key' ...
```

> 查看已有 credential：`psql postgresql://local@127.0.0.1:15432/opencode -c "SELECT connector_id, active FROM credential WHERE active = true"`

### 7.5 本地 PG 缺 account / auth 数据

**症状**：远端 PG 有 provider 配置、模型列表等历史数据；本地 PG 全空。

**根因**：本地 PG 是全新数据库，远端 PG 有长期积累的 account、auth、模型配置。credential 表数据来自 `legacyImportLayer` 从 `~/.local/share/opencode/auth.json` 导入，但 account / auth 表不会被导入。

**解法**：手动激活 credential（`UPDATE credential SET active = true WHERE connector_id = 'zhipuai'`）+ 设环境变量 API key（见 7.4）。

### 7.6 私有 registry 不可达 + 镜像重建

**症状**：构建 sandbox 镜像时 `FROM registry.shadow-rpa.net/...` 超时失败。

**根因**：内网 registry 需 VPN，当前网络环境无法访问。

**解法**：用 Docker Hub 公共镜像替代。

```bash
cd packages/opencode

# 创建临时 Dockerfile，替换 FROM 行
sed 's|registry.shadow-rpa.net/infra/opensandbox:2026-06-09|opensandbox/code-interpreter:latest|g' docker/Dockerfile > /tmp/Dockerfile.sandbox

docker build -t opencode-opensandbox:local -f /tmp/Dockerfile.sandbox .
```

> 公共镜像 `opensandbox/code-interpreter:latest` 与私有镜像功能一致，但可能缺少 `opencode-lsp-agent` symlink。LSP daemon 启动命令已改为直接 `node /opt/opencode-lsp-daemon/index.js`，不依赖 symlink。

### 7.7 Docker 磁盘空间不足

**症状**：容器启动报 `ENOSPC`。

**根因**：多次构建 SaaS/sandbox 镜像 + sandbox 容器堆积，Docker Desktop 磁盘满。

**解法**：

```bash
# 清理（注意：会删除所有未使用镜像，包括基础镜像！）
docker system prune -af

# 谨慎清理：只删停止的容器和 dangling 镜像
docker container prune
docker image prune -f
```

> ⚠️ `docker system prune -af` 会删除所有未 tag 的镜像。如果基础镜像（如 `opensandbox/code-interpreter`）是从私有 registry 拉取的，prune 后需要重新拉取。

### 7.8 权限 PATCH 导致 session 失效

**症状**：配置权限 `PATCH /global/config` 后，之前创建的 session 返回 404。

**根因**：`PATCH /global/config` 触发实例 dispose + 重新加载，所有 session 失效。

**解法**：调整操作顺序——先配权限，再创建 session。

```bash
# 1. 先配权限
curl -X PATCH "$BASE/global/config" -d '{"permission":{...}}'
sleep 3

# 2. 再创建 session（dispose 后新建）
SID=$(curl -X POST "$BASE/session" -d '{}')
```

### 7.9 LSP 诊断首次返回空

**症状**：首次对 `.ts` 文件调用 diagnostics 或 documentSymbol，返回空结果。等待 5-15 秒后重试才能得到正确结果。

**根因**：`typescript-language-server` 的 `textDocument/didOpen` 是异步通知。TS server 收到通知后需要时间解析文件、构建索引。请求-响应类 API（hover / definition / workspaceSymbol）立即工作；推送类 API（diagnostics / documentSymbol）需要等待索引完成。

**解法**：测试脚本对首次调用加重试（5 秒间隔，最多 3 次）。这不是代码 bug，是 LSP 协议的异步特性。

```javascript
// 重试模式示例
for (let i = 0; i < 3; i++) {
  const result = await callLSP("documentSymbol", { path })
  if (result.symbols?.length > 0) break
  await sleep(5000)
}
```
