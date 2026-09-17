# mastra Skill 端到端验证

> 验证用户通过 **Skill 模式**把 [mastra-ai/skills](https://github.com/mastra-ai/skills) 接入 Session：把 `SKILL.md` + 8 references + 1 script 通过 REST API 注册成 skill bundle，AI 按 skill 指引查文档（embedded/remote）+ 生成代码 + 排查错误。
>
> 官方文档：https://mastra.ai/docs/getting-started/build-with-ai

## Skill 模式 vs MCP 模式

| 维度 | Skill 模式（本文档） | MCP 模式（见 [`../41-mastra-mcp-e2e.md`](../41-mastra-mcp-e2e.md)） |
|------|---------------------|-------------------------------------------|
| 接入接口 | `POST /session/:id/skills/create` | `POST /session/:id/mcps/create` |
| AI 工具调用类型 | `skill`（加载 SKILL.md 指令） + `read`/`bash`（从隐藏目录读取 resource / 执行命令） | `mastra_*`（MCP 工具） |
| 内容来源 | GitHub `mastra-ai/skills` 仓库 `skills/mastra/` 目录 | `@mastra/mcp-docs-server` npm 包 |
| 性能 | 官方推荐（"skills will perform better"） | 较慢 |
| AI 上下文 | SaaS progressive disclosure：system prompt 仅 manifest；AI 调 `skill` tool 加载 SKILL.md 指令；resource 正文物化到隐藏目录，AI 用 `read`/`bash` 按需读取 | 每次工具调用都列出可用工具 |
| 工具粒度 | 任意 shell + 文档查询脚本（provider-registry.mjs） | 固定 MCP 工具集（`mastra_mastraDocs` / `mastra_getMastraExportDetails` 等） |

> **何时选 Skill 模式**：希望 AI 用 CLI 完整能力（创建项目、跑 `mastra api`、查 `node_modules/@mastra/*/dist/docs/`），按官方推荐获得更好性能。
>
> **何时选 MCP 模式**：希望工具调用结构化、可被 MCP client 校验，或需要 `mastra_getMastraCourseStatus` 等 MCP 专属工具。

## Skill 信息

| 字段 | 值 |
|------|-----|
| 名称 | `mastra` |
| 注册方式 | **Bundle**（SKILL.md 当 content + references/scripts 当 resources，见 T46.3） |
| 本地来源 | `docs/test-cases/skills/mastra/`（10 个文件，见 T46.3 前置步骤） |
| 远端来源 | GitHub `mastra-ai/skills` 仓库 `skills/mastra/`；或 `.well-known`：`https://mastra.ai/.well-known/skills/mastra/SKILL.md` |
| content | `SKILL.md`（≈6 KB，主入口，AI 第一轮加载） |
| resources | 9 个：8 个 `references/*.md`（doc，≈38 KB）+ 1 个 `scripts/provider-registry.mjs`（script，≈5.7 KB），按需加载 |
| frontmatter | `name: mastra`，`license: Apache-2.0`，`version: 2.0.0` |
| 覆盖能力 | 项目搭建 / Agent / Workflow / Tool / Memory / Storage / 错误排查 / 版本迁移 / `mastra api` CLI |
| 运行位置 | **沙箱**（`/workspace`） |
| 仓库 | https://github.com/mastra-ai/skills |

> **Skill 设计核心**：教 AI "**不要相信内部知识**"（"Everything you know about Mastra is likely outdated or wrong"）。AI 按 skill 指引通过 bash 跑 `ls node_modules/@mastra/` / `cat dist/docs/SKILL.md` / `curl mastra.ai/llms.txt` 拉取最新文档，**避免凭训练数据乱写代码**。

> **SaaS progressive disclosure 机制**（同 [`session-skill-resources.md`](../../../docs/session-skill-resources.md)）：
> 1. **system prompt 仅注入 `<preloaded_skills>` manifest**：name/description + 9 个 resource 的 path/type/size/digest 元数据
> 2. **第一层按需加载**：AI 调 `skill` tool with `{"name":"mastra"}` → 返回 SKILL.md 完整 content（6KB） + `resource_directory`（隐藏目录路径） + 9 个 resource 元数据（path/type/size/digest）
> 3. **第二层按需加载（resource-level）**：AI 用 `read`/`bash` 从 `resource_directory` 读取所需 resource 文件（如 `read resource_directory/references/common-errors.md`）

---

## 接入流程概览

| 步骤 | 动作 | 章节 |
|------|------|------|
| 1. 创建 session | `new_sid -kb` 启动沙箱 | T46.1 |
| 2. 验证沙箱 | 确认 npm + 网络可达 mastra.ai | T46.2 |
| 3. 注册 skill bundle | `skills/create` 把 `SKILL.md` + 9 个 resources 写入 PG | T46.3 |
| 4. AI 调用 | `prompt_async` 显式 `skills:["mastra"]` 触发，AI 第一轮调 `skill` tool 加载 SKILL.md 指令，用 `read`/`bash` 从隐藏目录按需读取 resource | T46.4 |

**关键**：步骤 3 只写 PG `session_skill` 表，**不进 system prompt**。AI 在 message 处理时：
1. **system prompt 仅注入 manifest**（`<preloaded_skills>`：name/description + 9 个 resource 的 path/type/size/digest 元数据）
2. **AI 第一次需要 skill 时主动调 `skill` tool**（SaaS 内置工具，输入只有 `{"name":"mastra"}`）→ 返回 SKILL.md 完整 content（6KB） + `resource_directory` 隐藏目录路径 + 9 个 resource 元数据
3. **AI 需要某个 reference 时用 `read`/`bash` 从隐藏目录读取**（如 `read resource_directory/references/common-errors.md`），resource 正文不进入 `skill` tool output
4. **AI 通过 bash 执行 skill 教的命令**：`ls node_modules/@mastra/` / `cat dist/docs/SKILL.md` / `node resource_directory/scripts/provider-registry.mjs` / `mastra api ...`

---

## 前置条件

### 1. 沙箱基础环境

| 资源 | 验证 |
|------|------|
| Node.js + npm | `node --version && npm --version`（沙箱默认预装） |
| 网络可达 mastra.ai | `curl -s -o /dev/null -w '%{http_code}' https://mastra.ai/llms.txt`（remote-docs 走这条） |
| 网络可达 npm | `npm ping`（创建项目时用） |

### 2. 测试环境变量与辅助函数

```bash
# —— 环境变量（组合 3：本地 PG + 本地 OpenSandbox）——
export BASE="http://localhost:14096"
export PG_URL="postgresql://local@127.0.0.1:15432/opencode"
export MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
export NO_PROXY=localhost,127.0.0.1

# —— 辅助函数 ——
jexec() { python3 -c "import json,sys; d=json.load(sys.stdin, strict=False); print($1)" 2>/dev/null; }

new_sid() {
  local sid
  sid=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
  case "${1:-}" in
    -k)  curl -s -X POST "$BASE/session/$sid/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null ;;
    -kb) curl -s -X POST "$BASE/session/$sid/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' >/dev/null ;;
  esac
  echo "$sid"
}

exec_in_sandbox() {
  local sid="$1"; shift
  curl -s -X POST "$BASE/session/$sid/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"$*\"}" | jexec "(d.get('stdout') or '') + (d.get('stderr') or '')"
}

pgval() { psql "$PG_URL" -t -A -c "$1" 2>/dev/null; }
```

---

## 一、准备 session

### T46.1 创建 session 并启动沙箱

```bash
SID=$(new_sid -kb)
echo "SID: $SID"
```

**期望**：返回 `ses_xxx`，沙箱已就绪。

---

## 二、验证沙箱预装

### T46.2 确认 npm + 网络可达 mastra.ai

```bash
exec_in_sandbox "$SID" 'node --version && npm --version'
exec_in_sandbox "$SID" 'curl -s -o /dev/null -w "mastra.ai/llms.txt=%{http_code}\n" https://mastra.ai/llms.txt'
exec_in_sandbox "$SID" 'npm ping 2>&1 | tail -1'

# smoke test：直接 fetch mastra llms.txt 看 mastra 主入口
exec_in_sandbox "$SID" 'curl -s https://mastra.ai/llms.txt | head -10'
```

**期望**：
- Node ≥ 18，npm 可用
- `mastra.ai/llms.txt` 返回 200
- `npm ping` 成功
- llms.txt 内容含 mastra docs 入口链接

---

## 三、注册 session skill（Bundle 模式）

### T46.3 把 `mastra/` 目录整体注册成 skill bundle

**前置**：把 mastra 官方 skill 数据导出到本仓库（一次性，跟版本绑定）：

```bash
# 从 GitHub 克隆最新 skill（也可走 .well-known：curl https://mastra.ai/.well-known/skills/mastra/SKILL.md）
cd /tmp && rm -rf mastra-skills && git clone --depth 1 https://github.com/mastra-ai/skills.git mastra-skills
mkdir -p docs/test-cases/skills/mastra
cp -R /tmp/mastra-skills/skills/mastra/* docs/test-cases/skills/mastra/
rm -rf /tmp/mastra-skills

# 期望目录结构
find docs/test-cases/skills/mastra -type f | sort
# 期望 10 个文件：1 SKILL.md + 8 references/*.md + 1 scripts/provider-registry.mjs
```

**注册**（用 python3 安全构造 body）：

```python
import json, os, re, urllib.request

BASE = "http://localhost:14096"
SID = "$SID"  # 替换为当前 session id
SKILL_DIR = "docs/test-cases/skills/mastra"

# 1) SKILL.md 当 content
with open(f"{SKILL_DIR}/SKILL.md") as f:
    content = f.read()

# 2) 从 SKILL.md frontmatter 提取 description
desc = re.search(r'^description:\s*"?(.+?)"?\s*$', content, re.MULTILINE).group(1).strip().rstrip('"')

# 3) 收集 resources：references/*.md → doc，scripts/*.mjs → script
resources = []
for sub in ["references", "scripts"]:
    sub_dir = f"{SKILL_DIR}/{sub}"
    if not os.path.isdir(sub_dir):
        continue
    for fname in sorted(os.listdir(sub_dir)):
        with open(f"{sub_dir}/{fname}") as f:
            resources.append({
                "path": f"{sub}/{fname}",
                "type": "script" if sub == "scripts" else "doc",
                "content": f.read(),
            })

# 4) POST 注册
body = json.dumps({
    "name": "mastra",
    "description": desc[:500],
    "content": content,
    "resources": resources,
}).encode()
req = urllib.request.Request(f"{BASE}/session/{SID}/skills/create",
                             data=body, headers={"Content-Type": "application/json"})
import sys; sys.stdout.buffer.write(urllib.request.urlopen(req).read())
```

```bash
# PG 验证
psql "$PG_URL" -t -A -c "SELECT name, length(content) AS skill_md_len, jsonb_array_length(resources::jsonb) AS resource_count FROM session_skill WHERE session_id='$SID' AND name='mastra'"
```

**期望**：
- 接口返回 `id=sskill_xxx, name=mastra, resources[9]`
- PG 行：`mastra|<6000+>|9`（SKILL.md ≈ 6KB + 9 个 resources）

> **resource type 自动判定**（`skill/index.ts:427`）：`scripts/*.mjs` → script（扩展名匹配），`.md` → doc。

---

## 四、AI 用 skill 查文档/写代码

### T46.4 显式触发 skill + 加载 reference

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 mastra skill 告诉我：1) Mastra 是什么 2) Agent 和 Workflow 的区别（如果需要详细 API 参考，用 read 从 skill 返回的 resource_directory 读取 references/core-concepts.md）\"}],\"skills\":[\"mastra\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

