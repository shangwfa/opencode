# Cloud Browser 启动指南

## 前置依赖

| 依赖 | 说明 | 验证 |
|---|---|---|
| Node.js + npm | 前端与 Vite 插件后端 | `node -v` |
| Docker | 运行 Chrome 沙箱镜像（OrbStack/Docker Desktop 均可） | `docker ps` |
| opencode SaaS 服务 | Agent 的 LLM 会话引擎，默认 `http://localhost:14096`（`OPENCODE_SAAS_BASE_URL` 可覆盖） | `curl -s --noproxy '*' http://localhost:14096/session \| head -c 100` |
| OpenSandbox | AI 沙箱编排，默认 `localhost:30040`（`OPENCODE_SANDBOX_DOMAIN` 可覆盖） | `lsof -iTCP:30040 -sTCP:LISTEN` |

## 启动步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 构建 Chrome 沙箱镜像（首次必做）

Chrome 沙箱镜像 `cloud-browser/chrome-novnc` **不在远程仓库，必须本地构建**。缺失时创建浏览器沙箱会报：

```
pull access denied for cloud-browser/chrome-novnc, repository does not exist
```

构建（约 3-5 分钟）：

```bash
npm run image:build
# 等价于 docker build -t cloud-browser/chrome-novnc:latest docker/chrome-novnc
```

### 3. 确定 Agent API 基址（关键！）

Vite 插件会把「浏览器控制 API 基址」写进注册给 Agent 的 skill。**AI 沙箱容器内必须能访问该地址**，且 skill 内容在创建 Agent 时固化，端口漂移会导致 Agent 无法操作浏览器。

规则：

- **默认 `http://host.docker.internal:5173`**。若你的容器运行环境支持解析 `host.docker.internal` 且 5173 端口空闲，可直接启动
- **本机 OpenSandbox 场景实测 `host.docker.internal` 不可解析**。需改用宿主机 en0 IP，并固定端口：

```bash
# 获取宿主机 IP（AI 沙箱内可达的那个，一般是 en0）
ipconfig getifaddr en0        # 例如 172.16.29.75

# 用固定端口 + 显式 API 基址启动
CLOUD_BROWSER_API_BASE=http://<en0-IP>:5175 \
  npm run dev -- --host 0.0.0.0 --port 5175 --strictPort
```

注意事项：

- `--host 0.0.0.0` 必加：默认只监听 localhost，容器内无法访问
- `--strictPort` 必加：防止端口被占用后漂移到其他端口，导致 skill 里写死的基址失效
- 验证 AI 沙箱可达性（任一已有 session）：

```bash
curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/<session-id>/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"curl -s --noproxy \"*\" -o /dev/null -w \"%{http_code}\" --max-time 5 http://<API基址>/api/agents"}'
```

### 4. 访问

打开 Vite 输出的地址（如 `http://localhost:5175/`）。

## 模型选择（重要）

**必须选 `Yd-*` 系列 provider**（`Yd-DeepSeek` / `Yd-KiMi` / `Yd-GLM`，key 内嵌在 SaaS 配置中）。默认选中 `Yd-KiMi/kimi-k3`。

- 若选择 `deepseek` / `moonshotai-cn` 等官方 provider 且本机无有效 key，LLM 会静默 401 失败：Agent 无任何输出，UI 反复出现 "A sandbox command failed in /workspace" repair 循环
- 排查方法：查 PG `message` 表 assistant 消息的 `error` 字段，或按 `docs/test-cases/guides/session-diagnostic-guide.md`（主仓库）诊断

## 常见问题

### `pull access denied for cloud-browser/chrome-novnc`

未构建沙箱镜像，见步骤 2。

### Agent 无输出 / repair 死循环 "Sandbox execution failed"

两种可能：

1. **模型 401**（最常见）：选错了 provider，见上节
2. **AI 沙箱空闲回收窗口**：OpenSandbox 空闲约 30s 回收沙箱，`listAgentFiles` 等 exec 调用撞上回收/重建期会得到 HTTP 502，属瞬时错误，稍后重试即可恢复

### 本机 curl 调试返回 502 / 000

本机 shell 配置了 HTTP 代理（`http_proxy=127.0.0.1:7897` 等）会拦截 localhost 请求。curl 一律加 `--noproxy '*'`。

### 5173 被占用

不要让端口漂移，直接换一个固定端口（如 5175），并同步设置 `CLOUD_BROWSER_API_BASE`，见步骤 3。

## 相关文档

- [architecture.md](./architecture.md)：整体架构设计
- 主仓库 `docs/local-test-env.md`：SaaS 服务与 OpenSandbox 本地环境搭建
