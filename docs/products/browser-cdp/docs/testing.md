# 测试手册

> browser-cdp 功能的分层验证手册：镜像级（容器内 e2e）、集成级（SaaS 链路 curl）、
> UI 级（测试台画面与控制）。全部步骤在组合 3（本地 PG + 本地 OpenSandbox）实测通过，
> 组合 1/2 仅 endpoint 地址形态不同（host-ip 接口返回 pod IP）。

## 0. 前置

```bash
# 1. 构建沙箱镜像（上下文 packages/opencode，改动 cdp-browser 后需重建）
cd packages/opencode
docker build -t opencode-saas-browser-cdp:test -f docker/browser-cdp/Dockerfile .

# 2. 本地环境就绪（组合 3，见 docs/local-test-env.md）
#    本地 PG :5432 → 转发 :15432；OpenSandbox server :8080；SaaS server
#    含 host-ip 新接口的 server 二选一：
#    a) 宿主机直跑（开发迭代，改代码即时生效）：
cd packages/opencode
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
#    b) 容器形态 :14096 —— 镜像需已重建（含 host-ip）

# 3. 测试台
cd docs/products/browser-cdp
npm install
OPENCODE_SAAS_BASE_URL=http://localhost:14097 npm run dev   # :5174

export BASE=http://localhost:14097
```

> 所有 curl 加 `--noproxy '*'`（本机代理会拦截 localhost 请求，见 local-test-env 常见问题）。

## 1. 镜像级验证（不依赖 SaaS）

```bash
# 起容器 + 拉起浏览器
docker run -d --name cdp-verify --entrypoint sleep -p 9222:9222 opencode-saas-browser-cdp:test infinity
docker exec cdp-verify /opt/cdp-browser/cdp-browser.sh start    # 幂等，重复执行应提示 already running
docker exec cdp-verify /opt/cdp-browser/cdp-browser.sh status   # chromium/gateway 均 running

# CDP 透出（宿主机直连）
curl -s http://127.0.0.1:9222/json/version | grep -E 'Browser|webSocketDebuggerUrl'
# 期望：webSocketDebuggerUrl = ws://127.0.0.1:9222/...（网关已重写，非 :9221）

# Host 校验绕过（伪造 proxy 域名 + https）
curl -s -H "Host: test-opencode.shadow-rpa.net" -H "x-forwarded-proto: https" \
  http://127.0.0.1:9222/json/version | grep webSocketDebuggerUrl
# 期望：wss://test-opencode.shadow-rpa.net/devtools/browser/...

# 实时画面页
open http://127.0.0.1:9222/viewer    # 画面 + 工具栏 + 输入回传

# 外部控制（镜像内置 agent-browser 复用常驻浏览器）
docker exec cdp-verify agent-browser --cdp 9222 open https://example.com
docker exec cdp-verify agent-browser --cdp 9222 snapshot | head -3

docker rm -f cdp-verify   # 清理
```

## 2. 集成级验证（SaaS 会话链路）

```bash
# 1. 会话级指定镜像创建（cpu/memory 必填）
SID=$(curl -s --noproxy '*' -X POST $BASE/session -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"1","memory":"2Gi","image":"opencode-saas-browser-cdp:test"}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID=$SID"

# 2. boot：立即创建沙箱
curl -s --noproxy '*' --max-time 180 -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}'
# 期望：{"keepAlive":true,"sandboxId":"..."}

# 3. 拉起常驻浏览器
curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"/opt/cdp-browser/cdp-browser.sh start"}'
# 期望：exitCode 0，stdout 含 "chromium up" 与 "gateway up"

# 4. host-ip 新接口（WS 直连地址来源）
curl -s --noproxy '*' "$BASE/session/$SID/host-ip"
# 期望：{"ip":"192.168.x.x","ips":[...],"sandboxId":"..."}（K8s 下为 pod IP）

# 5. CDP 经 SaaS proxy 可达（HTTP 面确认）
curl -s --noproxy '*' "$BASE/session/$SID/proxy/9222/json/version" | head -c 120
```

WS 直连验证（host-ip 地址，最关键——ingress/sandbox-proxy 的 WS 会挂起）：

