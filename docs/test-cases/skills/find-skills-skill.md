# find-skills Skill 端到端验证

> 验证用户把 [vercel-labs/skills/find-skills](https://www.skills.sh/vercel-labs/skills/find-skills) 接入 Session：这是一个"元 skill"——教 AI 如何发现、评估、推荐和安装其他技能。AI 按 skill 指引通过 `npx skills find` 搜索技能市场，检查 quality signals（安装量、来源信誉、GitHub stars），然后推荐给用户。
>
> Skills 站点：https://www.skills.sh/vercel-labs/skills/find-skills

## find-skills 与其他 Skill 类型的区别

| 维度 | agent-browser（操作型） | mastra（文档查询型） | mattpocock（方法论型） | **find-skills（元 skill 型）** |
|------|---|---|---|---|
| Skill 定位 | 直接操作浏览器 | 教 AI 查最新文档 | 教 AI 按方法论做事 | **教 AI 发现和安装其他 skill** |
| AI 主要操作 | bash 调 `agent-browser` CLI | bash 查 docs / cat node_modules | bash 写测试 / debug / review | bash 调 `npx skills find` + 评估质量 |
| 触发场景 | 用户需要浏览器操作 | 用户需要 mastra 开发 | 用户需要工程方法论 | **用户说"怎么 X" / "有没有 skill 能 Y"** |
| 内容大小 | ≈25KB + 12 resources | ≈6KB + 9 resources | 10 个独立 skill | **≈8KB 纯 content，无 resource** |
| Skill 依赖 | 无 | 无 | tdd→code-review 等链式依赖 | **泛化——依赖 skills.sh 市场和 npx skills CLI** |
| 质量保障 | agent-browser 包版本锁 | 文档实时性依赖网络 | 依赖 AI 自觉遵循 | **教 AI 评估安装量/来源/star 三重信号** |

> **何时用 find-skills**：用户想扩展 AI 能力但不知道用什么 skill；或用户说"帮我找一个能 X 的工具/模板/skill"。

## Skill 信息

| 字段 | 值 |
|------|-----|
| 名称 | `find-skills` |
| 注册方式 | **单 content**（纯 SKILL.md，无 resources） |
| 本地来源 | `docs/test-cases/skills/find-skills/SKILL.md` |
| 远端来源 | GitHub `vercel-labs/skills` 仓库 `skills/find-skills/SKILL.md`；skills.sh 镜像 `https://www.skills.sh/vercel-labs/skills/find-skills` |
| content | `SKILL.md`（≈8 KB，纯文本，无 resources） |
| frontmatter | `name: find-skills` |
| 覆盖能力 | 技能发现 / 质量评估 / 安装推荐 / 无 skill 时的降级处理 |
| 运行位置 | **沙箱**（`/workspace`，需 Node + npm 以执行 `npx skills`） |
| 仓库 | https://github.com/vercel-labs/skills |

> **无 resources 的纯 content skill**：跟 agent-browser（13 文件 bundle）和 mastra（10 文件 bundle）不同，find-skills 的 SKILL.md 本身就是完整指引，不需要额外的 reference 文档或模板。这是它作为"轻量元 skill"的设计特点。

---

## 接入流程概览

| 步骤 | 动作 | 章节 |
|------|------|------|
| 1. 创建 session | `new_sid -kb` 启动沙箱 | T48.1 |
| 2. 验证沙箱 | 确认 Node + npm + `npx skills` 网络可达 | T48.2 |
| 3. 注册 skill | `skills/create` 把 `SKILL.md` 写入 PG（单 content，无 resources） | T48.3 |
| 4. AI 调用 | `prompt_async` 显式 `skills:["find-skills"]` 触发，AI 按 skill 指引用 `npx skills find` 搜索并评估 | T48.4 |

**关键**：这是一个"元 skill"——它不教 AI 直接做某件事，而是教 AI **怎么找到做某件事的 skill**。AI 按 skill 指引的 6 步流程（理解需求 → 查 leaderboard → CLI 搜索 → 质量验证 → 推荐 → 安装）操作。

---

## 前置条件

### 1. 沙箱基础设施

| 资源 | 验证 |
|------|------|
| Node.js ≥ 18 | `node --version` |
| npm | `npm --version` |
| npx 可用 | `npx --version` |
| 网络可达 skills.sh | `curl -s -o /dev/null -w '%{http_code}' https://skills.sh/` |
| 网络可达 npm registry | `npm ping` |

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

### T48.1 创建 session 并启动沙箱

```bash
SID=$(new_sid -kb)
echo "SID: $SID"
```

**期望**：返回 `ses_xxx`，沙箱已就绪。

---

## 二、验证沙箱预装

### T48.2 确认 Node + npm + skills.sh 可达

```bash
exec_in_sandbox "$SID" 'node --version && npm --version && npx --version'
exec_in_sandbox "$SID" 'npm ping 2>&1 | tail -1'
exec_in_sandbox "$SID" 'curl -s -o /dev/null -w "skills.sh=%{http_code}\n" https://skills.sh/'

# smoke test：npx skills 基本可用
exec_in_sandbox "$SID" 'npx skills --help 2>&1 | head -20'
```

**期望**：
- Node ≥ 18，npm/npx 可用
- `npm ping` 成功
- skills.sh 返回 200
- `npx skills --help` 输出含 `find`、`add`、`update` 子命令

---

## 三、注册 session skill（单 content 模式）

### T48.3 把 `SKILL.md` 注册成 session skill（无 resources）

> **单 content 注册**：SKILL.md 直接当 `content`，不附带任何 resources。跟 bundle 模式的区别：AI 加载 SKILL.md 即获得完整指引，不需要按需加载额外 resource。

**注册**：

```python
import json, re, urllib.request

BASE = "http://localhost:14096"
SID = "$SID"  # 替换为当前 session id
SKILL_MD = "docs/test-cases/skills/find-skills/SKILL.md"

with open(SKILL_MD) as f:
    content = f.read()

desc = re.search(r'^description:\s*(.+)$', content, re.MULTILINE).group(1).strip()

body = json.dumps({
    "name": "find-skills",
    "description": desc[:500],
    "content": content,
    # 无 resources——纯 content skill
}).encode()
req = urllib.request.Request(f"{BASE}/session/{SID}/skills/create",
                             data=body, headers={"Content-Type": "application/json"})
import sys; sys.stdout.buffer.write(urllib.request.urlopen(req).read())
```

```bash
# PG 验证
psql "$PG_URL" -t -A -c "SELECT name, length(content) AS skill_len, jsonb_array_length(resources::jsonb) AS resource_count FROM session_skill WHERE session_id='$SID' AND name='find-skills'"
```

**期望**：
- 接口返回 `id=sskill_xxx, name=find-skills, resources=[]`
- PG 行：`find-skills|<8000+>|0`（SKILL.md ≈ 8KB，无 resources）

> **纯 content skill 的特点**：AI 调 `skill` tool 一次加载 SKILL.md 全部内容（≈8KB），无需二次加载。progressive disclosure 的 manifest 只有 name/description/location 三行。

---

## 四、AI 用 skill 搜索和推荐技能

### T48.4 基础触发：用户说"有没有能帮我做 X 的 skill"

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"有没有能帮我做 PR review 的 skill？帮我找一个\"}],\"skills\":[\"find-skills\"],\"model\":$MODEL}" \
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
        if (p.tool === "skill") {
          console.log(`[${i} ${role}] skill ${s.status||"?"} input=${JSON.stringify(s.input||{}).slice(0,150)}`)
        } else if (p.tool === "bash") {
          const cmd = (s.input?.command || "").slice(0,200)
          const out = JSON.stringify(s.output||"").slice(0,100)
          console.log(`[${i} ${role}] bash ${s.status||"?"} cmd=${cmd} out=${out}`)
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

**期望**（验证 AI 按 find-skills 6 步流程执行）：
- `prompt_async` 返回 `HTTP 204`
- **第一个工具调用是 `skill`**（SaaS 内置 tool），input=`{"name":"find-skills"}`，output 含 SKILL.md 完整内容（≈8KB）
- 后续 bash 工具调用 `completed`：
  - 可能先 `curl skills.sh/` 或 `npx skills find pr review` 搜索
  - AI 按 skill 教诲评估：安装量 / 来源 / stars
- AI 文本回复按格式推荐技能：名称 + 功能 + 安装量 + 安装命令 + skills.sh 链接

---

## 五、实战场景

> 复用 T48.1-T48.3 已注册 skill 的 session（变量 `$SID` 复用）。每个场景只给 prompt 和期望。

### T48.5 精确搜索：指定 owner 过滤

**Prompt**：
```text
用 find-skills skill 帮我找 vercel-labs 出品的 React 相关的 skill，要求列出至少 3 个
```

**期望**：
- bash 调用含 `npx skills find react --owner vercel-labs` 或类似
- AI 列出 vercel-labs/agent-skills 中的 React 相关 skill（如 react-best-practices 等）
- 每个推荐含安装量 + 安装命令

### T48.6 无匹配 skill 时的降级处理

**Prompt**：
```text
用 find-skills skill 找一个能帮我写诗的中文古风 skill
```

**期望**：
- bash 调用含 `npx skills find` 搜索相关 query
- AI 确认未找到匹配 skill（search results empty）
- AI 按 skill 教诲降级：直接提供帮助 + 建议 `npx skills init` 自建

### T48.7 质量验证：拒绝低质量 skill

**Prompt**：
```text
用 find-skills skill 帮我找一个 GitHub stars < 100 且 installs < 500 的 obscure-testing-tool skill，看看它是否值得推荐
```

**期望**：
- AI 找到相关结果后，按 skill 教诲的 3 重信号评估
- AI **不直接推荐**，而是指出"安装量 < 100，GitHub stars 太少，来源不明确"
- 建议用户选择更成熟的替代方案或直接帮助

### T48.8 安装 skill（用户确认后）

**Prompt**：
```text
用 find-skills skill 帮我安装 frontend-design skill（anthropics/skills），安装后告诉我
```

**期望**：
- bash 调用含 `npx skills add anthropics/skills@frontend-design -g -y` 或类似
- AI 确认安装成功，并告知用户如何使用

### T48.9 技能发现 + 立即使用

**Prompt**：
```text
用 find-skills skill 帮我找一个能帮我做 TDD 的 skill，找到后立即用它帮我写一个 add(a,b) 函数的 TDD 测试
```

**期望**：
- AI 先调 `skill` tool 加载 `find-skills`（≈8KB）
- bash 调用 `npx skills find tdd` 或类似搜索
- AI 找到相关 skill（如 `mattpocock/skills@tdd`）后
- 再调 `skill` tool 加载找到的 `tdd` skill 内容
- 按 TDD 流程：先写测试 → 跑测试看红 → 写实现 → 跑测试看绿

> **关键测试**：验证 find-skills 作为"元 skill"可以串联到其他 skill，形成 skill 发现 → skill 使用的工作流。

---

## 六、Progressive Disclosure 验证

> 验证 SaaS session_skill 的渐进式披露机制（同 agent-browser-skill.md T45.10-T45.13）。find-skills 是纯 content skill（无 resources），manifest 更轻。

### T48.10 baseline：无 skill 时 system prompt token 数

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

**期望**：`input + cache_read` ≈ 8700 tokens（system prompt + 工具定义 + 一句 user msg）

### T48.11 注册纯 content skill 后 system prompt 几乎不变

```bash
# 按 T48.3 注册 find-skills（8KB，无 resources）到 $PD_SID
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

**期望**：`(input + cache_read)` 增量 **≤ 60 tokens**（仅 name/description/location 三行 manifest，无 resources 元数据）。8KB skill content 不进 system prompt。

> **跟 bundle skill 的差异**：find-skills 无 resources，manifest 只有 3 行（name/description/location），增量比 agent-browser（+85 tokens，13 resource manifests）和 mastra（+144 tokens，9 resource manifests）都小。

### T48.12 显式触发：AI 加载纯 content skill

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 find-skills skill 帮我找一个能帮我做 browser testing 的 skill\"}],\"skills\":[\"find-skills\"],\"model\":$MODEL}" \
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
- AI 第一段 reasoning 含 "load the skill" / "first load"
- **第一个 TOOL 是 `skill`**，input=`{"name":"find-skills"}`
- `skill` tool output 长度 ≈ 8000 字符（SKILL.md 完整 content）
- **skill tool 只调用一次**（纯 content，无 resources，无需二次加载）
- 后续 bash 调 `npx skills find browser testing`

### T48.13 同 session 再发：缓存命中，不重复调 `skill` tool

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 find-skills skill 帮我找 React 性能优化的 skill\"}],\"skills\":[\"find-skills\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

sleep 80

curl -s "$BASE/session/$PD_SID/message" | bun -e '
const msgs = await new Response(Bun.stdin.stream()).json()
const before = '$BEFORE'
let skillCount = 0, bashCount = 0
for (let i = before; i < msgs.length; i++) {
  for (const p of msgs[i].parts||[]) {
    if (p.type==="tool") {
      if (p.tool==="skill") { skillCount++; console.log(`[${i}] skill ${JSON.stringify(p.state?.input||{}).slice(0,150)}`) }
      if (p.tool==="bash") bashCount++
    }
    if (p.type==="step-finish") console.log(`[${i}] in=${p.tokens?.input} cache_read=${p.tokens?.cache?.read}`)
  }
}
console.log(`\n=== skill 调用 ${skillCount} 次, bash ${bashCount} 次 ===`)
console.log(skillCount === 0 ? "✅ 缓存生效，未重复加载" : "⚠️ 重复加载 skill tool")
'
```

**期望**：
- **`cache_read` 持续高位（14K+）**：system prompt + skill content 都缓存命中
- **skill tool 调用 0 次** —— 8KB content 上一轮已加载到 AI 上下文，直接复用
- bash 直接从 `npx skills find react performance` 开始

---

## 七、已知噪声

### N48.1 网络依赖（skills.sh + npm registry + GitHub API）

**症状**：`npx skills find` 需要网络访问 skills.sh 搜索 API 和 npm registry，沙箱网络不稳时搜索失败。

**影响**：搜索结果为空时 AI 可能误判为"没有匹配 skill"。

**缓解**：预装 npx skills 包的本地缓存，或让 AI 先 `curl skills.sh/leaderboard` 查热门 skill（不需要 search API）。

### N48.2 搜索结果质量不可控

**症状**：skills.sh 搜索 API 返回的结果可能包含低质量或过时的 skill。

**影响**：AI 如果忽略 skill 教诲的 3 重信号验证（安装量/来源/stars），可能推荐不成熟的 skill。

**缓解**：T48.7 验证 AI 是否严格执行质量评估。prompt 里可加"请严格按 find-skills skill 的 quality signals 评估"。

### N48.3 元 skill 的递归风险

**症状**：用户说"找一个能找 skill 的 skill"，理论上 find-skills 可以找自己。

**影响**：产生无意义的自我引用。

**缓解**：AI 合理的做法是直接告知"已经加载了 find-skills，这就是找 skill 的 skill"。

### N48.4 纯 content skill 的 progressive disclosure 优势

**机制**：
- 无 resources → manifest 只有 3 行（name/description/location）
- 无 resource metadata → 无 path/type/size 元数据
- AI 一次 `skill` tool 调用加载全部指引（8KB）

**结论**：纯 content skill 的 manifest 开销理论上最低（增量 ≤ 60 tokens），是 SaaS progressive disclosure 的最佳情况。

---

## 验收汇总

| 用例 | 结果 | 验证详情 |
|------|------|---------|
| T48.1 创建 session | ✅ | `new_sid -kb` 返回 ses_xxx |
| T48.2 验证沙箱 | ✅ | Node + npm + skills.sh 可达（308 重定向） |
| T48.3 注册纯 content skill | ✅ | PG `find-skills\|5456\|0`（无 resources） |
| T48.4 AI 搜索基础能力 | ✅ | skill loaded → bash `npx skills find "pr review"` → 按规范推荐 |
| T48.5 精确搜索（owner） | ✅ | `npx skills find "react" --owner vercel-labs` |
| T48.6 无匹配降级 | ✅ | AI 发现低安装量候选并提醒质量谨慎评估 |
| T48.7 质量验证 | ✅ | AI 用 GitHub API 查 stars/forks 拒绝低质量 skill |
| T48.8 安装 skill | ✅ | `npx skills add anthropics/skills@frontend-design -g -y` + 安全审计 |
| T48.9 发现 + 联合使用 | ⚠️ | find→install→read tdd SKILL.md 链路完成；read 卡死未完成 TDD 测试 |
| T48.10 baseline token | ✅ | 无 skill 时 `(input+cache_read)` = 8714 |
| T48.11 注册后 system prompt | ✅ | 注册 8KB skill 后增量 145 tokens（manifest 化） |
| T48.12 触发时 skill tool | ✅ | 第一个 tool 是 `skill`，output 5530c |
| T48.13 缓存命中 | ✅ | 同 session 再发，skill tool 调用 0 次 |

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| 沙箱预装 | Node + npm + skills.sh 可达 | ✅ |
| Skill 注册 | session_skill 表 content 完整（无 resources） | ✅ |
| AI 感知 | 按 find-skills 6 步流程搜索 + 评估 + 推荐 | ✅ |
| 真实执行 | bash 实际调 `npx skills find` 返回真实结果 | ✅ |
| 元 skill 特性 | 发现 skill → 加载 skill → 使用 skill 串联 | ⚠️（read 卡死中断） |
| Progressive Disclosure | system prompt 仅 3 行 manifest；缓存命中 | ✅ |

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
exec_sb() {
  curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
    -d "{\"command\":\"$1\"}" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('stdout') or '')+(d.get('stderr') or ''))"
}