# 轮询：等到 AI 输出 assistant 文本
bun -e '
const SID = "'$SID'"
const BASE = "http://localhost:14096"
const START = '$BEFORE'
const start = Date.now()
let lastSeen = START
let assistantDone = false
while (Date.now() - start < 150000) {
  const msgs = await (await fetch(BASE + "/session/" + SID + "/message")).json()
  for (let i = lastSeen; i < msgs.length; i++) {
    const m = msgs[i]
    const role = m.role || m.info?.role || "?"
    for (const p of m.parts || []) {
      if (p.type === "tool") {
        const s = p.state || {}
        if (p.tool === "skill") {
          console.log(`[${i} ${role}] skill ${s.status||"?"} input=${JSON.stringify(s.input||{}).slice(0,200)}`)
        } else if (p.tool === "bash") {
          console.log(`[${i} ${role}] bash ${s.status||"?"} ${(s.input?.command||"").slice(0,150)}`)
        } else if (p.tool === "read") {
          console.log(`[${i} ${role}] read ${s.status||"?"} ${(s.input?.filePath||"").slice(0,150)}`)
        }
      } else if (p.type === "text" && p.text?.trim()) {
        console.log(`[${i} ${role}] TEXT: ${p.text.slice(0,500)}`)
        if (role === "assistant") assistantDone = true
      }
    }
  }
  lastSeen = msgs.length
  if (assistantDone) { console.log("\n=== DONE ==="); break }
  await new Promise(r => setTimeout(r, 5000))
}
'
```

**期望**（关键差异：AI 第一步调内置 `skill` tool，resource 正文通过 `read`/`bash` 从隐藏目录读取）：
- `prompt_async` 返回 `HTTP 204`
- **第一个工具调用是 `skill`**（SaaS 内置 tool），input 为 `{"name":"mastra"}`（无 `resources` 参数），output 含 SKILL.md 完整 content（≈6KB） + `<resource_directory>` 隐藏目录路径 + 9 个 resource 的 path/type/size/digest 元数据，**不含 resource 正文**
- 后续 `read` 工具调用从隐藏目录读取所需 reference（如 `read resource_directory/references/core-concepts.md`），或 `bash` 调用执行命令：`ls node_modules/@mastra/` / `cat ...` / `curl https://mastra.ai/llms.txt` 等
- AI 文本回复用中文回答 "Mastra 是什么" + "Agent vs Workflow 区别"，**关键 API 引用 mastra 当前文档**（不是凭训练数据乱答）

