# 沙箱命令执行 API（exec / keep-alive）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十九、沙箱命令执行 API（exec / keep-alive）

> 本节验证直接通过 HTTP API 在沙箱中执行命令、设置 keepAlive 的能力。不依赖 AI 模型是否正确传递 `background:true`，可用于程序化控制沙箱。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T19.1 exec API：简单命令执行

```bash
# 先通过 AI 消息创建沙箱（exec 依赖沙箱存在）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo sandbox-ready\"}],\"model\":$MODEL}" > /dev/null

# 使用 exec API 执行命令
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello-from-exec"}' | python3 -m json.tool
```
**期望**：返回 `{id: "...", exitCode: 0, stdout: "hello-from-exec\n", stderr: ""}`

### T19.2 exec API：多行输出与 stderr

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo line1 && echo line2 && echo err >&2"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'stdout: {repr(d.get(\"stdout\",\"\"))}')
print(f'stderr: {repr(d.get(\"stderr\",\"\"))}')
"
```
**期望**：`exitCode: 0`，stdout 含 `line1`、`line2`。**注意**：当前实现 stderr 被合并到 stdout，`stderr` 字段为空。验证 stdout 包含所有输出即可。

### T19.3 exec API：指定工作目录

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"pwd","workingDirectory":"/tmp"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'pwd: {d.get(\"stdout\",\"\").strip()}')
"
```
**期望**：`pwd: /tmp`

### T19.4 exec API：命令执行失败

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"exit 42"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'非0: {d.get(\"exitCode\") != 0}')
"
```
**期望**：`exitCode: 42`，非 0 退出码

### T19.5 exec API：缺少 command 参数

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{}'
echo ""
```
**期望**：`400`

### T19.6 exec API：不存在的 session

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/ses_NOTEXIST/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo test"}'
echo ""
```
**期望**：`404`（session 不存在）。**注意**：实际返回 404 而非 502，因为路由层先匹配到 session 不存在。

### T19.7 exec API：启动 dev server 并设置 keepAlive

```bash
# 创建 Vite 项目（如果不存在）
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: if [ ! -d /workspace/vite-app ]; then npx create-vite@5 /workspace/vite-app --template react-ts --yes && cd /workspace/vite-app && npm install; fi && echo vite-ready\"}],\"model\":$MODEL}" > /dev/null

# 通过 exec API 安装依赖（如果需要）
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npm install 2>&1 | tail -1"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f'npm install: exit={d.get(\"exitCode\")} stdout={d.get(\"stdout\",\"\").strip()[:80]}')
"

# 通过 exec API 设置 keepAlive
curl -s -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | python3 -m json.tool

# 通过 exec API 启动 Vite（前台执行，但 keepAlive 保护沙箱不被销毁）
# 注意：exec 是同步的，启动 dev server 会阻塞直到超时，所以用 nohup 放后台
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && nohup npx vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 & echo $!"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f'Vite PID: {d.get(\"stdout\",\"\").strip()}')
"

sleep 8

# 验证 Vite 运行
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Vite proxy: %{http_code}\n"

# 验证 keepAlive 状态
curl -s "$BASE/session/$SID/keep-alive" | python3 -m json.tool
```
**期望**：
- keep-alive 设置返回 `{keepAlive: true}`
- Vite proxy 返回 HTTP 200
- keep-alive 查询返回 `{keepAlive: true}`

### T19.8 keepAlive 阻止 idle 销毁（纯 API 方式）

```bash
# 创建新 session
SID2=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 先用 AI 消息创建沙箱
curl -s --max-time 60 -X POST "$BASE/session/$SID2/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo ready\"}],\"model\":$MODEL}" > /dev/null

# 通过 API 设置 keepAlive
curl -s -X POST "$BASE/session/$SID2/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null

# 等待 idle 触发
sleep 15

# 检查：sandbox 应仍然存活（不被销毁）
RESULT=$(curl -s --max-time 10 -X POST "$BASE/session/$SID2/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo alive"}')
echo "After idle + keepAlive: $RESULT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode={d.get(\"exitCode\")} stdout={d.get(\"stdout\",\"\").strip()}')
print(f'PASS: sandbox still alive = {d.get(\"exitCode\")==0}')
"
```
**期望**：`sandbox still alive = True`，证明 keepAlive 阻止了 idle 销毁

### T19.9 释放 keepAlive 后 idle 销毁

```bash
SID3=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建沙箱
curl -s --max-time 60 -X POST "$BASE/session/$SID3/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo ready\"}],\"model\":$MODEL}" > /dev/null

# 设置 keepAlive
curl -s -X POST "$BASE/session/$SID3/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null

# 确认存活
sleep 5
curl -s -X POST "$BASE/session/$SID3/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo alive"}' | python3 -c "import json,sys;print('alive:', json.load(sys.stdin).get('exitCode')==0)"

# 释放 keepAlive
curl -s -X POST "$BASE/session/$SID3/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | python3 -c "import json,sys;print(json.load(sys.stdin))"

# 等待 idle + destroy
sleep 15

# 检查：sandbox 应已被销毁
curl -s --max-time 10 -X POST "$BASE/session/$SID3/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo dead"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'After release: exitCode={d.get(\"exitCode\")} error={d.get(\"error\")}')
"
```
**期望**：释放 keepAlive 后，sandbox 被 idle 回收，exec 返回 502 或执行失败

### T19.10 exec API：超时控制

```bash
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 30 && echo done","timeoutSeconds":5}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'has error: {bool(d.get(\"error\"))}')
"
```
**期望**：命令在 5 秒后被终止，返回非 0 exitCode 或 error

### T19.11 exec API：环境信息收集

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo \"node=$(node -v) npm=$(npm -v) pwd=$(pwd)\""}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('stdout','').strip())
"
```
**期望**：输出包含 node 版本、npm 版本和当前工作目录

---

### API 接口详情

#### `POST /session/:sessionID/exec`

在沙箱中执行命令。沙箱不存在时自动创建（首次 AI 消息后）。

**请求体**：
```json
{
  "command": "echo hello",
  "workingDirectory": "/workspace",  // 可选，默认 /workspace
  "timeoutSeconds": 30               // 可选，默认不限
}
```

**响应**：
```json
{
  "id": "exec-xxx",
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": "",
  "error": null  // 或 {"name":"...","value":"...","traceback":[...]}
}
```

#### `POST /session/:sessionID/keep-alive`

设置或释放 keepAlive。keepAlive=true 时，sandbox 在 session idle 后不会被自动销毁。

**请求体**：
```json
{"enabled": true}   // 设置 keepAlive
{"enabled": false}  // 释放 keepAlive
```

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true}
```

#### `GET /session/:sessionID/keep-alive`

查询 keepAlive 状态。

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true}
```