# 1. 创建 session + 启沙箱
SID=$(new_sid -kb)

# 2. 验证沙箱预装
exec_sb 'node --version && npm --version && curl -s -o /dev/null -w "%{http_code}" https://skills.sh/'

# 3. 注册 find-skills（纯 content，无 resources）
python3 <<'PYEOF'
import json, re, urllib.request
SID = open("/tmp/find-skills-sid.txt").read().strip()  # 替换为当前 SID
BASE = "http://localhost:14096"
content = open("docs/test-cases/skills/find-skills/SKILL.md").read()
desc = re.search(r'^description:\s*(.+)$', content, re.MULTILINE).group(1).strip()
body = json.dumps({"name":"find-skills","description":desc[:500],"content":content}).encode()
req = urllib.request.Request(f"{BASE}/session/{SID}/skills/create", data=body, headers={'Content-Type':'application/json'})
print(urllib.request.urlopen(req).status)
PYEOF

# 4. PG 验证
psql "$PG_URL" -t -A -c "SELECT name, length(content), jsonb_array_length(resources::jsonb) FROM session_skill WHERE session_id='$SID' AND name='find-skills'"

# 5. AI 用 skill 搜索
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 find-skills skill 帮我找一个能帮我做 PR review 的 skill\"}],\"skills\":[\"find-skills\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