> **Mastra skill 特点**：skill content 教 AI "**不要相信内部知识，先查文档**"，所以 AI 看到问题后第一步通常是 bash 跑 `ls node_modules/@mastra/` 检查包是否安装，再决定走 embedded-docs（包已装）还是 remote-docs（fetch mastra.ai）。

---

## 五、实战场景

> 复用 T46.1-T46.3 已注册 skill 的 session（变量 `$SID` 复用）。每个场景只给 prompt 和期望，工具调用类型为 `skill`（加载指令） + `read`/`bash`（从隐藏目录读取 resource / 执行命令）。

### T46.5 创建 Mastra 项目

**Prompt**：
```text
用 mastra skill 在 /workspace/my-app 创建一个 Mastra 项目，告诉我创建步骤和关键文件
```

**期望**：
- AI 调 `skill` tool（input 只有 `{"name":"mastra"}`），从 output 获取 `resource_directory`
- AI 用 `read` 从隐藏目录读取 `references/create-mastra.md` 获取步骤
- bash 调用含 `npx create-mastra` 或 `npm install @mastra/core`
- 项目创建后 `ls /workspace/my-app/src/mastra/` 显示 `index.ts` / `agents/` 等

### T46.6 写一个简单 Agent

**Prompt**：
```text
用 mastra skill 在 /workspace/my-app/src/mastra/agents/weather-agent.ts 创建一个简单 Agent：用 OpenAI gpt-4o-mini，回答天气问题。如果 API 不确定，用 read 从 skill 返回的 resource_directory 读取 references/embedded-docs.md 查最新 Agent API
```

