# 本地测试环境指南

本地运行 opencode SaaS 容器，连接远端基础设施（PG + Sandbox API），用于开发调试。

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

| 组件 | 地址 | 说明 |
|---|---|---|
| opencode 容器 | `localhost:14096` | 映射容器内 4096 端口 |
| 远端 PG | `172.18.32.14:5432` | 含 AI provider key、session 数据 |
| 远端 Sandbox API | `172.18.32.15:30040` | K8s 沙箱管理服务 |
| PG 本地转发 | `localhost:15432` | 容器通过 host.docker.internal:15432 访问 |
| Sandbox 本地转发 | `localhost:30040` | 容器通过 host.docker.internal:30040 访问 |

---

## 二、首次准备

### 2.1 构建镜像

```bash
cd /Users/ruomu/code/opencode
docker build -t opencode-saas-sandbox-test:v2fix -f Dockerfile .
```

> 代码有改动时才需要重新构建。

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
Vite:    http://localhost:14096/session/{SID}/proxy/5173/
Next.js: http://localhost:14096/session/{SID}/proxy/3000/
```

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

```
bash.ts (background:true)
  → 命令执行完后调用 sandboxProvider.keepAlive(sessionID)
    → leases.add(sessionID)
    → run-state.ts onIdle 时检查 isKeepAlive
      → true：跳过销毁，sandbox 保持
      → false：destroy(sessionID)，sandbox 立即销毁
```

> `OPENCODE_SANDBOX_IDLE_KILL_SEC=30` 在 opencode 代码中**未被使用**，回收完全由 `onIdle` 回调控制。

---

## 六、常见问题

| 症状 | 原因 | 解决 |
|---|---|---|
| 502 sandbox unreachable | sandbox 被回收（没有 keepAlive）| 重新发消息用 `background:true` 启动 dev server |
| 502 "All connection attempts failed" | TCP 转发进程死了 | 重新执行 Step 1 |
| 404 from sandbox server proxy | `OPENCODE_SANDBOX_USE_SERVER_PROXY` 未设置 | 重新启动容器加 `-e OPENCODE_SANDBOX_USE_SERVER_PROXY=true` |
| 401 MISSING_API_KEY | proxy fetch 未带 API key | 检查代码是否有 `Flag.OPENCODE_SANDBOX_API_KEY` header 注入 |
| ProviderModelNotFoundError | AI provider 未配置 | 确认容器连的是远端 PG（含 account 数据） |
| pg_advisory_lock 启动失败 | 远端 PG 被另一个 opencode 实例占用 | 等另一个实例退出，或停掉远端 SaaS |
| dev server 进程消失 | 容器重启后 sandbox map 清空 | PVC 文件还在，重新发消息启动进程即可 |
| sandbox 健康检查超时 30s | `OPENCODE_SANDBOX_USE_SERVER_PROXY=true` 时 SDK 健康检查走 Pod 直连 | 属于 SDK 限制，重试通常能成功 |
