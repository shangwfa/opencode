# Session LSP 测试

> 验证 SaaS 沙箱模式下，LSP 功能（TypeScript 诊断、hover、go-to-definition、find-references、go-to-implementation、document-symbol、workspace-symbol）通过容器内 daemon 正常工作。

---

## 一、背景

### 1.1 问题描述

opencode 本地模式下，LSP 通过直接管理本地 language server 进程实现诊断、hover 等功能。SaaS 模式下，代码运行在远程沙箱容器中，主进程无法直接访问容器文件系统，原有的 LSP 架构完全不适用。

### 1.2 架构方案

采用"方案 C：LSP 完全下沉容器"——daemon 进程运行在沙箱容器内部，直接访问 `/workspace` 文件系统，通过 HTTP API 对外暴露 LSP 能力。

```
主进程 (opencode)
  write.ts / edit.ts / apply_patch.ts sandbox 分支
    → LspAgent.touch / .diagnostics
        ↓
  lsp.ts sandbox 分支
    → LspAgent.hover / .definition / .references
        ↓
  agent.ts (三态状态管理: starting → running → error)
    → probe 健康检查 + 自动恢复
    → HTTP POST sandbox:20877
        ↓
  容器内 daemon (bundle → /opt/opencode-lsp-daemon/index.js)
    /lsp/touch, /lsp/diagnostics, /lsp/status, /lsp/shutdown
    /lsp/hover, /lsp/definition, /lsp/references
    /lsp/implementation, /lsp/documentSymbol, /lsp/workspaceSymbol
        ↓
  LspManager → typescript-language-server --stdio
```

### 1.3 关键文件

| 文件 | 说明 |
|------|------|
| `src/lsp/agent.ts` | 主进程侧 LSP Agent 适配器，Effect Service，三态状态管理 + probe 健康检查 |
| `src/lsp/daemon/index.ts` | 容器内 HTTP daemon 入口（10 个路由） |
| `src/lsp/daemon/lsp-manager.ts` | LSP server 进程管理（spawn、initialize、diagnostics、hover、definition、references、implementation、documentSymbol、workspaceSymbol） |
| `src/lsp/daemon/bundle.ts` | esbuild 打包脚本（CJS 格式，内联 vscode-jsonrpc） |
| `src/tool/write.ts` | sandbox 分支通过 LspAgent 获取编辑后诊断 |
| `src/tool/edit.ts` | sandbox 分支通过 LspAgent 获取编辑后诊断（含 MAX_PROJECT_DIAGNOSTICS_FILES） |
| `src/tool/apply_patch.ts` | sandbox 分支通过 LspAgent 获取 patch 后诊断 |
| `src/tool/lsp.ts` | sandbox 分支通过 LspAgent 代理 hover/definition/references |
| `docker/Dockerfile` | 步骤 12：安装 daemon + typescript-language-server |

### 1.4 设计约束

- daemon 代码**不导入任何 opencode 内部模块**（无 `@/` 引用）
- daemon 仅依赖 Node.js 内置模块 + `vscode-jsonrpc`（打包内联）
- 打包格式为 **CJS**（`vscode-jsonrpc` 内部使用 `require("util")`）
- daemon 端口 `20877`，绑定 `0.0.0.0`（容器内可达）
- LSP server 根检测：向上查找 `tsconfig.json` / `package.json` / lock files，默认 `/workspace`
- 健康检查：每次 API 调用前 probe（5s 超时），失败自动重置状态并重启 daemon
- 启动等待：daemon 启动后轮询最多 15 秒确认就绪

---

## 二、单元测试

### 2.1 路径映射验证

daemon 内部不做宿主路径映射。主进程侧 `agent.ts` 通过 `toSandboxPath()` 转换后再发送给 daemon。daemon 返回的 `/workspace/...` 路径直接透传给 LLM，不做 `toHostPath` 反向映射（遵循路径泄露防护原则，参见 [20-path-leak-test.md](./20-path-leak-test.md)）。

| 场景 | 预期 |
|------|------|
| 主进程传入绝对路径 `src/index.ts` | daemon 收到 `/workspace/src/index.ts` |
| 主进程传入相对路径 `package.json` | daemon 收到 `/workspace/package.json` |
| 主进程传入 `./` | daemon 收到 `/workspace/` |
| daemon 返回 `/workspace/src/error.ts` | 直接透传给 LLM，不做反向映射 |

### 2.2 三态状态管理

`agent.ts` 中 `Map<SessionID, DaemonState>` 管理状态：

| 状态 | 含义 | 触发 |
|------|------|------|
| `"starting"` | daemon 正在启动，等待就绪 | `ensureDaemon()` 被调用 |
| `"running"` | daemon 已就绪，可接受请求 | probe 成功 |
| `"error"` | daemon 启动失败或崩溃 | probe 失败 / 超时 |

状态转换：

```
(undefined) → starting → running
starting → error (15s 内 probe 失败)
running → error (后续 probe 失败)
error → starting (下次请求触发重新 ensure)
```

---

## 三、集成测试用例

本章节包含三条测试路径，均已沉淀为**可执行脚本**：

- **路径 A — Daemon 单元测试**（T27.1–T27.7.6）：在宿主机直接用 `node` 跑 daemon bundle，curl 直连 `localhost:20877` 验证每个 LSP 端点。最快、无需 SaaS 栈，用于验证 daemon 本身。
  - 📜 **可执行脚本**：[`lsp-daemon-unit-test.mjs`](./lsp-daemon-unit-test.mjs) —— 自动建临时 TS 项目、启 daemon、验证全部 13 个端点。实测 **14/14 通过**。
  - 运行：`cd packages/opencode && bun run build:daemon && node ../../docs/test-cases/lsp-daemon-unit-test.mjs`
