# 本地测试环境指南

本地运行 opencode SaaS 容器，连接远端基础设施（PG + Sandbox API），用于开发调试。

也可以只连接远端 PG，使用本机 OpenSandbox server + Docker runtime 创建 sandbox 容器，避免依赖远端 K8s Sandbox API。

---

## 一、基础设施架构

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

本地 OpenSandbox 模式：

```
本机（macOS）
  ├─ Docker 容器 opencode-saas-test（localhost:14096）
  │    ├─ 通过 host.docker.internal:15432 → 宿主机转发 → 172.18.32.14:5432（远端 PG）
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

### 2.1 构建镜像

```bash
cd /Users/ruomu/code/opencode
docker build -t opencode-saas-sandbox-test:v2fix -f Dockerfile .
```

> 代码有改动时才需要重新构建。

### 2.1.1 构建本地 OpenSandbox sandbox 镜像（可选）

如果要使用本地 OpenSandbox server + Docker runtime，不走远端 K8s Sandbox API，需要先构建 OpenSandbox 使用的 sandbox 镜像。

> 注意区分两个 Dockerfile：
> - 根目录 `Dockerfile`：opencode SaaS 服务容器。
> - `packages/opencode/docker/Dockerfile`：OpenSandbox sandbox 镜像，基于 `opensandbox/code-interpreter:latest`，内置 `opencode` 二进制和 `ripgrep`。

```bash
cd /Users/ruomu/code/opencode/packages/opencode

# 先生成 Dockerfile 需要复制的 opencode 二进制。
# 如果已经有 dist/opencode-linux-arm64/bin/opencode，可跳过。
bun run script/build.ts --skip-install --skip-embed-web-ui

# 本地 macOS Apple Silicon 用 arm64。
docker buildx build --platform linux/arm64 \
  -t opencode-opensandbox:local \
  --load .

# 验证镜像继承了 code-interpreter 入口，且 opencode/rg 可用。
docker image inspect opencode-opensandbox:local \
  --format 'entrypoint={{json .Config.Entrypoint}} workdir={{json .Config.WorkingDir}}'

docker run --rm --entrypoint /bin/bash opencode-opensandbox:local -lc \
  'opencode --version && rg --version | head -1 && node --version && python3 --version'
```

期望：
- `entrypoint=["/opt/opensandbox/code-interpreter.sh"]`
- `workdir=/workspace`
- `opencode --version` 正常输出
- `ripgrep 14.1.0` 或兼容版本正常输出

> 不要在 `packages/opencode/docker/Dockerfile` 里设置 `ENTRYPOINT ["opencode"]`。OpenSandbox 需要继承 `code-interpreter` 的入口脚本以便注入并启动 execd；覆盖入口会导致 `commands.run()` 返回 502。

### 2.2 确认远端连通性

```bash
# 从宿主机验证远端 PG 可达
timeout 3 nc -z 172.18.32.14 5432 && echo "PG OK" || echo "PG unreachable"

# 从宿主机验证远端 Sandbox API 可达
timeout 3 nc -z 172.18.32.15 30040 && echo "Sandbox API OK" || echo "Sandbox API unreachable"
```

---

## 三、每次测试启动流程

### Step 1：启动 TCP 转发

> 每次开机或转发进程死掉后需要重新执行。

```bash
# 检查是否已在运行
lsof -i :15432 | grep LISTEN && echo "PG forward running" || echo "PG forward NOT running"
lsof -i :30040 | grep LISTEN && echo "Sandbox forward running" || echo "Sandbox forward NOT running"

# 启动 PG 转发（15432 → 172.18.32.14:5432）
nohup node -e "
const net = require('net');
net.createServer(c => {
  const r = net.connect(5432, '172.18.32.14');
  c.pipe(r); r.pipe(c);
  c.on('error', () => r.destroy()); r.on('error', () => c.destroy());
}).listen(15432, '0.0.0.0', () => console.log('PG forward ready on :15432'));
" > /tmp/pg-forward.log 2>&1 &

# 启动 Sandbox API 转发（30040 → 172.18.32.15:30040）
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

### Step 1.5：启动本地 OpenSandbox server（可选）

如果使用远端 Sandbox API，可跳过本节，继续使用 `localhost:30040` 转发。