**期望**：
- AI 用 `read` 从隐藏目录读取 `references/embedded-docs.md`
- bash 调用含 `cat node_modules/@mastra/core/dist/docs/...` 或 `curl https://mastra.ai/docs/...`
- 生成的代码用**当前 API**（`new Agent({...})`），不是过时的写法

### T46.7 排查常见错误

**Prompt**：
```text
我在用 mastra 创建 Agent 时遇到错误 "Cannot find module '@mastra/core'"。用 mastra skill 帮我排查（如果需要错误代码参考，用 read 从 skill 返回的 resource_directory 读取 references/common-errors.md）
```

**期望**：
- AI 用 `read` 从隐藏目录读取 `references/common-errors.md`
- AI 给出具体排查步骤（检查 package.json、npm install、tsconfig paths 等）

### T46.8 用 provider-registry 选模型

**Prompt**：
```text
用 mastra skill 的 scripts/provider-registry.mjs 查一下 Anthropic 有哪些 model 可用，告诉我 model 列表。脚本在 skill 返回的 resource_directory 中
```

**期望**：
- bash 调用含 `node resource_directory/scripts/provider-registry.mjs`（隐藏目录完整路径）
- AI 列出 Anthropic 当前可用 model（claude-3-5-sonnet 等）

### T46.9 异常处理：node_modules 没装 mastra

