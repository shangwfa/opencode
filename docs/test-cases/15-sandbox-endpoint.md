# Sandbox Endpoint API（沙箱直连访问）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十七、Sandbox Endpoint API（沙箱直连访问）

> 前置条件：同第十一节。本节验证 `GET /session/:sessionID/endpoint/:port` 直连 API，返回沙箱 Pod IP 供浏览器直连访问。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T17.1 无沙箱时 endpoint API 返回 502

```bash
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -m json.tool
```
**期望**：`{"error": "sandbox unreachable"}`，HTTP 502（沙箱尚未创建）

### T17.2 端口参数校验

```bash
curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID/endpoint/0"
echo ""
curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID/endpoint/99999"
echo ""
curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID/endpoint/abc"
```
**期望**：三个请求均返回 `400`

### T17.3 创建 Vite 项目并验证 endpoint API 返回直连 IP

```bash
# Step 1: 创建项目 + 安装依赖
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: mkdir -p /workspace/vite-app/src && cd /workspace/vite-app && npm init -y && npm install react react-dom && npm install -D vite @vitejs/plugin-react typescript\"}],\"model\":$MODEL}" > /dev/null

# Step 2: 创建项目文件
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"在 /workspace/vite-app 下创建6个文件：vite.config.ts、index.html、src/main.tsx、src/App.tsx（用 import { useState } from 'react'）、tsconfig.json、src/vite-env.d.ts\"}],\"model\":$MODEL}" > /dev/null

# Step 3: 验证工具调用过程
echo "=== 验证工具调用过程 ==="
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for i, m in enumerate(msgs):
    tools = [p.get('tool','') for p in m.get('parts',[]) if p.get('type')=='tool']
    if tools:
        print(f'  🔧 [{i}] {tools}')
"

# Step 4: 启动 Vite（background:true）
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173\"}],\"model\":$MODEL}" > /dev/null
sleep 12

# Step 5: Proxy 验证
echo "=== Proxy 验证 ==="
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Proxy: HTTP %{http_code}\n"

# Step 6: Endpoint API 验证
echo "=== Endpoint API ==="
ENDPOINT=$(curl -s "$BASE/session/$SID/endpoint/5173")
echo "$ENDPOINT" | python3 -m json.tool

# Step 7: 验证返回结构
echo "$ENDPOINT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('mode') in ('direct','proxy'), f'mode 异常: {d.get(\"mode\")}'
assert d.get('url'), 'url 缺失'
assert d.get('port') == 5173, f'port 异常: {d.get(\"port\")}'
assert d.get('sandboxId'), 'sandboxId 缺失'
assert d.get('fallback','').startswith('/session/'), f'fallback 异常: {d.get(\"fallback\")}'
print('✅ 返回结构验证通过')
print(f'  mode={d[\"mode\"]} url={d[\"url\"]} sandboxId={d[\"sandboxId\"][:12]}...')
"
```
**期望**：
- Proxy 返回 HTTP 200
- Endpoint API 返回 JSON，包含 `mode`、`url`（沙箱 IP）、`port`、`sandboxId`、`fallback`
- `mode=direct` 时 `url` 为沙箱 Pod IP（如 `http://10.12.11.x:5173`）

### T17.4 通过直连 IP 访问 Vite 页面

```bash
# 获取直连 URL
URL=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")
echo "Direct URL: $URL"

# 直连访问
curl -s --max-time 10 "$URL/" -o /dev/null -w "Direct: HTTP %{http_code}\n"

# 验证内容
curl -s --max-time 10 "$URL/" | python3 -c "
import sys
html = sys.stdin.read()
print(f'  body.length={len(html)}')
print(f'  has Vite: {\"vite\" in html.lower()}')
print(f'  has module: {\"type=\\\"module\\\"\" in html}')
# 直连模式没有 proxy prefix 注入
print(f'  无 proxy 注入: {\"data-oc-prefix\" not in html}')
"
```
**期望**：
- 直连 HTTP 200
- HTML 包含 Vite 标识
- 直连模式下没有 proxy prefix 注入（与 proxy 模式的 key 区别）

### T17.5 Proxy 与直连模式对比

```bash
URL=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")

echo "=== Proxy 模式 ==="
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys; html=sys.stdin.read()
print(f'  长度: {len(html)}')
print(f'  有 prefix 注入: {\"data-oc-prefix\" in html}')
print(f'  有 fetch patch: {\"window.fetch=function\" in html}')
print(f'  有 WebSocket patch: {\"window.WebSocket=function\" in html}')
"

echo "=== 直连模式 ==="
curl -s --max-time 10 "$URL/" | python3 -c "
import sys; html=sys.stdin.read()
print(f'  长度: {len(html)}')
print(f'  无 prefix 注入: {\"data-oc-prefix\" not in html}')
print(f'  无 fetch patch: {\"window.fetch=function\" not in html}')
print(f'  原始 Vite 输出: {\"@vite/client\" in html}')
"
```
**期望**：
- Proxy 模式：有 prefix 注入、fetch/WebSocket patch、路径重写
- 直连模式：没有任何注入，是原始 Vite 输出

### T17.6 沙箱销毁后 endpoint API 返回 502

```bash
# 方式一：kill-sandbox（DB state running→destroyed）
curl -s -X POST "$BASE/session/$SID/kill-sandbox" > /dev/null
sleep 2
docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c \
  "SELECT state FROM sandbox WHERE session_id='$SID';"
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -m json.tool

# 方式二：instance/dispose（彻底清理实例状态）
curl -s -X POST "$BASE/instance/dispose" > /dev/null
sleep 3
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -m json.tool
```
**期望**：`{"error": "sandbox unreachable"}`，沙箱销毁后 endpoint 不可用

> **注意**：若 async exec 启动的 dev server 进程仍在运行，kill-sandbox 后可能被 reconnect 拉活导致 endpoint 偶发仍返回 IP。生产场景下应先 kill async exec 再 kill-sandbox，或直接用 instance/dispose。

---

## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T17.1 | ✅ | 无沙箱 endpoint 502 + sandbox unreachable |
| T17.2 | ✅ | port=0/99999/abc 均返回 400 |
| T17.3 | ✅ | mode=direct, url=http://10.12.11.190:8080, 结构验证通过（mode/url/port/sandboxId/fallback） |
| T17.4 | ✅ | 直连 200, body=143 chars, 无 proxy 注入（data-oc-prefix 不存在） |
| T17.5 | ✅ | Proxy 长度 3021 + prefix 注入 + fetch patch；直连 143 + 无注入 |
| T17.6 | ✅ | kill-sandbox→state=空→endpoint 返回 sandbox unreachable |