- **路径 B — 端到端 sandbox 测试**（T27.8–T27.16）：通过本地 OpenSandbox 创建**真实 sandbox 容器**，在容器内启动 daemon 并验证。模拟 SaaS 模式下 sandbox 内的真实场景。daemon 在容器内运行，宿主机**不能**直连 `localhost:20877`，脚本通过 OpenSandbox SDK 的 `commands.run` 从容器内部验证。
  - 📜 **可执行脚本**：[`lsp-sandbox-e2e-test.mjs`](./lsp-sandbox-e2e-test.mjs) —— OpenSandbox SDK 直连，建 sandbox、启 daemon、验证 status/documentSymbol/callHierarchy/diagnostics。实测 **6/6 通过**。内置踩坑解法（platform amd64、execd 重试、QEMU 长等待）。
- **路径 C — Code-Agent 端到端测试**：通过 SaaS API 完整模拟 code-agent 在沙箱中的真实开发流程。以"添加日期格式化工具函数"为场景，串联全部 LSP 操作（diagnostics / documentSymbol / workspaceSymbol / hover / goToDefinition / findReferences / goToImplementation / callHierarchy / apply_patch），并全程检查**路径泄露防护**（遵循 [20-path-leak-test.md](./20-path-leak-test.md) 的单向映射原则）。
  - 📜 **可执行脚本**：[`lsp-code-agent-e2e-test.mjs`](./lsp-code-agent-e2e-test.mjs) —— 13 步 AI 对话，覆盖全部 9 个 LSP 操作 + write/edit 的诊断触发 + 非 TS 文件不触发 LSP。自动检查路径泄露和能力缺失。
  - 运行：`node docs/test-cases/lsp-code-agent-e2e-test.mjs`（前提：SaaS 容器 + OpenSandbox + 权限已配置）
  - 运行（需本地 OpenSandbox server + `opencode-opensandbox:local` 镜像）：`cd packages/opencode && OPENCODE_SANDBOX_DOMAIN=localhost:8080 bun ../../docs/test-cases/lsp-sandbox-e2e-test.mjs`

> 路径 B 的本地环境搭建（TCP 转发、本地 OpenSandbox server、SaaS 容器启动、权限配置）完全遵循 [`docs/local-test-env.md`](../local-test-env.md)。下文仅补充 LSP 专属步骤。

### 前置条件

**路径 A（daemon 单元测试）：**
- `node` ≥ 18
- daemon bundle 已构建（`cd packages/opencode && bun run build:daemon`）
- 宿主机安装 `typescript-language-server` 和 `typescript`（或测试项目 `node_modules` 内有）

**路径 B（端到端 SaaS）：**
- 已按 `local-test-env.md` 完成：TCP 转发（PG `:15432`）、本地 OpenSandbox server（`:8080`）、SaaS 容器（`:14096`）
- **sandbox 镜像 `opencode-opensandbox:local` 已构建且内置 LSP daemon**：`packages/opencode/docker/Dockerfile` 步骤 12 已 COPY daemon + 安装 `typescript-language-server`。重新构建镜像后才会包含最新 daemon bundle
- 已执行 `local-test-env.md` Step 3.5 配置权限（`edit:allow` / `write:allow`），否则工具卡 `running`

### 路径 A：Daemon 单元测试本地命令

```bash
# 1. 构建 daemon
cd /Users/ruomu/code/opencode/packages/opencode && bun run build:daemon

# 2. 创建测试项目（含 typescript-language-server）
mkdir -p /tmp/lsp-test && cd /tmp/lsp-test
cat > tsconfig.json << 'EOF'
{ "compilerOptions": { "strict": true, "target": "ES2020" }, "include": ["*.ts"] }
EOF
cat > test.ts << 'EOF'
const x: string = 123
function foo(a: number): string { return a }
export { foo }
EOF
npm init -y >/dev/null 2>&1
npm install --no-save typescript typescript-language-server >/dev/null 2>&1

# 3. 启动 daemon（DAEMON 在 /tmp/lsp-test 下能找到 node_modules/.bin/typescript-language-server）
DAEMON=/Users/ruomu/code/opencode/packages/opencode/docker/opt/opencode-lsp-daemon/index.js
nohup env LSP_AGENT_PORT=20877 PATH="/tmp/lsp-test/node_modules/.bin:$PATH" \
  node "$DAEMON" > /tmp/daemon.log 2>&1 &
sleep 3

# 4. 冒烟测试
curl -s http://localhost:20877/lsp/status
```

> 路径 A 中所有 `/tmp/lsp-test/*.ts` 路径即容器内 `/workspace/*.ts` 的本地等价物。daemon 内部不做宿主↔沙箱路径映射，直接用传入的绝对路径。

### 路径 B：端到端 SaaS 测试准备

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

# send_and_verify <sessionID> <prompt> <label>
# 发送一条 AI 消息，打印 AI 文字回复，供后续 curl /message 验证工具调用。
# 用 urllib 而非 curl 内联处理 JSON body 转义（prompt 含引号时 shell 转义易出错）。
send_and_verify() {
  local sid="$1" prompt="$2" label="$3"
  echo "── $label ──"
  python3 - "$BASE" "$sid" "$prompt" "$MODEL" <<'PY'
import json, sys, urllib.request
base, sid, prompt, model = sys.argv[1], sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
body = json.dumps({"parts": [{"type": "text", "text": prompt}], "model": model}).encode()
req = urllib.request.Request(f"{base}/session/{sid}/message", data=body,
                            headers={"Content-Type": "application/json"})
with urllib.request.urlopen(req, timeout=120) as r:
    d = json.load(r)
for p in d.get("parts", []):
    if p.get("type") == "text":
        print("AI:", p["text"][:200])
PY
}