**Prompt**：
```text
用 mastra skill 告诉我：如果 node_modules 里没有 @mastra/* 包，应该怎么查文档？
```

**期望**：
- AI 用 `read` 从隐藏目录读取 `references/remote-docs.md` 获取 remote-docs 指引
- AI 不应该尝试 `cat node_modules/@mastra/...`（因为没装）
- AI 应该走 remote-docs：`curl https://mastra.ai/llms.txt` 或 `curl https://mastra.ai/docs/<path>.md`
- 回答符合 `references/remote-docs.md` 的指引

---

## 六、Progressive Disclosure 验证

> 验证 SaaS session_skill 的渐进式披露机制（同 [`session-skill-resources.md`](../../../docs/session-skill-resources.md)）。测试方法：同一个 session 内连续观察 4 个阶段的 input tokens 与工具调用类型。

### T46.10 baseline：无 skill 时 system prompt token 数

```bash
# 新开一个 PD 测试 session（不复用业务测试 session）
PD_SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$PD_SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"只回复一个字：hi\"}],\"model\":$MODEL}" > /dev/null

curl -s "$BASE/session/$PD_SID/message" | bun -e '
const msgs = await new Response(Bun.stdin.stream()).json()
for (const m of msgs) for (const p of m.parts||[]) {
  if (p.type==="step-finish") {
    const t = p.tokens||{}
    console.log(`baseline: input=${t.input} cache_read=${t.cache?.read} sum=${(t.input||0)+(t.cache?.read||0)}`)
    break
  }
}'
```

**期望**：`input + cache_read` ≈ 8700 tokens（system prompt + 工具定义 + 一句 user msg）

> **关键：看 input + cache_read 之和**，不能只看 input（同 [`agent-browser-skill.md`](./agent-browser-skill.md) T45.10 说明）。SaaS 把 system prompt 缓存到 provider，注册 skill 后 manifest 加入会让缓存失效。

### T46.11 注册完整 skill bundle 后 system prompt 几乎不变

```bash
# 按 T46.3 注册完整 bundle（SKILL.md 6KB + 9 resources 共 ≈50KB）到 $PD_SID
# ...（注册脚本同 T46.3，把 SID 替换为 PD_SID）

curl -s -X POST "$BASE/session/$PD_SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"再回复一个字：yo\"}],\"model\":$MODEL}" > /dev/null

curl -s "$BASE/session/$PD_SID/message" | bun -e '
const msgs = await new Response(Bun.stdin.stream()).json()
const last = msgs[msgs.length-1]
for (const p of last.parts||[]) if (p.type==="step-finish") {
  const t = p.tokens||{}
  console.log(`after register: input=${t.input} cache_read=${t.cache?.read} sum=${(t.input||0)+(t.cache?.read||0)}`)
}
'
```

**期望**：`(input + cache_read)` 增量 **≤ 200 tokens**（仅 manifest 几行：name/description + 9 个 resource 的 path/type/size/digest 元数据）。**50KB bundle 不进 system prompt**。

> **实测记录**（2026-07-30）：
> - baseline: input=481 + cache_read=8192 = **8673**
> - 注册 50KB bundle 后: input=626 + cache_read=8192 = **8818**
> - **delta = 145 tokens**（9 个 resource 的 manifest 元数据含 size/digest）
>
> 注意 `input` 从 481 升至 626 —— system prompt 因加入 manifest 而增长，但 cache_read 不变（仍 8192），说明增量很小且缓存仍有效。50KB resource 正文不进 system prompt。

### T46.12 显式触发：AI 第一个 tool 是内置 `skill`

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 mastra skill 告诉我 Mastra 是什么\"}],\"skills\":[\"mastra\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

sleep 60

