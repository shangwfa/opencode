# CodeGraph 集成测试（通过 opencode API）

> 验证通过 SaaS REST API 实现完整的 CodeGraph 第三方工具集成链路：
> **手动注册 codegraph MCP + 设置 AGENTS.md → AI 调用 codegraph 工具分析代码**。
>
> 沙箱镜像已预装 codegraph v1.4.1（见 [`packages/opencode/docker/Dockerfile`](../../../../packages/opencode/docker/Dockerfile) 步骤 `8b`），无需 per-session 安装。

## 涉及的 opencode API

| 步骤 | API | 用途 |
|---|---|---|
| T-CG.1 | `POST /session` | 创建 session（指定工作目录） |
| T-CG.2 | `POST /session/:id/keep-alive` | 启动并保活沙箱 |
| T-CG.3 | `POST /session/:id/exec` | 沙箱内执行 shell（git clone + 项目结构验证） |
| T-CG.4 | `POST /session/:id/exec` | 验证 codegraph 预装 |
| T-CG.5 | `POST /session/:id/exec` | codegraph install + init（生成 `.opencode/`） |
| T-CG.6a | `POST /session/:id/mcps/create` | **手动注册 codegraph local MCP** |
| T-CG.6b | `POST /session/:id/agents-md/create` | **手动设置 AGENTS.md**（payload: `{content}`） |
| T-CG.7 | `GET/POST` + PG | 验证 MCP / AGENTS.md 持久化 |
| T-CG.8 | `POST /session/:id/prompt_async` | 触发 AI 调用 codegraph MCP 工具 |

## 公共配置

```bash
BASE="http://127.0.0.1:14096"
PG_URL="postgresql://local@127.0.0.1:15432/opencode"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
WORKDIR="/workspace/proma-codegraph"   # 沙箱内工作目录
```

---

## T-CG.1 创建 Session（POST /session）

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session?directory=$WORKDIR" \
  -H 'Content-Type: application/json' \
  -d '{"title":"codegraph-e2e"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

**期望响应**：`{"id":"ses_xxx","title":"codegraph-e2e",...}`

---

## T-CG.2 启动沙箱（POST /session/:id/keep-alive）

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}'
```

**期望响应**：`{"sessionID":"ses_xxx","keepAlive":true,"sandboxId":"sb-xxx"}`

---

## T-CG.3 准备项目（POST /session/:id/exec）

通过 exec API 在沙箱内 git clone Proma 仓库：

```bash
curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"git clone --depth 1 https://github.com/proma-ai/Proma.git /workspace/proma-codegraph 2>&1 | tail -3"}'

# 验证项目结构
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls /workspace/proma-codegraph/apps/ /workspace/proma-codegraph/packages/ && find /workspace/proma-codegraph -name \"*.ts\" -o -name \"*.tsx\" | wc -l"}'
```

**期望**：exitCode=0；项目含 `apps/`（cli,electron）+ `packages/`（core,session-core,shared,ui），≈544 个 TS 文件。

---

## T-CG.4 验证 codegraph 预装（POST /session/:id/exec）

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"which codegraph && codegraph --version"}'
```

**期望**：`/usr/local/bin/codegraph` + `1.4.1`（沙箱镜像预装，秒级返回）。

---

## T-CG.5 codegraph install + init（POST /session/:id/exec）

通过 exec API 跑 codegraph 自己的命令，生成 `.opencode/` 配置：

```bash
# install：生成 .opencode/opencode.jsonc + .opencode/AGENTS.md
curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"cd $WORKDIR && codegraph install --target=opencode --yes --location=local 2>&1\"}"

# init：构建代码图谱
curl -s --noproxy '*' --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"cd $WORKDIR && codegraph init 2>&1 | tail -5\"}"

# 验证文件已生成（codegraph install --location=local 放在项目根目录，不在 .opencode/ 子目录）
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"ls $WORKDIR/AGENTS.md $WORKDIR/opencode.jsonc 2>&1\"}"
```

