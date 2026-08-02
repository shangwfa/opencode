# CodeGraph 集成测试（通过 opencode API）

> 验证通过 SaaS REST API 实现完整的 CodeGraph 第三方工具集成链路：
> **加载项目 `.opencode/` → 自动注入 MCP + AGENTS.md → AI 调用 codegraph 工具分析代码**。
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
| T-CG.6 | `POST /session/:id/dot-opencode/load` | **核心 API**：扫描 `.opencode/` 自动注入 MCP + AGENTS.md |
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

# 验证 .opencode/ 已生成
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"find $WORKDIR/.opencode -type f | sort\"}"
```

**期望**：
- `.opencode/` 下生成 `AGENTS.md` + `opencode.jsonc`
- `opencode.jsonc` 含 codegraph local MCP 配置：
  ```json
  {"mcp":{"codegraph":{"type":"local","command":["codegraph","serve","--mcp"],"enabled":true}}}
  ```
- `codegraph init` 输出：Files/Nodes/Edges/DB Size 统计

> ⚠️ **实测修正（2026-08-02）**：`codegraph install --location=local` 实际把 `AGENTS.md` + `opencode.jsonc` 生成在**项目根目录**（非 `.opencode/` 子目录）。要让 `dot-opencode/load` 扫描到，需移动到 `.opencode/`：
> ```bash
> mkdir -p $WORKDIR/.opencode && mv $WORKDIR/opencode.jsonc $WORKDIR/.opencode/ && mv $WORKDIR/AGENTS.md $WORKDIR/.opencode/
> ```
> 另：`codegraph serve --mcp` 必须在项目目录运行（opencode local MCP 默认 cwd `/workspace` 无图谱会空转），`opencode.jsonc` 里 codegraph command 需改为 `["sh","-lc","cd /workspace/proma-codegraph && codegraph serve --mcp"]`。

---

## T-CG.6 通过 dot-opencode/load API 自动注入（核心）

> 这是**整个测试的关键 API**：一个调用同时注入 MCP 和 AGENTS.md，无需手动 `/mcps/create` 或 `/agents-md`。

```bash
# 先清理 session 旧数据（避免干扰）
psql "$PG_URL" -c "DELETE FROM session_mcps WHERE session_id='$SID';"
psql "$PG_URL" -c "DELETE FROM session_agents_md WHERE session_id='$SID';"

# 调用 dot-opencode/load API
curl -s --noproxy '*' -X POST "$BASE/session/$SID/dot-opencode/load?directory=$WORKDIR" | python3 -m json.tool
```

**期望响应**：

```json
{
  "loaded": ["AGENTS.md", "mcp/codegraph"],
  "skipped": []
}
```

---

## T-CG.7 PG 持久化验证

`dot-opencode/load` 应该把 `.opencode/` 的内容写入两张 PG 表：

```bash
# session_mcps：codegraph local MCP 自动注册
psql "$PG_URL" -Atc "SELECT name, type, command, enabled FROM session_mcps WHERE session_id='$SID'"
# 期望：codegraph|local|["codegraph","serve","--mcp"]|true

# session_agents_md：AGENTS.md 内容自动注入
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

---

## 验收对照

| 验证项 | API | 结果 |
|--------|------|------|
| Session 创建 | `POST /session` | ✅ |
| 沙箱启动 | `POST /session/:id/keep-alive` | ✅ |
| 项目准备（exec git clone） | `POST /session/:id/exec` | ✅ 655 TS 文件 |
| codegraph 预装验证 | `POST /session/:id/exec` | ✅ 1.4.1 |
| codegraph install + init（生成 .opencode/） | `POST /session/:id/exec` | ✅ 实测生成在项目根，需 mv 到 `.opencode/` |
| **自动注入 MCP + AGENTS.md** | **`POST /session/:id/dot-opencode/load`** | ✅ `loaded:["AGENTS.md","mcp/codegraph"]` |
| PG 持久化 | `psql` | ✅ MCP + AGENTS.md 两表 |
| AI 调用 codegraph 工具 | `POST /session/:id/prompt_async` | ✅ `codegraph_explore(completed)`，返回 core 包 4 导出子模块 + ProviderAdapter 接口 |

> **关键验证**：T-CG.6 的 `dot-opencode/load` 一个调用同时完成 MCP 注入 + AGENTS.md 注入，**无需手动 `/mcps/create` 或 `/agents-md`**——这是 opencode API 对第三方工具集成（如 codegraph）的核心支持点。

> **实测记录（2026-08-02，容器重建后重跑）**：T-CG.1-8 全通过。`dot-opencode/load` 返回 `{"loaded":["AGENTS.md","mcp/codegraph"],"skipped":[]}`，PG `session_mcps` 注入 codegraph local MCP（cd 版命令）、`session_agents_md` 注入 AGENTS.md。AI 调用 `codegraph_explore`（含 error 重试后 completed），回复含 `@proma/core` 4 个导出子模块（providers/highlight/types/utils）+ ProviderAdapter 接口详情。与 [`../apis/codegraph.md`](../apis/codegraph.md)（手动 `mcps/create` + `agents-md/create` 方式）对比，本方式单 API 自动注入。