curl -s "$BASE/session/$PD_SID/message" | bun -e '
const msgs = await new Response(Bun.stdin.stream()).json()
const before = '$BEFORE'
for (let i = before; i < msgs.length; i++) {
  for (const p of msgs[i].parts||[]) {
    if (p.type==="reasoning") console.log(`[${i}] reasoning: ${p.text?.slice(0,150)}`)
    if (p.type==="tool") {
      const s = p.state||{}
      const outLen = JSON.stringify(s.output||"").length
      console.log(`[${i}] TOOL ${p.tool} ${s.status||"?"} input=${JSON.stringify(s.input||{}).slice(0,150)} out=${outLen}c`)
    }
  }
}
'
```

**期望**：
- AI 第一段 reasoning 含 "load the skill" / "first load" 之类
- **第一个 TOOL 是 `skill`**（不是 bash/read！），input=`{"name":"mastra"}`（无 `resources` 参数）
- `skill` tool output 含 SKILL.md 完整 content（≈6KB） + `<resource_directory>` 隐藏目录路径 + 9 个 resource 的 path/type/size/digest 元数据，**不含 resource 正文**
- output 长度 ≈ 8000 字符（远小于 52KB bundle）

### T46.13 同 session 再发：缓存命中，不重复调 `skill` tool

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 mastra skill 告诉我 Agent 和 Workflow 的核心区别\"}],\"skills\":[\"mastra\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

sleep 80

curl -s "$BASE/session/$PD_SID/message" | bun -e '
const msgs = await new Response(Bun.stdin.stream()).json()
const before = '$BEFORE'
let skillCount = 0, bashCount = 0, readCount = 0
for (let i = before; i < msgs.length; i++) {
  for (const p of msgs[i].parts||[]) {
    if (p.type==="tool") {
      if (p.tool==="skill") skillCount++
      if (p.tool==="bash") bashCount++
      if (p.tool==="read") readCount++
    }
  }
}
console.log(`\n=== skill 调用 ${skillCount} 次, bash ${bashCount} 次, read ${readCount} 次 ===`)
console.log(skillCount === 0 ? "✅ 缓存生效" : "⚠️ 重复加载 skill")
'
```

**期望**：
- **`cache_read` 持续高位（10K+）**：system prompt 走 prompt cache（progressive disclosure 缓存生效的核心证据）
- **skill tool 调用次数可能不为 0**：mastra SKILL.md 教 AI "按问题精确查 reference"，AI 遇到新主题问题时会主动用 `read` 从隐藏目录加载对应 reference（这是按需读取，不是缓存失败）
- 跟 agent-browser 的区别：agent-browser SKILL.md 是 CLI 命令清单（一次加载够用），所以重复 message 时 skill tool = 0 次；mastra 是文档查询型（每个新主题都查），AI 用 `read` 从隐藏目录按需读取 reference 是预期行为

> **实测记录**（2026-07-30）：
> - T46.12（首次触发）: skill tool input=`{"name":"mastra"}`，output 8002c（SKILL.md 6KB + resource_directory + 9 条 metadata），AI 用 `read` 从隐藏目录读 `core-concepts.md`
> - T46.13（同 session 换主题）: skill tool 调用 0 次，**cache_read=11776, input=653** —— system prompt 全缓存命中，AI 直接用已有上下文回答
> - **结论**：progressive disclosure 的"缓存"本质是 **system prompt 走 prompt cache**（input 低、cache_read 高）。resource 正文物化到隐藏目录后，AI 按需用 `read` 读取，不经过 `skill` tool。

---

## 七、已知噪声

### N46.1 SaaS progressive disclosure 自动处理大 skill

**机制**（同 [`session-skill-resources.md`](../../../docs/session-skill-resources.md)）：
- system prompt 只注入 `<preloaded_skills>` manifest（name/description + 9 个 resource 的 path/type/size/digest 元数据）
- AI 第一次需要时调内置 `skill` tool（input 只有 `{"name":"mastra"}`）→ 返回 SKILL.md 完整 content + `resource_directory` 隐藏目录路径 + resource 元数据
- resource 正文物化到 `/home/sandbox/.local/share/opencode/session-skills/` 隐藏目录，AI 用 `read`/`bash` 按需读取
- 后续 message 缓存命中，不重复调 `skill` tool

**结论**：注册 50KB 完整 skill bundle（6KB SKILL.md + 9 resources）不会挤压 system prompt，resource 正文也不进入 `skill` tool output。

### N46.2 网络依赖（remote-docs 模式）

**症状**：当 `node_modules/@mastra/` 不存在时，AI 走 remote-docs（`curl mastra.ai/...`），响应慢且依赖网络。