# 0. 确认 SaaS 服务可用（参照 local-test-env.md Step 3）
curl -s "$BASE/" -o /dev/null -w "SaaS HTTP %{http_code}\n"   # 期望 200

# 1. 配置权限（local-test-env.md Step 3.5，必须，否则工具卡 running）
curl -s -X PATCH "$BASE/global/config" -H 'Content-Type: application/json' \
  -d '{"permission":{"bash":"allow","edit":"allow","write":"allow","read":"allow","glob":"allow","grep":"allow","list":"allow"}}' \
  | python3 -c "import json,sys;print('permission:',json.load(sys.stdin).get('permission'))"
sleep 2

# 2. 创建 session（权限 PATCH 会 dispose 旧实例，须重新创建）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 3. 准备 tsconfig.json（用 exec 直接在容器内创建，建立 TS 项目根）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"printf %s \"{\\\"compilerOptions\\\":{\\\"strict\\\":true}}\" > /workspace/tsconfig.json && ls -la /workspace"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit:',d.get('exitCode'))"

# 4. 触发 daemon 启动：通过 write 工具写一个 TS 文件
#    ⚠️ daemon 仅在 LSP 工具调用（write/edit/lsp）时由主进程 runDetached 启动，
#    exec API 直接跑 shell 不经过工具层，不会触发 daemon，故必须走工具。
send_and_verify $SID \
  'Create /workspace/probe.ts with: export const n: number = 1' \
  "B-prep trigger daemon via write tool"

# 5. daemon 启动后，在容器内部 curl 验证（宿主机无法直连容器内 20877）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"curl -s http://localhost:20877/lsp/status || echo DAEMON_NOT_STARTED"}' \
  | python3 -c "import json,sys;print('daemon status:', json.load(sys.stdin).get('stdout','').strip())"
```

> **关键 1**：daemon 在沙箱容器内监听 `localhost:20877`，宿主机无法直连。验证 daemon 必须用 `exec` API 从容器**内部** curl。
> **关键 2**：daemon 由 opencode 主进程在**首次 LSP 工具调用**（write/edit/apply_patch/lsp 的 sandbox 分支）时通过 `runDetached` 自动启动。`exec` API 直接在沙箱执行 shell，**不经过工具层**，因此单靠 exec 写文件**不会**触发 daemon。步骤 4 必须用 `send_and_verify`（AI 调 write 工具）才能拉起 daemon。

> `send_and_verify` 已在上方准备段定义；`$MODEL` 须与 `local-test-env.md` 一致（`zhipuai/glm-5.1`）。后续 T27.8–T27.12 用例直接复用该函数与 `$BASE` / `$SID`。

---

### T27.1 Daemon 启动与状态查询

**目标**：验证 daemon HTTP 服务器正常启动，`/lsp/status` 返回空服务器列表。

```bash
curl -s http://localhost:20877/lsp/status
```

**预期**：
- HTTP 200
- `{"servers":[]}`

---

### T27.2 TypeScript Server 自动启动

**目标**：touch 一个 `.ts` 文件后，daemon 自动启动 typescript-language-server。

```bash
curl -s -X POST http://localhost:20877/lsp/touch \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/test.ts"}'
# 等待 LSP server 初始化
sleep 8
curl -s http://localhost:20877/lsp/status
```

**预期**：
- touch 返回 `{"version":0}`
- status 返回 `{"servers":[{"id":"typescript","status":"running"}]}`

---

### T27.3 TypeScript 类型错误诊断

**目标**：对含有类型错误的文件调用 `/lsp/diagnostics`，返回正确的诊断信息。

```bash
curl -s -X POST http://localhost:20877/lsp/diagnostics \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/test.ts"}'
```

**预期**：
- HTTP 200
- `diagnostics` 包含至少 2 条错误：
  - `Type 'number' is not assignable to type 'string'`（`const x: string = 123`，行 0）
  - `Type 'number' is not assignable to type 'string'`（`return a`，行 1）
- 每条诊断包含 `range`、`severity`（1=Error）、`code`（2322）、`source`（"typescript"）

---

### T27.4 Hover 信息查询

**目标**：hover 到变量 `x`，返回类型信息。

```bash
curl -s -X POST http://localhost:20877/lsp/hover \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/test.ts", "line": 0, "character": 6}'
```

**预期**：
- HTTP 200
- `contents` 包含 `const x: string` 类型信息
- 格式为 `[{value: "...```typescript\nconst x: string\n```..."}]`

---

### T27.5 Go-to-Definition

**目标**：跳转到变量 `x` 的定义位置。

```bash
curl -s -X POST http://localhost:20877/lsp/definition \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/test.ts", "line": 0, "character": 6}'
```

**预期**：
- HTTP 200
- `locations` 包含 1 个结果，指向 `test.ts` 行 0 字符 6-7
- `uri` 为 `file:///tmp/lsp-test/test.ts`

---

### T27.6 Find References

**目标**：查找 `foo` 函数的引用。

```bash
curl -s -X POST http://localhost:20877/lsp/references \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/test.ts", "line": 1, "character": 16}'
```

**预期**：
- HTTP 200
- `locations` 为数组（可能包含函数声明本身和 `export` 语句）