**期望**：
- 项目根目录下生成 `AGENTS.md` + `opencode.jsonc`
- `opencode.jsonc` 含 codegraph local MCP 配置：
  ```json
  {"mcp":{"codegraph":{"type":"local","command":["codegraph","serve","--mcp"],"enabled":true}}}
  ```

---

## T-CG.6 手动注册 MCP + 设置 AGENTS.md

> 用两个独立的 SaaS API 完成 codegraph 注入：
> - **T-CG.6a** 通过 `mcps/create` 注册 codegraph local MCP
> - **T-CG.6b** 通过 `agents-md/create` 设置 AGENTS.md（用沙箱里的文件内容）
>
> 跟 `dot-opencode/load` 的差别：这是**低层级 API**，每步显式可控；`dot-opencode/load` 是封装好的"一键扫描注入"。两者最终效果一致（都写同样的 PG 表）。

### T-CG.6a 注册 codegraph local MCP（POST /session/:id/mcps/create）

> ⚠️ **实测修正（2026-08-02）**：`codegraph serve --mcp` 必须在**项目目录**运行（`cwd` 有 `.codegraph` 图谱）。opencode local MCP 的默认 workingDirectory 是 `/workspace`（无图谱），直接 `["codegraph","serve","--mcp"]` 会导致 codegraph 进程高 CPU 空转、`codegraph_explore` 调用失败。需用 `sh -lc` 先 `cd` 到项目目录：
>
> ```json
> { "name": "codegraph", "type": "local",
>   "command": ["sh", "-lc", "cd /workspace/proma-codegraph && codegraph serve --mcp"], "enabled": true }
> ```

```bash
# 先清理旧数据（避免干扰）
psql "$PG_URL" -c "DELETE FROM session_mcps WHERE session_id='$SID';"
psql "$PG_URL" -c "DELETE FROM session_agents_md WHERE session_id='$SID';"

# 注册 codegraph local MCP（命令对应 .opencode/opencode.jsonc 里的 mcp.codegraph，加 cd 到项目目录）
curl -s --noproxy '*' -X POST "$BASE/session/$SID/mcps/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "codegraph",
    "type": "local",
    "command": ["sh", "-lc", "cd /workspace/proma-codegraph && codegraph serve --mcp"],
    "enabled": true
  }' | python3 -m json.tool
```

**期望响应**：

```json
{
  "id": "smc_xxx",
  "session_id": "ses_xxx",
  "name": "codegraph",
  "type": "local",
  "command": ["sh", "-lc", "cd /workspace/proma-codegraph && codegraph serve --mcp"],
  "enabled": true
}
```

### T-CG.6b 设置 AGENTS.md（POST /session/:id/agents-md/create）

```bash
# 先从沙箱读出 AGENTS.md 内容（codegraph install 在 T-CG.5 生成在项目根目录），base64 编码避免 JSON 转义陷阱
AGENTS_B64=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"cat $WORKDIR/AGENTS.md | base64 -w0\"}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin, strict=False).get('stdout','').strip())")

# 通过 agents-md/create API 写入 session
python3 <<PYEOF
import json, base64, urllib.request
content = base64.b64decode('$AGENTS_B64').decode('utf-8')
body = json.dumps({'content': content}).encode()
req = urllib.request.Request('$BASE/session/$SID/agents-md/create',
                             data=body, headers={'Content-Type':'application/json'})
print('HTTP', urllib.request.urlopen(req).status)
PYEOF
```

**期望**：HTTP 200，响应含写入的 content。

> **API 细节**：`agents-md/create` 是 upsert 语义（"Create or replace"），重复调用会覆盖。payload schema 只有 `{content: string}`（见 `AgentsMdCreatePayload`，`session.ts:87`）。

---

## T-CG.7 PG 持久化验证

T-CG.6a/b 的 `mcps/create` + `agents-md/create` 应该把 codegraph MCP + AGENTS.md 内容写入两张 PG 表：