**影响**：网络抖动可能导致 AI 拿不到文档，回答偏离当前 API。

**缓解**：项目里预装 `@mastra/core` 等包，让 AI 走 embedded-docs（`cat node_modules/@mastra/*/dist/docs/`）。

### N46.3 bash 工具粒度难审计

**症状**：Skill 模式下 AI 可以执行任意 bash 命令（`npm install` / `npx create-mastra` / `curl` 等），审计粒度比 MCP 粗。

**缓解**：通过 session permission 限制 `bash` 允许的命令前缀（见 [`../26-session-agent-permissions.md`](../26-session-agent-permissions.md)）。

---

## 验收汇总

| 用例 | 结果 | 验证详情 |
|------|------|---------|
| T46.1 创建 session | ✅ | `new_sid -kb` 返回 ses_xxx |
| T46.2 验证沙箱 | ✅ | Node v24.18.0 + npm 11.16.0 + mastra.ai 200 |
| T46.3 注册 skill bundle | ✅ | PG `mastra\|6334\|9`；API resources 仅元数据无 content；PG 完整 content+size+digest |
| T46.4 AI 调用（基础 + resource 加载） | ✅ | 第一个 tool 是 `skill`，input 只有 name；output 含 resource_directory+metadata 无 content；AI 用 read 从隐藏目录读 reference |
| T46.5 创建 Mastra 项目 | ✅ | AI 用 read 读 create-mastra.md；npm install 508 packages；tsc 通过 |
| T46.6 写简单 Agent | ✅ | 确认已有 weather-agent.ts 符合要求 |
| T46.7 排查错误 | ✅ | AI 用 read 读 common-errors.md；逐项检查 tsconfig/package.json |
| T46.8 用 provider-registry | ✅ | bash 跑 `node resource_directory/scripts/provider-registry.mjs`；列出 15 个 model |
| T46.9 异常处理（无 node_modules） | ✅ | AI 用 read 读 remote-docs.md；走 remote-docs 路径 |
| T46.10 baseline token | ✅ | 无 skill 时 sum=8673 tokens |
| T46.11 注册后 system prompt | ✅ | 注册 50KB bundle 后 `(input+cache_read)` 仅 +145 tokens（manifest 含 size/digest） |
| T46.12 触发时 skill tool | ✅ | 第一个 tool 是 `skill`，input 只有 name，output 8002c（远小于 52KB bundle） |
| T46.13 缓存命中 | ✅ | 同 session 再发，skill tool 0 次，cache_read=11776 |

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| 沙箱预装 | Node + npm + 网络可达 mastra.ai | ✅ |
| Skill 注册 | session_skill 表 content + 9 resources 完整持久化（含 size/digest） | ✅ |
| AI 感知 | message 显式触发 skill 后 AI 用 read/bash 从隐藏目录查文档 | ✅ |
| 真实执行 | bash/read 实际拉到当前 API 文档（embedded 或 remote） | ✅ |
| 模式差异 | 工具类型为 `skill` + `read`/`bash`（不是 `mastra_*`） | ✅ |
| Progressive Disclosure | system prompt 仅 manifest；resource 正文物化到隐藏目录；AI 用 read 按需读取；缓存命中 | ✅ |

---

## 测试命令汇总