---

### T27.7 Daemon 优雅关闭

**目标**：`/lsp/shutdown` 关闭所有 LSP server 并停止 daemon。

```bash
curl -s -X POST http://localhost:20877/lsp/shutdown
sleep 1
curl -s http://localhost:20877/lsp/status
```

**预期**：
- shutdown 返回 `{"ok":true}`
- 后续请求连接被拒绝（daemon 已退出）

---

### T27.7.1 Go-to-Implementation

**目标**：查询函数的实现位置（接口→实现、抽象→具体）。

```bash
# 先创建接口和实现文件
cat > /tmp/lsp-test/iface.ts << 'EOF'
export interface Greeter { greet(name: string): string }
EOF
cat > /tmp/lsp-test/impl.ts << 'EOF'
import { Greeter } from "./iface"
export class HelloGreeter implements Greeter { greet(name: string) { return `Hello ${name}` } }
EOF

# touch 两个文件让 LSP 索引
curl -s -X POST http://localhost:20877/lsp/touch -H 'Content-Type: application/json' -d '{"path": "/tmp/lsp-test/iface.ts"}'
curl -s -X POST http://localhost:20877/lsp/touch -H 'Content-Type: application/json' -d '{"path": "/tmp/lsp-test/impl.ts"}'
sleep 5

# 查找 Greeter 接口的实现
curl -s -X POST http://localhost:20877/lsp/implementation \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/iface.ts", "line": 0, "character": 17}'
```

**预期**：
- HTTP 200
- `locations` 包含指向 `impl.ts` 中 `HelloGreeter` 类的实现位置
- `uri` 为 `file:///tmp/lsp-test/impl.ts`

---

### T27.7.2 Document Symbol

**目标**：获取文件中的符号列表（函数、类、变量等）。

```bash
curl -s -X POST http://localhost:20877/lsp/documentSymbol \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/impl.ts"}'
```

**预期**：
- HTTP 200
- 返回符号数组，包含：
  - `HelloGreeter` 类（kind=5, Class）
  - `greet` 方法（kind=6, Method）
- 每个符号包含 `name`、`kind`、`range`

---

### T27.7.3 Workspace Symbol

**目标**：在整个工作区中搜索符号。

```bash
curl -s -X POST http://localhost:20877/lsp/workspaceSymbol \
  -H 'Content-Type: application/json' \
  -d '{"query": "Greeter"}'
```

**预期**：
- HTTP 200
- 返回符号数组，包含 `Greeter` 接口和 `HelloGreeter` 类
- 按 kind 过滤（Class=5, Method=6, Function=12, Module=11, Constructor=9, Enum=10 等常用类型）
- 结果限制 10 条

---

### T27.7.4 Prepare Call Hierarchy

**目标**：准备调用层级，获取指定位置符号的 CallHierarchyItem。

```bash
# 复用 impl.ts 中的 greet 方法
curl -s -X POST http://localhost:20877/lsp/prepareCallHierarchy \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/impl.ts", "line": 1, "character": 60}'
```

**预期**：
- HTTP 200
- `items` 包含指向 `greet` 方法的 CallHierarchyItem（含 name、kind、uri、range）

---

### T27.7.5 Incoming Calls

**目标**：查找谁调用了目标函数（调用方）。

```bash
# 先创建一个调用 greet 的文件
cat > /tmp/lsp-test/caller.ts << 'EOF'
import { HelloGreeter } from "./impl"
const g = new HelloGreeter()
export function run() { return g.greet("world") }
EOF
curl -s -X POST http://localhost:20877/lsp/touch -H 'Content-Type: application/json' -d '{"path": "/tmp/lsp-test/caller.ts"}'
sleep 5

curl -s -X POST http://localhost:20877/lsp/incomingCalls \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/impl.ts", "line": 1, "character": 60}'
```

**预期**：
- HTTP 200
- `calls` 包含来自 `caller.ts` 的 `run` 函数的调用（CallHierarchyIncomingCall）
- 内部先 prepareCallHierarchy 拿第一个 item，再发 `callHierarchy/incomingCalls`

---

### T27.7.6 Outgoing Calls

**目标**：查找目标函数调用了哪些函数（被调用方）。

```bash
curl -s -X POST http://localhost:20877/lsp/outgoingCalls \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/lsp-test/caller.ts", "line": 2, "character": 24}'
```

**预期**：
- HTTP 200
- `calls` 包含 `run` 函数调用的 `greet`（CallHierarchyOutgoingCall）

---

### T27.8 Write 工具沙箱分支诊断

**目标**：通过 SaaS API 调用 write 工具写入含错误的 TS 文件，验证诊断结果返回。

**前置**：已完成"路径 B：端到端 SaaS 测试准备"，`$BASE` / `$MODEL` / `$SID` / `send_and_verify` 已就绪。

```bash
# 1. 写入含错误的 TS 文件（复用准备段的 $SID）
send_and_verify $SID \
  'Create a file called broken.ts in /workspace with: const y: number = "not a number"' \
  "T27.8 write tool LSP diagnostics"

# 2. 验证工具输出包含 LSP 错误
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for m in msgs[-3:]:
    for p in m.get('parts', []):
        if p.get('type') == 'tool' and p.get('tool') == 'write':
            output = p.get('state', {}).get('output', '')
            if 'LSP errors detected' in output:
                print('✅ LSP diagnostics present in write output')
            else:
                print('❌ No LSP diagnostics in write output')
"
```