```bash
IP=$(curl -s --noproxy '*' "$BASE/session/$SID/host-ip" | python3 -c "import json,sys;print(json.load(sys.stdin)['ip'])")
TID=$(curl -s --noproxy '*' "http://$IP:9222/json/list" | python3 -c "
import json,sys;print([t for t in json.load(sys.stdin) if t['type']=='page'][0]['id'])")
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://$IP:9222/devtools/page/$TID');
ws.on('open', () => ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'1+1'}})));
ws.on('message', (d) => { console.log('WS OK:', d.toString().slice(0,80)); process.exit(0) });
ws.on('error', (e) => { console.log('WS FAIL:', e.message); process.exit(1) });
setTimeout(() => { console.log('WS TIMEOUT'); process.exit(1) }, 8000);
"
# 期望：WS OK: {"id":1,"result":{"result":{"type":"number","value":2,...
```

## 3. UI 级验证（测试台）

```bash
# 打开测试台，浏览器需 bypass 本地代理（否则 WS 被代理拦截挂起）
agent-browser close --all
agent-browser --proxy-bypass "localhost,127.0.0.1" open http://localhost:5174
```

| # | 操作 | 期望 |
|---|---|---|
| 1 | 顶部「新建会话」（镜像框默认 opencode-saas-browser-cdp:test） | 1-2 分钟后消息「会话就绪，浏览器已启动」，`CDP: 就绪` |
| 2 | 下拉选择会话 | Viewer 出现，状态点绿色，画面渲染 about:blank |
| 3 | 「新标签」 | target 切到 about:blank 新页 |
| 4 | 地址栏输入 `example.com` → 打开 | 画面实时渲染 example.com；`curl $BASE/session/$SID/json/list` 确认沙箱侧 url |
| 5 | 画面上点击/滚动/键盘输入 | 沙箱浏览器同步响应，画面持续更新（帧计数增长） |
| 6 | 「启动浏览器」（手动 stop 后）/「停止」/「销毁沙箱」 | 对应 exec start / stop / kill-sandbox 生效，CDP 状态随之变化 |

判定画面链路健康的快速探针（浏览器 console）：

```js
const img = document.querySelector("img")
img ? `${img.width}x${img.height} 有帧` : "无帧"
```

## 4. 验证矩阵（本轮实测 2026-08-28）

| 层 | 用例 | 结果 |
|---|---|---|
| 镜像 | gateway 就绪 / URL 重写 / 伪造 Host 200 / wss 重写 / browser WS / page screencast 帧 / viewer 页 / 启停幂等 | 8/8 PASS |
| 集成 | 指定镜像建会话 → boot → exec → proxy 9222 HTTP | PASS |
| 集成 | host-ip 接口返回裸 IP；裸 IP:9222 WS CDP 命令往返 | PASS |
| UI | 画面渲染 / 地址栏导航 / 点击控制 / target 同步 | PASS |

## 5. 故障速查

| 症状 | 原因 | 处理 |
|---|---|---|
| exec start 报 `CDP_ARGS: unbound variable` | 沙箱内是旧镜像脚本 | 重建镜像 + `kill-sandbox` 后重新 boot |
| WS OPEN 但无消息 | 代理握手竞态丢消息 / 目标页面无内容 | 确认插件为带 pending 缓冲版本；导航到有内容的页面 |
| 浏览器 WS 永远 CONNECTING | 系统代理拦截，或 vite 单栈监听 | `--proxy-bypass` 重启浏览器；vite `server.host: true` |
| 浏览器 ws://127.0.0.1:5174 秒断 1006 | vite 只绑 ::1 | 同上（双栈） |
| host-ip 返回 `working directory does not exist` | runInSession 默认目录为宿主机路径 | 已修复（`/tmp`），确认 server 代码为新版 |
| 画面持续「等待画面…」状态点琥珀色 | hook URL 拼接错误（`ws//`）或 upstream 未就绪 | 已修复；查测试台 dev log `[cdp] upstream` 是否解析成功 |
| 会话下拉里找不到刚建的会话 | server 视角按 project 隔离，或列表截断 | 在同一 server 上闭环创建；插件已按 updated 排序 |