```bash
# 环境（组合 3：本地 PG + 本地 OpenSandbox）
export BASE="http://localhost:14096"
export PG_URL="postgresql://local@127.0.0.1:15432/opencode"
export MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
export NO_PROXY=localhost,127.0.0.1
new_sid() {
  local sid
  sid=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  [ "${1:-}" = "-kb" ] && curl -s -X POST "$BASE/session/$sid/keep-alive" \
    -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' >/dev/null
  echo "$sid"
}

# 1. 创建 session + 启沙箱
SID=$(new_sid -kb)

# 2. 验证沙箱预装
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"node --version && curl -s -o /dev/null -w \"mastra=%{http_code}\\n\" https://mastra.ai/llms.txt"}'

# 3. Bundle 注册（SKILL.md + 9 resources，详见 T46.3）
python3 <<'PYEOF'
import json, os, re, urllib.request
SID = open("/tmp/mastra-run-sid.txt").read().strip()  # 替换为当前 SID
BASE = "http://localhost:14096"
SKILL_DIR = "docs/test-cases/skills/mastra"
content = open(f"{SKILL_DIR}/SKILL.md").read()
desc = re.search(r'^description:\s*"?(.+?)"?\s*$', content, re.MULTILINE).group(1).strip().rstrip('"')
resources = []
for sub in ["references", "scripts"]:
    for fname in sorted(os.listdir(f"{SKILL_DIR}/{sub}")):
        resources.append({"path": f"{sub}/{fname}",
                          "type": "script" if sub == "scripts" else "doc",
                          "content": open(f"{SKILL_DIR}/{sub}/{fname}").read()})
body = json.dumps({"name":"mastra","description":desc[:500],"content":content,"resources":resources}).encode()
req = urllib.request.Request(f"{BASE}/session/{SID}/skills/create", data=body, headers={'Content-Type':'application/json'})
print(urllib.request.urlopen(req).status)
PYEOF

# 4. AI 用 skill
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 mastra skill 告诉我 Mastra 是什么\"}],\"skills\":[\"mastra\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

# 5. PG 验证
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool' IN ('skill','bash','read')"
```

---

## 重跑记录 2026-08-08

> **环境**：本地 PG `postgresql://postgres:postgres@127.0.0.1:5433/opencode_test` + 容器 `opencode-saas-test` @ localhost:14096。model=Yd-DeepSeek/deepseek-v4-flash。
>
> **结果**：T46.1-13 全量重跑，**全部通过**。

| 用例 | 结果 | 重跑验证详情 |
|------|------|-------------|
| T46.1 创建 session | ✅ | `POST /session` 返回 ses_xxx + keep-alive boot |
| T46.2 验证沙箱 | ✅ | node v24.18.0 + npm 11.16.0 + mastra.ai/llms.txt 200（含 "Mastra is a framework..." 主入口）+ npm ping PONG |
| T46.3 注册 bundle | ✅ | 10 文件目录注册，id=ssk_xxx、resources=9、PG `mastra\|6334\|9` |
| T46.4 基础 + resource 加载 | ✅ | 第一个 tool 是 `skill`（input=`{"name":"mastra"}`，out=7958c 含 SKILL.md+manifest 无 resource 正文）；随后 read 隐藏目录 `.../references/core-concepts.md`；AI 用当前文档回答 Mastra 定义 + Agent/Workflow 对比表 |
| T46.5 创建项目 | ✅ | read create-mastra.md + bash（mkdir、npm init、`npm install -D typescript @types/node mastra@latest`、`npm approve-scripts esbuild`）+ write weather tool/agent/mastra 入口；`npx tsc --noEmit` 与 `npm run build` 通过；AI 返回 8 步创建步骤 + 文件树（规避交互式 `npm create mastra`） |
| T46.6 写 Agent | ✅ | 验证 API（`node resource_directory/scripts/provider-registry.mjs --provider openai` 确认 gpt-4o-mini + read node_modules `reference-agents-agent.md:450` 确认 model 字符串格式）；write weather-agent.ts（model=`"openai/gpt-4o-mini"`）+ 更新 .env；tsc + build 通过 |
| T46.7 排查错误 | ✅ | read common-errors.md（隐藏目录）；逐项对照 3 原因表格，定位根因 package.json `"type":"commonjs"` 应为 module |
| T46.8 provider-registry | ✅ | bash 跑 `node .../scripts/provider-registry.mjs`；列出 Anthropic 15 个 model（claude-sonnet-5/opus-5 等最新 ID） |
| T46.9 remote-docs 异常 | ✅ | read remote-docs.md；给出无 @mastra 包时的 3 步远程查文档流程（llms.txt 索引 + URL 模式） |
| T46.10 baseline | ✅ | sum=8707 |
| T46.11 注册后 system prompt | ✅ | 注册 50KB bundle 后 sum=8850，delta=143 ≤ 200（manifest 化） |
| T46.12 触发时 skill tool | ✅ | 第一个 tool 是 `skill`，out=7958c（远小于 52KB bundle），随后 read 隐藏目录 |
| T46.13 缓存命中 | ✅ | 同 session 换主题：skill/bash/read 调用 0 次，cache_read=12160 高位，AI 复用已加载 core-concepts.md |

> **清理**：测试 session 已全部删除（DELETE /session/$SID）。