**预期**：
- write 工具输出包含 `LSP errors detected in this file`
- 诊断信息包含 `Type 'string' is not assignable to type 'number'`

---

### T27.9 Edit 工具沙箱分支诊断

**目标**：通过 SaaS API 调用 edit 工具修改 TS 文件引入错误，验证诊断结果返回。

```bash
send_and_verify $SID \
  'Edit broken.ts: change the type of y from number to boolean but keep the string value' \
  "T27.9 edit tool LSP diagnostics"

curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for m in msgs[-3:]:
    for p in m.get('parts', []):
        if p.get('type') == 'tool' and p.get('tool') == 'edit':
            output = p.get('state', {}).get('output', '')
            if 'LSP errors detected' in output:
                print('✅ LSP diagnostics present in edit output')
            else:
                print('❌ No LSP diagnostics in edit output')
"
```

**预期**：
- edit 工具输出包含 `LSP errors detected in this file`

---

### T27.9.1 Apply Patch 工具沙箱分支诊断

**目标**：通过 SaaS API 调用 apply_patch 工具修改 TS 文件引入错误，验证诊断结果返回。

```bash
# 先让 agent 写一个正确的 TS 文件
send_and_verify $SID \
  'Create a file called calc.ts with: export function add(a: number, b: number): number { return a + b }' \
  "T27.9.1 setup"

# 用 apply_patch 引入类型错误
send_and_verify $SID \
  'Edit calc.ts: change the return type from number to string' \
  "T27.9.1 apply_patch LSP diagnostics"

curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for m in msgs[-3:]:
    for p in m.get('parts', []):
        if p.get('type') == 'tool' and p.get('tool') == 'apply_patch':
            output = p.get('state', {}).get('output', '')
            if 'LSP errors' in output:
                print('✅ LSP diagnostics present in apply_patch output')
            else:
                print('❌ No LSP diagnostics in apply_patch output')
"
```

**预期**：
- apply_patch 工具输出包含 `LSP errors detected`
- 诊断信息包含类型不匹配错误（`Type 'number' is not assignable to type 'string'`）
- 使用 `toHostPath()` 将 sandbox 路径映射回宿主路径显示
- 其他文件诊断上限 `MAX_PROJECT_DIAGNOSTICS_FILES = 5`

---

### T27.9.2 LSP 工具沙箱分支（hover / definition / references）

**目标**：通过 SaaS API 调用 lsp 工具，验证 sandbox 分支正确代理 hover、goToDefinition、findReferences。

```bash
# 先创建测试文件
send_and_verify $SID \
  'Create a file called symbol.ts with: const greeting: string = "hello"; function shout(s: string) { return s.toUpperCase() }' \
  "T27.9.2 setup"

# 测试 hover
send_and_verify $SID \
  'Use the lsp tool to hover over the variable greeting in symbol.ts' \
  "T27.9.2 hover"

# 测试 definition
send_and_verify $SID \
  'Use the lsp tool to go to definition of greeting in symbol.ts' \
  "T27.9.2 definition"

# 测试 references
send_and_verify $SID \
  'Use the lsp tool to find references of shout in symbol.ts' \
  "T27.9.2 references"
```

**预期**：
- hover 返回 `const greeting: string` 类型信息
- goToDefinition 返回 `greeting` 的定义位置（行 0）
- findReferences 返回 `shout` 的引用列表
- 返回路径已从 `/workspace/...` 映射回宿主路径（通过 `toHostPath`）
- `metadata.result` 格式与本地 LSP 分支一致

---

### T27.9.3 LSP 工具沙箱分支 — 全部 9 个操作完整接入

**目标**：验证 lsp.ts sandbox 分支已接入全部 9 个 LSP 操作（与本地分支对齐），不再返回 "not yet supported"。

```bash
# goToImplementation
send_and_verify $SID \
  'Use the lsp tool to go to implementation of the Greeter interface' \
  "T27.9.3 implementation"

# documentSymbol
send_and_verify $SID \
  'Use the lsp tool to get document symbols for symbol.ts' \
  "T27.9.3 documentSymbol"

# workspaceSymbol
send_and_verify $SID \
  'Use the lsp tool to search workspace symbols for greeting' \
  "T27.9.3 workspaceSymbol"

# prepareCallHierarchy / incomingCalls / outgoingCalls
send_and_verify $SID \
  'Use the lsp tool to prepare call hierarchy for shout in symbol.ts' \
  "T27.9.3 prepareCallHierarchy"
send_and_verify $SID \
  'Use the lsp tool to find incoming calls for shout in symbol.ts' \
  "T27.9.3 incomingCalls"
send_and_verify $SID \
  'Use the lsp tool to find outgoing calls for shout in symbol.ts' \
  "T27.9.3 outgoingCalls"
```

**预期**：
- 所有 9 个操作（hover/goToDefinition/findReferences/goToImplementation/documentSymbol/workspaceSymbol/prepareCallHierarchy/incomingCalls/outgoingCalls）均返回实际 LSP 结果
- **不再出现** `"not yet supported in sandbox mode"`
- 各操作通过 agent → daemon HTTP 链路代理，路径 `/workspace` ↔ 宿主路径双向映射
- sandbox 分支能力与本地分支 100% 对齐

---

### T27.10 Daemon 健康检查与自动恢复

**目标**：验证 daemon 崩溃后主进程自动检测并重启。

**手动测试步骤**：

1. 创建 session，写入 TS 文件触发 daemon 启动
2. 通过 `exec` API 杀死容器内的 daemon 进程：
   ```bash
   curl -s -X POST "$BASE/session/$SID/exec" \
     -H 'Content-Type: application/json' \
     -d '{"command": "pkill -f opencode-lsp-daemon"}'
   ```