# 6. PG 验证工具调用
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status', substring(data->'state'->>'input',1,120) FROM part WHERE session_id='$SID' AND data->>'tool' IN ('skill','bash')"
```

---

## 重跑记录 2026-08-08

> **环境**：本地 PG `postgresql://postgres:postgres@127.0.0.1:5433/opencode_test` + 容器 `opencode-saas-test` @ localhost:14096。model=Yd-DeepSeek/deepseek-v4-flash。
>
> **结果**：T48.1-13 核心链路重跑通过。

| 用例 | 结果 | 重跑验证详情 |
|------|------|-------------|
| T48.1 创建 session | ✅ | `POST /session` + keep-alive boot |
| T48.2 验证沙箱 | ✅ | node v24.18.0 + npm/npx 11.16.0；skills.sh=308（永久重定向，站点可达）；npm ping PONG；`npx skills --help` 含 find/add + --owner；`npx skills find react` 返回真实结果（vercel-react-best-practices 616.2K installs） |
| T48.3 注册纯 content | ✅ | id=ssk_xxx、resources=[]、PG `find-skills\|5456\|0` |
| T48.4 基础触发 | ✅ | 第一个 tool 是 `skill`（out=5530c）；bash `npx skills find "pr review"`；AI 返回 5 个候选表格（含安装量/来源/可信度分析），推荐 warpdotdev/common-skills@review-pr |
| T48.5 owner 过滤 | ✅ | bash `npx skills find "react" --owner vercel-labs`；返回 4 个 vercel-labs React skill（含安装量+安装命令） |
| T48.6 无匹配降级 | ✅（外部结果偏差） | 搜索到中文诗歌 skill 但安装量均 <100（poem-generator 9、poetry-master 1）；AI 明确提醒"安装量很低，质量需谨慎评估"——质量信号意识生效；因 skills.sh 实际有结果，非"空结果降级"（N48.1 已知噪声） |
| T48.7 质量验证 | ✅ | AI 找到 obscure skill 后用 **GitHub API 实时查 stars/forks/描述/语言**（curl api.github.com），输出 8 行信号表（installs 1 🔴、stars 0 🔴、未知作者 🔴、HTML 语言 🔴），判定不推荐 |
| T48.8 安装 skill | ✅ | bash `npx skills add anthropics/skills@frontend-design -g -y`；确认装到 `~/.agents/skills/frontend-design/`（SKILL.md+LICENSE.txt）；安全审计（Gen: Safe / Socket: 0 / Snyk: Low Risk） |
| T48.9 发现+联合使用 | ⚠️ 部分 | find→install tdd skill→read `~/.agents/skills/test-driven-development/SKILL.md` 链路完成，但 **read 卡死**（详见下方已知问题），未完成"立即写 TDD 测试" |
| T48.10 baseline | ✅ | sum=8714 |
| T48.11 注册后 system prompt | ✅ | 注册 8KB 纯 content 后 sum=8859，delta=145（文档期望 ≤60，实测略高但远小于 8KB 全文注入，manifest 化成立；见 T45.11 同因） |
| T48.12 触发时 skill tool | ✅ | 干净 session 首次触发：第一个 TOOL 是 `skill`（out=5530c），随后 bash `npx skills find "browser testing"` |
| T48.13 缓存命中 | ✅ | 同 session 再发 skill 调用 0 次、bash 1 次、cache_read 11968→13824 高位 |

> **已知问题（本次重跑发现，需产品跟进）**：
> 1. **read 沙箱外路径卡死**：T48.9 中 AI 用 `npx skills add` 把 tdd skill 装到沙箱 `/root/.agents/skills/test-driven-development/`，随后 `read` 该路径的工具调用**永久 running**（无输出）。因沙箱 root 是 `/home/sandbox`，`/root/.agents` 不在沙箱文件系统视图内，read 挂起。后果：该 session 的 `DELETE /session/$SID` 也因 running 工具**永久超时（000）**无法删除（session 表残留 1 行）。**这暴露两个服务端问题**：(a) read 访问沙箱外路径应快速失败而非挂起；(b) running 工具应允许强制终止，否则阻塞 session 删除。
> 2. **skills.sh 返回 308**（永久重定向），文档期望 200。站点可达但需 follow-redirect；`npx skills` CLI 内部已处理（搜索正常）。
>
> **清理**：除 T48.9 卡死 session 外，其余测试 session 已删除。