```bash
# session_mcps：codegraph local MCP 自动注册
psql "$PG_URL" -Atc "SELECT name, type, command, enabled FROM session_mcps WHERE session_id='$SID'"
# 期望：codegraph|local|["codegraph","serve","--mcp"]|true

# session_agents_md：AGENTS.md 内容（通过 agents-md/create 写入）
psql "$PG_URL" -Atc "SELECT left(content, 100) FROM session_agents_md WHERE session_id='$SID'"
# 期望：含 Proma 项目说明（"# AGENTS.md\n\nThis file provides guidance..."）
```

---

## T-CG.8 AI 调用 codegraph 工具（POST /session/:id/prompt_async）

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\": \"text\", \"text\": \"使用 codegraph 工具分析 packages/core 包的导出接口，以及哪些包依赖了它。\"}],
    \"model\": $MODEL
  }"

# 轮询消息，等 AI 完成工具调用
bun -e '
const SID = "'$SID'"
const BASE = "http://localhost:14096"
const START = '$BEFORE'
const start = Date.now()
let assistantDone = false
while (Date.now() - start < 180000) {
  const msgs = await (await fetch(BASE + "/session/" + SID + "/message")).json()
  for (let i = START; i < msgs.length; i++) {
    for (const p of msgs[i].parts || []) {
      if (p.type === "tool" && p.tool?.startsWith("codegraph")) {
        console.log(`[${i}] ${p.tool} ${p.state?.status||"?"}`)
      } else if (p.type === "text" && p.text?.trim() && i > START) {
        console.log(`[${i}] TEXT: ${p.text.slice(0, 300)}`)
        if (msgs[i].role === "assistant") assistantDone = true
      }
    }
  }
  if (assistantDone) break
  await new Promise(r => setTimeout(r, 5000))
}
'
```

**期望**：
- AI 调用 `codegraph_codegraph_explore` 工具 ≥ 1 次（status=completed）
- AI 回复含**精确接口/行号**（如 `ProviderAdapter:244`），证明用的是 codegraph 图谱数据

> **实测记录（2026-08-02，容器重建后重跑）**：注册（cd 版命令）+ AGENTS.md（18763 chars）→ AI 调用 `codegraph.codegraph_explore` completed，返回 `packages/core/src/providers/types.ts:250` 的 `ProviderAdapter` 接口 + 4 个方法签名（providerType/buildStreamRequest/parseSSELine/buildTitleRequest/parseTitleResponse）——精确到行号，基于 codegraph 图谱数据。⚠️ 注意：AI 可能倾向用 grep/bash 替代 MCP 工具，若需强制验证 MCP 链路，prompt 应明确"必须使用 codegraph_explore 工具"。

---

## 验收对照

| 验证项 | API | 结果 |
|--------|------|------|
| Session 创建 | `POST /session` | ✅ |
| 沙箱启动 | `POST /session/:id/keep-alive` | ✅ |
| 项目准备（exec git clone） | `POST /session/:id/exec` | ✅ |
| codegraph 预装验证 | `POST /session/:id/exec` | ✅ 1.4.1 |
| codegraph install（生成 AGENTS.md + opencode.jsonc 在项目根目录） | `POST /session/:id/exec` | ✅ `--location=local` 放项目根目录 |
| **手动注册 MCP + 设置 AGENTS.md** | **`POST /session/:id/mcps/create`** + **`POST /session/:id/agents-md/create`** | ✅ PG 两表持久化 |
| PG 持久化 | `psql` | ✅ MCP + AGENTS.md (18722 chars) |
| AI 调用 codegraph 工具 | `POST /session/:id/prompt_async` | ✅ `codegraph_explore(completed)`，返回 `types.ts:250` 精确接口（2026-08-02 重跑） |

> **关键验证**：T-CG.6 用 `mcps/create` + `agents-md/create` 两个独立 API 显式完成 MCP + AGENTS.md 注入——这种低层级 API 方式**每步可控**，适合需要精细管理 session 资源的场景。`dot-opencode/load` 是更高层的封装（一键扫描 `.opencode/`），见 [`opencode/sandbox/codegraph.md`](../sandbox/codegraph.md) T37.30。