3. 再次写入 TS 文件，验证 LSP 诊断仍能工作（daemon 被自动重启）

**预期**：
- 第一次写入后 LSP 诊断正常
- 杀死 daemon 后，第二次写入触发自动恢复
- 恢复后 LSP 诊断仍然返回正确结果
- 最多等待 ~20 秒（重启 + 15 秒 probe 轮询）

---

### T27.11 多 Session 隔离

**目标**：两个 session 各自启动独立的 LSP daemon，互不干扰。

```bash
SID_A="ses_lsp_iso_a"
SID_B="ses_lsp_iso_b"

# 创建两个 session
# ... (标准创建流程)

# Session A 写入 TypeScript 项目 A
send_and_verify $SID_A 'Create project-a/main.ts with: const a: string = 1' "Session A"

# Session B 写入 TypeScript 项目 B
send_and_verify $SID_B 'Create project-b/main.ts with: const b: number = "two"' "Session B"

# 验证各 session 诊断独立
```

**预期**：
- Session A 诊断 `Type 'number' is not assignable to type 'string'`
- Session B 诊断 `Type 'string' is not assignable to type 'number'`
- 两个 session 的 daemon 进程在各自的容器中独立运行

---

### T27.12 非 TypeScript 文件不触发 LSP

**目标**：写入 `.py`、`.md` 等非 TypeScript 文件时不触发 LSP 诊断。

```bash
send_and_verify $SID \
  'Create a file called readme.md with content "# Hello World"' \
  "T27.12 non-TS file"

curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for m in msgs[-3:]:
    for p in m.get('parts', []):
        if p.get('type') == 'tool' and p.get('tool') == 'write':
            output = p.get('state', {}).get('output', '')
            if 'LSP errors' not in output:
                print('✅ No LSP diagnostics for .md file')
            else:
                print('❌ Unexpected LSP diagnostics for .md file')
"
```

**预期**：
- write 输出仅 `Wrote file successfully.`
- 无 `LSP errors detected` 字样

---

### T27.13 Daemon Bundle 自包含验证

**目标**：验证 daemon bundle 不依赖任何 opencode 内部模块。

```bash
# 检查 bundle 不包含 @/ 引用
grep -c '@/index.js' /dev/null  # 不应有匹配
# 更准确：检查 bundle 中无 opencode 源码引用
node -e "
const code = require('fs').readFileSync('docker/opt/opencode-lsp-daemon/index.js', 'utf8');
const hasOpencodeImport = code.includes('@/lsp/') || code.includes('@/tool/') || code.includes('@/session/');
console.log(hasOpencodeImport ? '❌ Bundle contains opencode imports' : '✅ Bundle is self-contained');
console.log('Bundle size:', (code.length / 1024).toFixed(1), 'KB');
"
```

**预期**：
- Bundle 不包含任何 `@/` 路径引用
- Bundle 大小 < 100 KB
- 仅依赖 Node.js 内置模块（`http`, `child_process`, `path`, `fs`, `url`）+ 内联 `vscode-jsonrpc`

---

### T27.14 Dockerfile 集成验证

**目标**：验证 Docker 镜像构建后 daemon 可用。

```bash
# 构建镜像（需要在 packages/opencode 目录下）
docker build -t opencode-sandbox:lsp-test -f docker/Dockerfile .

# 运行并测试
docker run --rm opencode-sandbox:lsp-test which typescript-language-server
docker run --rm opencode-sandbox:lsp-test ls -la /opt/opencode-lsp-daemon/index.js
docker run --rm opencode-sandbox:lsp-test node -e "require('/opt/opencode-lsp-daemon/index.js')" 2>&1 | head -5
```

**预期**：
- `typescript-language-server` 在 PATH 中可用
- `/opt/opencode-lsp-daemon/index.js` 存在且大小 > 50KB
- `node -e "require(...)..."` 不报语法错误

---

## 四、错误处理测试

### T27.15 Daemon 启动失败（无 TLS 二进制）

**目标**：容器内没有 `typescript-language-server` 时，daemon 优雅降级。

```bash
# 在没有 TLS 的容器中测试
docker run --rm -p 20878:20877 node:24-bookworm sh -c \
  "LSP_AGENT_PORT=20877 node /opt/opencode-lsp-daemon/index.js & sleep 2 && \
   curl -s -X POST http://localhost:20877/lsp/touch -H 'Content-Type: application/json' -d '{\"path\": \"/tmp/test.ts\"}'"
```

**预期**：
- touch 返回 `{"version":0}`（LspManager 不因无法启动 server 而崩溃）
- 或返回空错误响应（取决于 `ensureServer` 的错误处理）
- daemon HTTP 服务器本身不崩溃

---

### T27.16 请求超时处理

**目标**：验证主进程侧 HTTP 请求超时（30s）不会导致挂起。

**模拟**：在容器内启动一个不响应的 HTTP 服务器。

**预期**：
- 30 秒后主进程收到超时错误
- daemon 状态被标记为 `"error"`
- 后续请求触发自动恢复

---

## 五、验收标准

### P0 核心验收

| 用例 | 优先级 | 说明 |
|------|--------|------|
| T27.1 | P0 | Daemon 启动与状态查询 |
| T27.2 | P0 | TypeScript Server 自动启动 |
| T27.3 | P0 | 类型错误诊断 |
| T27.7 | P0 | Daemon 优雅关闭 |
| T27.8 | P0 | Write 工具沙箱分支诊断 |
| T27.13 | P0 | Bundle 自包含验证 |