本地 OpenSandbox server 读取 `~/.sandbox.toml`，使用 Docker runtime 创建 sandbox 容器。

```bash
# 确保 Docker Desktop 已启动
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

本地 OpenSandbox server 验证 sandbox 镜像：

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

如果这里返回 502，优先检查：
- `docker image inspect opencode-opensandbox:local` 的 entrypoint 是否为 `/opt/opensandbox/code-interpreter.sh`
- sandbox 容器内 `/tmp/execd.log`
- `/tmp/opensandbox-server.log`
- 本地是否误用了 amd64 镜像导致 QEMU 下 execd 崩溃

### Step 2：启动容器

```bash
docker rm -f opencode-saas-test 2>/dev/null

docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://app:8zuhlMLd4gaeUG5k@host.docker.internal:15432/opencode \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:30040 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  opencode-saas-sandbox-test:v2fix

# 等待启动
sleep 10 && docker logs opencode-saas-test 2>&1 | tail -3
# 期望：Warning: OPENCODE_SERVER_PASSWORD is not set
#        opencode server listening on http://0.0.0.0:4096
```

如果使用本地 OpenSandbox server，改用：

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

本地 OpenSandbox Docker runtime 场景下：
- `OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080`，因为 SaaS 容器需要从容器内访问宿主机 OpenSandbox server。
- `OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local`，指定本地构建的 sandbox 镜像。
- `OPENCODE_SANDBOX_USE_SERVER_PROXY=true`，因为 SDK 在 SaaS 容器内运行，不能直接访问 OpenSandbox server 返回的宿主机本地 Docker endpoint，必须通过 OpenSandbox server proxy 转发到 execd。

> 当前本地 Docker runtime 的稳定回归路径是：在宿主机直接启动 opencode server，使用 `OPENCODE_SANDBOX_DOMAIN=127.0.0.1:8080` 和 `OPENCODE_SANDBOX_USE_SERVER_PROXY=false`。SaaS server 跑在 Docker 容器内时，`useServerProxy=false` 无法访问宿主机 Docker 暴露的 direct endpoint；`useServerProxy=true` 又依赖 OpenSandbox server proxy 转发，遇到 502 时应先改用宿主机 server 路径验证工具链，再单独排查 OpenSandbox proxy。

宿主机 server 示例：

```bash
cd /Users/ruomu/code/opencode/packages/opencode

env \
  OPENCODE_DATABASE_URL='postgresql://app:8zuhlMLd4gaeUG5k@127.0.0.1:15432/opencode' \
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

### Step 3：验证服务可用

```bash
# 服务健康
curl -s http://localhost:14096/ -o /dev/null -w "HTTP %{http_code}\n"  # 期望 200

# 创建 session
SID=$(curl -s -X POST http://localhost:14096/session \
  -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 验证 AI provider（期望看到 AI 文字回复）
curl -s --max-time 30 -X POST "http://localhost:14096/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:100])
"
```

### Step 3.5：配置权限（必须）

> ⚠️ **如果不配置权限，所有工具调用（write/edit/bash 等）都会卡在权限等待状态**（默认 `"ask"`），HTTP API 模式下没有 UI 回复权限请求，工具永远 `running`。

```bash
# 通过全局 config API 配置权限（触发实例 dispose + 重新加载）
curl -s -X PATCH http://localhost:14096/global/config \
  -H 'Content-Type: application/json' \
  -d '{"permission":{"bash":"allow","edit":"allow","write":"allow","glob":"allow","grep":"allow","list":"allow","read":"allow","webfetch":"allow"}}' \
  | python3 -c "import json,sys;c=json.load(sys.stdin);print('permission:',json.dumps(c.get('permission')))"

# 验证配置生效
sleep 2
curl -s http://localhost:14096/config | python3 -c "import json,sys;c=json.load(sys.stdin);print(c.get('permission'))"
# 期望：{'read': 'allow', 'edit': 'allow', ...}
```

> 注意：`PATCH /global/config` 会触发实例 dispose，之前的 session 会失效。需要重新创建 session。

### Step 4：在沙箱中启动 dev server

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

### Step 5：浏览器验证

```
Vite (proxy):    http://localhost:14096/session/{SID}/proxy/5173/
Next.js (proxy): http://localhost:14096/session/{SID}/proxy/3000/
```

