# humanize-ppt Skill 端到端验证

> 验证用户把 [LearnPrompt/humanize-ppt](https://github.com/LearnPrompt/humanize-ppt) 演讲型 PPT 大纲编排 skill 接入 Session：把 `SKILL.md` + 14 个 references + 10 个 scripts + 8 个 contracts + 4 个 adapters 通过 REST API 注册成 skill bundle，AI 按 skill 指引生成 AST 大纲、per-page 媒体决策、production brief，并执行演讲体检（QA checkup）。
>
> 官方仓库：https://github.com/LearnPrompt/humanize-ppt

## Skill 信息

| 字段 | 值 |
|------|-----|
| 名称 | `humanize-ppt` |
| 注册方式 | **Bundle**（SKILL.md 当 content + references/scripts/contracts/adapters 当 resources） |
| 本地来源 | `docs/test-cases/skills/humanize-ppt/`（39 个文件） |
| content | `SKILL.md`（≈16 KB，主入口，定义 OPC 工作流和输出契约） |
| resources | 36 个：14 个 `references/*.md`（doc）+ 10 个 `scripts/*.py`（script）+ 8 个 `contracts/*`（doc/asset）+ 4 个 `adapters/*.md`（doc） |
| frontmatter | `name: humanize-ppt`，`version: 1.1.2`，`license: MIT` |
| 覆盖能力 | AST 大纲 / per-page 媒体决策 / production brief / 演讲体检 / style gallery / presenter shell |
| 核心定位 | **不是渲染器**，是大纲编排器 + 演讲体检器；下游渲染器（guizang / frontend-slides / ppt-master）负责渲染 |
| 运行位置 | **沙箱**（`/workspace`） |

> **Skill 设计核心**：PPT 不是信息容器，而是 Audience-State-Transfer 工件。Humanize PPT 负责把原始素材变成可演讲的大纲 + per-page 媒体决策 + production brief，交给下游渲染器生成 deck，再对渲染结果做最多 3 轮演讲体检。

> **SaaS progressive disclosure 机制**（同 [`session-skill-resources.md`](../../../docs/session-skill-resources.md)）：
> 1. **system prompt 仅注入 `<preloaded_skills>` manifest**：name/description + 36 个 resource 的 path/type/size/digest 元数据
> 2. **第一层按需加载**：AI 调 `skill` tool with `{"name":"humanize-ppt"}` → 返回 SKILL.md 完整 content（16KB） + `resource_directory` 隐藏目录路径 + 36 个 resource 元数据
> 3. **第二层按需加载**：AI 用 `read`/`bash` 从 `resource_directory` 读取所需 reference/script（如 `read resource_directory/references/qa-failure-modes.md`、`node resource_directory/scripts/smoke_check.py`）

---

## 接入流程概览

| 步骤 | 动作 | 章节 |
|------|------|------|
| 1. 创建 session | `new_sid -kb` 启动沙箱 | T48.1 |
| 2. 验证沙箱 | 确认 Python + Node 可用 | T48.2 |
| 3. 注册 skill bundle | `skills/create` 把 `SKILL.md` + 36 个 resources 写入 PG | T48.3 |
| 4. AI 生成大纲 | `prompt_async` 显式 `skills:["humanize-ppt"]` 触发，AI 调 skill tool 加载 SKILL.md，按 OPC 工作流生成 brief | T48.4 |
| 5. 演讲体检 | AI 用 `--qa-from` 对模拟 deck 做演讲体检 | T48.5 |
| 6. 执行脚本 | AI 从隐藏目录执行 `smoke_check.py` | T48.6 |

---

## 前置条件

### 1. 沙箱基础环境

| 资源 | 验证 |
|------|------|
| Python 3 | `python3 --version`（scripts/*.py 依赖） |
| Node.js | `node --version`（沙箱默认预装） |

### 2. 测试环境变量与辅助函数

```bash
export BASE="http://localhost:14096"
export PG_URL="postgresql://app:8zuhlMLd4gaeUG5k@127.0.0.1:15432/opencode"
export MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
export NO_PROXY=localhost,127.0.0.1

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

### T48.1 创建 session 并启动沙箱

```bash
SID=$(new_sid -kb)
echo "SID: $SID"
```

**期望**：返回 `ses_xxx`，沙箱已就绪。

---

## 二、验证沙箱预装

### T48.2 确认 Python + Node 可用

```bash
exec_in_sandbox "$SID" 'python3 --version && node --version'
```

**期望**：Python ≥ 3.8，Node ≥ 18。

---

## 三、注册 session skill（Bundle 模式）

### T48.3 把 `humanize-ppt/` 目录整体注册成 skill bundle

**注册**（用 python3 安全构造 body）：

```python
import json, os, re, urllib.request

BASE = "http://localhost:14096"
SID = "$SID"  # 替换为当前 session id
SKILL_DIR = "docs/test-cases/skills/humanize-ppt"

# 1) SKILL.md 当 content
with open(f"{SKILL_DIR}/SKILL.md") as f:
    content = f.read()

# 2) 从 SKILL.md frontmatter 提取 description
desc_match = re.search(r'^description:\s*>-?\s*\n((?:\s+.+\n)+)', content, re.MULTILINE)
desc = " ".join(line.strip() for line in desc_match.group(1).split("\n")) if desc_match else ""

# 3) 收集 resources：references/*.md → doc, scripts/*.py → script, contracts/* → doc, adapters/*.md → doc
resources = []
for sub in ["references", "scripts", "contracts", "adapters"]:
    sub_dir = f"{SKILL_DIR}/{sub}"
    if not os.path.isdir(sub_dir):
        continue
    for fname in sorted(os.listdir(sub_dir)):
        fpath = f"{sub_dir}/{fname}"
        if not os.path.isfile(fpath):
            continue
        ext = os.path.splitext(fname)[1]
        rtype = "script" if ext in (".py", ".mjs", ".js", ".ts", ".sh") else "doc"
        with open(fpath) as f:
            resources.append({
                "path": f"{sub}/{fname}",
                "type": rtype,
                "content": f.read(),
            })

# 4) POST 注册
body = json.dumps({
    "name": "humanize-ppt",
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
psql "$PG_URL" -t -A -c "SELECT name, length(content) AS skill_md_len, jsonb_array_length(resources::jsonb) AS resource_count FROM session_skill WHERE session_id='$SID' AND name='humanize-ppt'"
```

**期望**：
- 接口返回 `name=humanize-ppt, resources[36]`
- API 响应 resources 只有 `path/type/size/digest`，**无 content**
- PG 行：`humanize-ppt|<16000+>|36`（SKILL.md ≈ 16KB + 36 个 resources）
- PG 中每个 resource 有完整 content + size + digest

> **resource type 自动判定**：`scripts/*.py` → script（扩展名匹配），`.md` / `.json` / `.template.md` → doc。

---

## 四、AI 用 skill 生成大纲

### T48.4 显式触发 skill + 生成 AST 大纲

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 humanize-ppt skill 帮我把以下素材做成一份演讲大纲。素材：AI 编程工具正在改变开发者的工作方式。从 GitHub Copilot 到 Cursor 到 opencode，AI 编程工具经历了三个阶段：代码补全、对话式编程、自主编程 agent。每个阶段都让开发者更高效，但也带来了新的挑战：代码质量、安全性、团队协作。请按 skill 教诲的 AST（Audience-State-Transfer）方法生成大纲。\"}],\"skills\":[\"humanize-ppt\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

# 轮询：等到 AI 输出 assistant 文本
bun -e '
const SID = "'$SID'"
const BASE = "http://localhost:14096"
const START = '$BEFORE'
const start = Date.now()
let lastSeen = START
let assistantDone = false
while (Date.now() - start < 180000) {
  const msgs = await (await fetch(BASE + "/session/" + SID + "/message")).json()
  for (let i = lastSeen; i < msgs.length; i++) {
    const m = msgs[i]
    const role = m.role || m.info?.role || "?"
    for (const p of m.parts || []) {
      if (p.type === "tool") {
        const s = p.state || {}
        if (p.tool === "skill") console.log(`[${i}] skill ${s.status||"?"} input=${JSON.stringify(s.input||{}).slice(0,200)}`)
        else if (p.tool === "bash") console.log(`[${i}] bash ${s.status||"?"} ${(s.input?.command||"").slice(0,150)}`)
        else if (p.tool === "read") console.log(`[${i}] read ${s.status||"?"} ${(s.input?.filePath||"").slice(0,150)}`)
        else if (p.tool === "write") console.log(`[${i}] write ${s.status||"?"} ${(s.input?.filePath||"").slice(0,80)}`)
        else console.log(`[${i}] ${p.tool} ${s.status||"?"}`)
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

**期望**（关键验证：skill tool 协议 + resource 正文物化 + AI 从隐藏目录读取）：
- `prompt_async` 返回 `HTTP 204`
- **第一个工具调用是 `skill`**，input 为 `{"name":"humanize-ppt"}`（无 `resources` 参数）
- skill tool output 含 SKILL.md 完整 content（≈16KB） + `<resource_directory>` 隐藏目录路径 + 36 个 resource 的 path/type/size/digest 元数据，**不含 resource 正文**
- AI 按需用 `read` 从隐藏目录读取 reference（如 `references/qa-failure-modes.md`）或用 `bash` 执行 script（如 `scripts/smoke_check.py`）
- AI 生成 AST 大纲，包含：
  - audience 分析（谁是听众、已知什么、抵抗什么）
  - state transfer 路径（从初始状态到目标状态）
  - per-page 媒体决策（哪些页需要图片/SVG/视频）
- 所有 `read`/`bash` 的资源路径位于 `/home/sandbox/.local/share/opencode/session-skills/`，不在 `/workspace`

> **验证 resource content 不泄漏**：用 PG 查询 skill tool output，确认不含 references 中的关键内容片段（如 "FAILURE_MODES"、"AST theory" 等）。

```bash
# PG 验证：skill tool output 不含 resource content
psql "$PG_URL" -t -A -c "
SELECT
  length(p.data->'state'->>'output') AS output_len,
  position('Audience-State-Transfer' IN p.data->'state'->>'output') > 0 AS has_skill_md_content,
  position('FAILURE_MODES' IN p.data->'state'->>'output') > 0 AS leaked_failure_modes,
  position('renderer_registry' IN p.data->'state'->>'output') > 0 AS leaked_registry
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id='$SID' AND p.data->>'tool'='skill'
ORDER BY m.time_created LIMIT 1;
"
```

**期望**：`has_skill_md_content=true`（SKILL.md 正文在 output 中），`leaked_failure_modes=false`，`leaked_registry=false`（resource 正文不泄漏）。

---

## 五、演讲体检（QA Checkup）

### T48.5 AI 用 `--qa-from` 对模拟 deck 做演讲体检

**前置**：先在沙箱创建一个模拟的 rendered HTML deck：

```bash
exec_in_sandbox "$SID" 'mkdir -p /workspace/test-deck && cat > /workspace/test-deck/index.html <<"DECKEOF"
<!DOCTYPE html><html><body>
<div class="slide" id="s1"><h1>AI 编程工具</h1><p>正在改变开发者的工作方式</p></div>
<div class="slide" id="s2"><h1>第一阶段：代码补全</h1><p>GitHub Copilot</p></div>
<div class="slide" id="s3"><h1>第二阶段：对话式编程</h1><p>Cursor</p></div>
<div class="slide" id="s4"><h1>第三阶段：自主编程 Agent</h1><p>opencode</p></div>
<div class="slide" id="s5"><h1>挑战</h1><p>代码质量、安全性、团队协作</p></div>
</body></html>
DECKEOF'
```

**Prompt**：
```text
用 humanize-ppt skill 对 /workspace/test-deck/index.html 做演讲体检（--qa-from）。按 skill 教诲的演讲体检流程：读取 rendered HTML，对照 AST 大纲逐页检查，识别不能演讲的页面，生成 qa_report.md 和 fix_prompt.md
```

**期望**：
- AI 调 `skill` tool（input 只有 name）加载 SKILL.md 获取体检流程指引
- AI 用 `read` 从隐藏目录读取 `references/qa-failure-modes.md` 了解失败模式定义
- AI 读取 `/workspace/test-deck/index.html`，逐页分析
- AI 生成 `qa_report.md`（识别不能演讲的页面）和 `fix_prompt.md`（修复指令）
- 体检结果包含具体的失败模式和修复建议

---

## 六、执行脚本

### T48.6 AI 从隐藏目录执行 `smoke_check.py`

**Prompt**：
```text
用 humanize-ppt skill 的 scripts/smoke_check.py 做一次 smoke check。脚本在 skill 返回的 resource_directory 中，用 bash 执行
```

**期望**：
- AI 调 `skill` tool 获取 `resource_directory`
- AI 用 `bash` 执行 `python3 resource_directory/scripts/smoke_check.py`
- 脚本执行成功（或输出有意义的错误信息，因为沙箱可能缺少完整依赖）

---

## 七、Progressive Disclosure 验证

### T48.7 baseline：无 skill 时 system prompt token 数

```bash
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

### T48.8 注册完整 skill bundle 后 system prompt 变化

```bash
# 按 T48.3 注册完整 bundle（SKILL.md 16KB + 36 resources 共 ≈200KB）到 $PD_SID
# ...（注册脚本同 T48.3，把 SID 替换为 PD_SID）

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

**期望**：`(input + cache_read)` 增量 **≤ 2000 tokens**（36 个 resource 的 manifest 元数据，每个约 30-50 tokens）。**200KB bundle 不进 system prompt**。

### T48.9 显式触发：AI 第一个 tool 是 `skill`

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 humanize-ppt skill 告诉我 AST 是什么\"}],\"skills\":[\"humanize-ppt\"],\"model\":$MODEL}" \
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
- **第一个 TOOL 是 `skill`**，input=`{"name":"humanize-ppt"}`（无 `resources` 参数）
- `skill` tool output 含 SKILL.md 完整 content（≈16KB） + `<resource_directory>` 隐藏目录路径 + 36 个 resource 的 path/type/size/digest 元数据
- output 长度远小于 200KB（完整 bundle 大小），因为 36 个 resource 正文不进入 output

### T48.10 同 session 再发：缓存命中

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 humanize-ppt skill 告诉我演讲体检的流程\"}],\"skills\":[\"humanize-ppt\"],\"model\":$MODEL}" \
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
- **`cache_read` 持续高位**：system prompt 走 prompt cache
- **skill tool 调用次数可能为 0**：AI 已有 SKILL.md 内容，直接回答；如果需要 reference 则用 `read` 从隐藏目录读取
- 如果 AI 需要查 reference（如 `qa-failure-modes.md`），用 `read` 而非 `skill` tool

---

## 八、异常处理

### T48.11 异常处理：触发不存在的 skill

**Prompt**：
```text
用 non-existent-skill-name skill 帮我做 PPT
```

**期望**：
- AI 从 system prompt manifest 直接判断不存在
- AI 列出可用 skill 让用户重选

---

## 验收汇总

| 用例 | 结果 | 验证详情 |
|------|------|---------|
| T48.1 创建 session | ✅ | `ses_0450ea5c6ffeBnRODNYFhUQKPG`，keep-alive boot 后沙箱就绪 |
| T48.2 验证沙箱 | ✅ | Python 3.12.3 + Node v24.18.0 |
| T48.3 注册 skill bundle | ✅ | PG `humanize-ppt\|15776\|37`（15 references + 10 scripts + 8 contracts + 4 adapters）；API resources 仅元数据无 content；37 资源含完整 content+size+digest |
| T48.4 AI 生成大纲 | ✅ | 第一个 tool 是 `skill`，input 只有 name；output 21827B 含 resource_directory+metadata 无 resource 正文；AI 用 6+ 次 read 从隐藏目录读 reference，生成 9 个交付物（deck_brief/ast_outline/slide_plan/speaker_intent/asset_manifest/video_slots/style_brief/outline-preview/run_manifest）到 /workspace |
| T48.5 演讲体检 | ✅ | AI read `/workspace/test-deck/index.html` + 隐藏目录 `references/qa-failure-modes.md` + `slide_plan.json`；生成 qa_report.md(5606B)+fix_prompt.md(6453B)+qa_iteration.json(2196B)；结论 fail（5 fail / 1 warn），含 P0/P1/P2 分级修复 |
| T48.6 执行脚本 | ✅ | AI 用 bash 执行隐藏目录 `scripts/smoke_check.py`，EXIT=0，三项检查全 passed（stable entrypoint / outline gate / exit-code matrix） |
| T48.7 baseline token | ✅ | input=3 cache_read=8704 sum=8707 |
| T48.8 注册后 system prompt | ✅ | 注册 335KB bundle 后 sum=8898，增量 **191 tokens** ≤ 2000（37 resources manifest 元数据，bundle 正文不进 prompt） |
| T48.9 精确触发 | ✅ | reasoning 首句 "Let me load the skill first"；第一个 TOOL 是 `skill`，input 只有 name；output 21827B（≈16KB，远小于 335KB bundle）含 resource_directory+resources 元数据 |
| T48.10 缓存命中 | ✅ | skill tool **0 次**、read/bash **0 次**（AI: "I already loaded the skill in the previous turn"）；cache_read=18048 高位 |
| T48.11 异常处理 | ✅ | AI 从 manifest 判断不存在，列出可用 skill（`humanize-ppt`）并让用户重选 |

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| 沙箱预装 | Python 3 + Node | ✅ Python 3.12.3 + Node v24.18.0 |
| Skill 注册 | 37 个 resources 完整持久化（含 size/digest） | ✅ PG `humanize-ppt\|15776\|37`，37 资源含 content+size+digest |
| AI 感知 | message 显式触发 skill 后 AI 按 OPC 工作流生成大纲 | ✅ AST 大纲 10 页 + 9 个交付物 |
| 资源物化 | resource 正文在隐藏目录，AI 用 read/bash 按需读取 | ✅ 物化 39 文件（SKILL.md+resources.json+37），AI 用 6+ 次 read 读 reference |
| 脚本执行 | AI 从隐藏目录执行 Python 脚本 | ✅ smoke_check.py EXIT=0 三项通过 |
| Progressive Disclosure | system prompt 仅 manifest；200KB 正文不进 prompt；缓存命中 | ✅ 增量 191 tokens；skill tool 21827B；缓存命中 0 次 skill 调用 |

---

## 测试命令汇总

```bash
# 环境
export BASE="http://localhost:14096"
export PG_URL="postgresql://app:8zuhlMLd4gaeUG5k@127.0.0.1:15432/opencode"
export MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
export NO_PROXY=localhost,127.0.0.1

# 1. 创建 session + 启沙箱
SID=$(new_sid -kb)

# 2. 验证沙箱
exec_in_sandbox "$SID" 'python3 --version && node --version'

# 3. Bundle 注册（SKILL.md + 36 resources，详见 T48.3）
python3 <<'PYEOF'
import json, os, re, urllib.request
SID = open("/tmp/humanize-ppt-run-sid.txt").read().strip()
BASE = "http://localhost:14096"
SKILL_DIR = "docs/test-cases/skills/humanize-ppt"
content = open(f"{SKILL_DIR}/SKILL.md").read()
desc_match = re.search(r'^description:\s*>-?\s*\n((?:\s+.+\n)+)', content, re.MULTILINE)
desc = " ".join(line.strip() for line in desc_match.group(1).split("\n")) if desc_match else ""
resources = []
for sub in ["references", "scripts", "contracts", "adapters"]:
    sub_dir = f"{SKILL_DIR}/{sub}"
    if not os.path.isdir(sub_dir): continue
    for fname in sorted(os.listdir(sub_dir)):
        fpath = f"{sub_dir}/{fname}"
        if not os.path.isfile(fpath): continue
        ext = os.path.splitext(fname)[1]
        rtype = "script" if ext in (".py", ".mjs", ".js", ".ts", ".sh") else "doc"
        resources.append({"path": f"{sub}/{fname}", "type": rtype,
                          "content": open(fpath).read()})
body = json.dumps({"name":"humanize-ppt","description":desc[:500],
                   "content":content,"resources":resources}).encode()
req = urllib.request.Request(f"{BASE}/session/{SID}/skills/create",
                             data=body, headers={'Content-Type':'application/json'})
print(urllib.request.urlopen(req).status)
PYEOF

# 4. PG 验证
psql "$PG_URL" -t -A -c "SELECT count(*) FROM session_skill WHERE session_id='$SID'"
psql "$PG_URL" -t -c "SELECT name, length(content), jsonb_array_length(resources::jsonb) FROM session_skill WHERE session_id='$SID' ORDER BY name"

# 5. AI 用 skill
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 humanize-ppt skill 告诉我 AST 是什么\"}],\"skills\":[\"humanize-ppt\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

# 6. PG 验证 tool 调用
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool' IN ('skill','bash','read','write')"

---

## 重跑记录 2026-08-08

> **环境**：本地 PG `postgresql://postgres:postgres@127.0.0.1:5433/opencode_test` + 容器 `opencode-saas-test` @ localhost:14096。model=zhipuai/glm-5.1。
>
> **结果**：核心链路重跑通过（T48.1-4/6），与验收汇总一致。

| 用例 | 结果 | 重跑验证详情 |
|------|------|-------------|
| T48.1 创建 session | ✅ | `POST /session` + keep-alive boot |
| T48.2 验证沙箱 | ✅ | Python 3.12.3 + Node v24.18.0 |
| T48.3 注册 bundle | ✅ | 39 文件目录注册，id=ssk_xxx、resources=37、PG `humanize-ppt\|15776\|37`（references/scripts/contracts/adapters 混合类型） |
| T48.4 触发 skill | ✅ | 第一个 tool 是 `skill`（input=`{"name":"humanize-ppt"}`，out=21799c 含 SKILL.md+manifest） |
| T48.6 执行 smoke_check | ✅ | bash 在物化目录 workdir 执行 `python3 scripts/smoke_check.py`（EXIT=0，out=679c），3 项检查全 passed：基础 brief（inline fixture）+ outline gate（preview→confirm→brief + unrelated-out-dir guard）+ exit-code 矩阵；AI 中文汇总 |

> **注意**：resource type 判定用扩展名——`.py/.mjs/.js/.ts/.sh` → script，其余 → doc（文档 T48.3 脚本一致）。contracts/*.json 归为 doc 是安全的（API 无 json 类型）。
>
> **清理**：测试 session 已删除。