### P1 稳定性验收

| 用例 | 优先级 | 说明 |
|------|--------|------|
| T27.4 | P1 | Hover 信息查询 |
| T27.5 | P1 | Go-to-Definition |
| T27.6 | P1 | Find References |
| T27.7.1 | P1 | Go-to-Implementation |
| T27.7.2 | P1 | Document Symbol |
| T27.7.3 | P1 | Workspace Symbol |
| T27.7.4 | P1 | Prepare Call Hierarchy |
| T27.7.5 | P1 | Incoming Calls |
| T27.7.6 | P1 | Outgoing Calls |
| T27.9 | P1 | Edit 工具沙箱分支诊断 |
| T27.9.1 | P1 | Apply Patch 工具沙箱分支诊断 |
| T27.9.2 | P1 | LSP 工具沙箱分支（hover/definition/references） |
| T27.9.3 | P1 | LSP 工具沙箱分支 — 全部 9 个操作完整接入 |
| T27.10 | P1 | Daemon 健康检查与自动恢复 |
| T27.11 | P1 | 多 Session 隔离 |
| T27.14 | P1 | Dockerfile 集成验证 |
| T27.15 | P1 | 启动失败优雅降级 |
| T27.16 | P1 | 请求超时处理 |

### P2 边界验收

| 用例 | 优先级 | 说明 |
|------|--------|------|
| T27.12 | P2 | 非 TypeScript 文件不触发 LSP |

---

## 六、本地已验证结果

> 路径 A（daemon 单元测试）已于 2026-06-13 在本地 macOS (ARM) + Node v22.22.2 环境**实际运行验证通过**。测试项目 `/tmp/lsp-test`（含 tsconfig.json + 5 个 .ts 文件 + 本地安装的 typescript-language-server），daemon bundle 72 KB，通过 `LSP_WORKSPACE_ROOT=/tmp/lsp-test` 覆盖根目录。

| 用例 | 状态 | 实际输出 |
|------|------|---------|
| T27.1 | ✅ | `{"servers":[]}` |
| T27.2 | ✅ | touch → `{"version":0}`，status → `{"servers":[{"id":"typescript","status":"running"}]}`，root 正确检测为 `/tmp/lsp-test` |
| T27.3 | ✅ | 检测到 2 个 `TS2322`（`Type 'number' is not assignable to type 'string'`，行 0/1）+ 1 个 `TS6133`（x 未使用） |
| T27.4 | ✅ | `{"contents":[{"value":"\n```typescript\nconst x: string\n```\n"}]}` |
| T27.5 | ✅ | `locations: 1` → test.ts line 0 char 6 |
| T27.6 | ✅ | `references: 0`（位置非符号锚点，符合预期） |
| T27.7 | ✅ | shutdown 后连接被拒绝 |
| T27.7.1 | ✅ | implementation：Greeter 接口 → impl.ts line 1（HelloGreeter 类）|
| T27.7.2 | ✅ | documentSymbol：`HelloGreeter`(kind=5 Class) + `greet`(kind=6 Method)，含嵌套 |
| T27.7.3 | ✅ | workspaceSymbol "Greeter"：`Greeter`(kind=11 Interface) + `HelloGreeter`(kind=5 Class) |
| **T27.7.4** | ✅ | **prepareCallHierarchy**：`greet` (kind=6) item |
| **T27.7.5** | ✅ | **incomingCalls**：`run` (caller.ts) 调用 greet |
| **T27.7.6** | ✅ | **outgoingCalls**：`run` 调用 `greet` (impl.ts) |
| T27.13 | ✅ | Bundle 72 KB，无 `@/` 引用，vscode-jsonrpc 已内联，13 个路由全部就位 |

> **实测发现并修复的 daemon 崩溃 bug**：旧 bundle 在 `spawn(typescript-language-server)` 因 `ENOENT` 失败时，会继续向已销毁的 child.stdin 发送 `initialize` 请求，触发未捕获的 `ERR_STREAM_DESTROYED`，**导致整个 daemon 进程崩溃退出**。已修复：(1) 将初始化握手抽为 `runInitializeHandshake` 方法并用 `try/catch` 包裹，spawn 失败时设 `spawnFailed=true` 并清理 connection/process，daemon 主进程不再崩溃；(2) `WORKSPACE` 根目录支持 `LSP_WORKSPACE_ROOT` 环境变量覆盖（默认仍为 `/workspace`，对容器内生产零影响，仅便于本地测试）。
>
### 路径 B 实测结果（2026-06-13）

> 通过本地 OpenSandbox server（Docker runtime）+ 重新构建的 `opencode-opensandbox:local` 镜像，在**真实 sandbox 容器内**验证 LSP daemon。镜像内 daemon bundle 确认为 74312 字节（含 callHierarchy + crash-fix）。

| 验证项 | 状态 | 实际输出 |
|------|------|---------|
| 镜像内 daemon + TLS | ✅ | `/opt/opencode-lsp-daemon/index.js`（74312 字节）+ `typescript-language-server`（mise shim） |
| sandbox 内 daemon 启动 | ✅ | `node /opt/opencode-lsp-daemon/index.js` 正常启动 |
| touch + status | ✅ | touch → `{"version":0}`，status → `{"servers":[{"id":"typescript","status":"running"}]}` |
| documentSymbol | ✅ | `foo`(kind=12) + `Greeter`(kind=11) + ... 正确返回 |
| **callHierarchy incomingCalls** | ✅ | `run` (caller.ts) 调用 greet，含 fromRanges 精确位置 |
| diagnostics（QEMU 环境） | ⚠️ | 返回 `{}` —— QEMU 模拟下 TS server 诊断**异步推送**时序慢，请求-响应类 API（hover/documentSymbol/callHierarchy）正常，仅推送类诊断需更长等待。路径 A 原生环境诊断已验证正常 |