### Step 6：Endpoint API 验证（直连模式）

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

### Step 7：验证工具调用过程

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

### Step 8：使用 exec API 程序化控制沙箱

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
- keep-alive 返回 `{keepAlive: true}`
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

POST /session/:sessionID/exec {"command":"nohup npx vite ... &"}
  → 直接在沙箱中执行命令，启动 dev server 等
  → 配合 keepAlive 保证沙箱不被回收
```

> 方式二不依赖 AI 模型是否正确传递 `background:true`，更适合自动化测试和程序化控制。

---

## 六、常见问题

| 症状 | 原因 | 解决 |
|---|---|---|
| 502 sandbox unreachable | sandbox 被回收（没有 keepAlive）| 重新发消息用 `background:true` 启动 dev server |
| 502 "All connection attempts failed" | TCP 转发进程死了 | 重新执行 Step 1 |
| 404 from sandbox server proxy | `OPENCODE_SANDBOX_USE_SERVER_PROXY` 未设置 | 重新启动容器加 `-e OPENCODE_SANDBOX_USE_SERVER_PROXY=true` |
| 本地 OpenSandbox `commands.run()` 502 | sandbox 镜像覆盖了 `code-interpreter` entrypoint，或 execd 崩溃 | 确认 sandbox 镜像继承 `/opt/opensandbox/code-interpreter.sh`，不要设置 `ENTRYPOINT ["opencode"]` |
| 本地 arm64 上 execd 崩溃 | 使用了 amd64 镜像，Docker 通过 QEMU 运行 | 用 `docker buildx build --platform linux/arm64 --load` 构建本地镜像 |
| opencode 二进制 `required file not found` | Ubuntu/glibc 基础镜像复制了 `*-musl` 二进制 | `packages/opencode/docker/Dockerfile` 应复制 `dist/opencode-linux-arm64/bin/opencode` 或 `dist/opencode-linux-x64-baseline/bin/opencode` |
| 本地 OpenSandbox 找不到镜像 | SaaS 容器指定的 image 名称不是 Docker daemon 中的本地镜像名 | 先 `docker images | grep opencode-opensandbox`，并设置 `OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local` |
| 401 MISSING_API_KEY | proxy fetch 未带 API key | 检查代码是否有 `Flag.OPENCODE_SANDBOX_API_KEY` header 注入 |
| ProviderModelNotFoundError | AI provider 未配置 | 确认容器连的是远端 PG（含 account 数据） |
| pg_advisory_lock 启动失败 | 远端 PG 被另一个 opencode 实例占用 | 等另一个实例退出，或停掉远端 SaaS |
| dev server 进程消失 | 容器重启后 sandbox map 清空 | PVC 文件还在，重新发消息启动进程即可 |
| write/edit/bash 工具一直 `running` | 未配置权限，默认 `"ask"` 模式等待确认 | 执行 Step 3.5 配置权限，或通过 SSE 监听 `permission.asked` 事件后调用 `POST /session/{SID}/permission/{requestID}` 回复 |
| subagent write/edit 卡在 `running`，主 agent 正常 | **subagent session 继承的权限中 `edit` 默认为 `"ask"`，触发 `permission.asked` 事件发给 subagent sessionID，HTTP API 模式下无人应答**。主 agent 的 write 可能走不同权限路径不触发询问，但 subagent 内部调用 write 时会触发 `edit` 权限请求，反复重试无人应答后永远卡住。 | 执行 Step 3.5 配置全局权限（必须包含 `edit:allow` 和 `write:allow`），或在 subagent 创建时显式设置 permission |
| write 写 `/tmp/` 路径触发 `external_directory` 权限 | `/tmp/` 不在项目目录（`/workspace`）下，触发外部目录权限 | 写文件时使用项目目录内的路径，如 `/workspace/test.txt` |
| sandbox 健康检查超时 30s | `OPENCODE_SANDBOX_USE_SERVER_PROXY=true` 时 SDK 健康检查走 Pod 直连 | 属于 SDK 限制，重试通常能成功 |
| Local MCP 启动慢（npx 下载 supergateway） | sandbox 镜像未预装 supergateway，每次 `npx -y` 下载 | **待优化**：sandbox 镜像预装 `npm install -g supergateway`，后续 `connectSandboxLocal` 可去掉 `npx -y` 前缀 |