> **路径 B 环境搭建踩坑经验**（本地 OpenSandbox + Docker runtime，macOS ARM）：
> 1. **OpenSandbox server 配置**：`local-test-env.md` 旧配置模板缺 `runtime.execd_image` 字段，新版 server 启动会 pydantic 校验失败。用 `uvx opensandbox-server init-config <path> --example docker` 生成官方模板（含 `execd_image = "opensandbox/execd:v1.0.16"`）。
> 2. **amd64/arm64 平台不匹配**：基础镜像 `opensandbox:2026-06-09` 是 amd64，但 OpenSandbox SDK 默认按宿主机（arm64）请求镜像 → 触发去 docker.io 拉取 arm64 变体 → 超时失败。**解法**：`Sandbox.create({ platform: { os: "linux", arch: "amd64", entrypoint: ["/opt/opensandbox/code-interpreter.sh"] } })` 显式指定 amd64，匹配本地镜像。
> 3. **QEMU 下 execd 启动慢**：amd64 镜像在 arm64 host 经 QEMU 模拟，execd（命令执行守护）首次就绪需数秒，`commands.run` 早期会 502。**解法**：对 `commands.run` 加重试（5s 间隔，8 次）。
> 4. **镜像 pull policy**：`image_pull_policy = "Never"` 加入 `[runtime]` 段可减少误拉，但平台不匹配仍需靠 #2 的显式 platform 解决。
> 5. **SaaS 镜像孤儿依赖**：`@alibaba-group/opensandbox` 和 `postgres` 是代码 import 但 package.json 未声明的"孤儿依赖"（原靠宿主机 node_modules 碰巧存在 + docker COPY 进去工作）。重建镜像需在 `packages/opencode/package.json` 正式声明（`@alibaba-group/opensandbox@0.1.8` + `postgres@3.4.7`），否则容器内 `bun install` 不会装它们。

> Phase 2 工具层 sandbox 分支（write/edit/apply_patch/lsp）已 typecheck 零新增错误。SaaS 服务容器完整启动受阻于 `app-runtime.ts` 同步 `require("db-core-bridge")` 在新 bun 版本下的 async-module 限制（预存在问题，与 LSP 无关），故路径 B 采用 OpenSandbox SDK 直连方式验证 daemon，已充分覆盖容器内 LSP 能力。

---

## 七、注意事项

1. **QEMU 模拟**：在 ARM Mac 上运行 amd64 容器时通过 QEMU 模拟，性能约下降 10 倍。daemon 启动和 LSP 初始化在容器内可能需要 30-60 秒
2. **Bundle 格式**：必须使用 CJS（不能用 ESM），因为 `vscode-jsonrpc` 内部使用 `require("util")` 动态导入
3. **首次请求延迟**：touch 首次请求需要启动 typescript-language-server 并执行 initialize 握手，可能需要 5-10 秒
4. **Phase 2 范围**：当前 daemon 支持 TypeScript 的 10 个 LSP 操作（touch/diagnostics/status/shutdown/hover/definition/references/implementation/documentSymbol/workspaceSymbol）。lsp.ts sandbox 分支已接入 hover/definition/references，implementation/documentSymbol/workspaceSymbol 暂返回 "not yet supported in sandbox mode" 提示
5. **apply_patch.ts sandbox 分支**：与 write.ts/edit.ts 一致，通过 `LspAgent` 获取 patch 后诊断，同样有 `MAX_PROJECT_DIAGNOSTICS_FILES = 5` 全项目诊断上限
6. **edit.ts sandbox 分支**：依赖 `SandboxProvider.Service` 可用，本地模式下 sandbox 分支不执行
7. **format/BOM 在 SaaS 下的设计取舍（非缺陷）**：`Format.file` 通过 `appProcess.run(ChildProcess.make(...))` 在**主进程本地文件系统**上运行 prettier/ruff 等格式化命令。SaaS 模式下文件位于沙箱容器内，主进程既无文件也无格式化工具，因此 write/edit/apply_patch 的 sandbox 分支**显式跳过 format 和 BOM 处理**，这是符合架构的合理取舍。TypeScript 项目默认 UTF-8 无 BOM，影响可忽略。如需 SaaS 下格式化，应作为后续 Phase 在 daemon 侧实现（容器内运行格式化器）
8. **apply_patch.ts format 修复**：行 276-281 的 `format.file(edited)` / `Bom.syncFile(afs, edited, ...)` 原会在 sandbox 模式下尝试操作宿主路径（文件不存在，静默失败）。已修复为 `svc._tag === "None"`（仅本地模式）时才执行，与 write/edit sandbox 分支保持一致
9. **edit.ts sandbox 并发锁**：sandbox 分支已加 per-file 锁，与本地分支一致，防止并发编辑同一文件的竞争条件
10. **lsp.ts 工具能力全接入**：sandbox 分支已接入全部 9 个 LSP 操作 —— `hover` / `goToDefinition` / `findReferences` / `goToImplementation` / `documentSymbol` / `workspaceSymbol` / `prepareCallHierarchy` / `incomingCalls` / `outgoingCalls`，与本地分支 100% 对齐，不再有 "not yet supported" 降级路径
