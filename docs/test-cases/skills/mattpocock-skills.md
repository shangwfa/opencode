# mattpocock Skills 集合端到端验证

> 验证用户把 [mattpocock/skills](https://github.com/mattpocock/skills) 工程师方法论 skill 集合批量接入 Session：每个 skill 独立成 session_skill，AI 按需调用对应方法论（TDD / debugging / code review / grilling 等）。
>
> 跟 [`agent-browser-skill.md`](./agent-browser-skill.md) / [`mastra-skill.md`](./mastra-skill.md) 不同：mattpocock 不是单一 skill bundle，而是 **10 个独立 skill 集合**，每个 skill 教 AI 一种"工程师方法论"。
>
> **本仓库只保留 README 重点推荐的 10 个核心 skill**（作者日常使用），完整 22 个见 https://github.com/mattpocock/skills。

## 三种 Skill 模式对比

| 维度 | agent-browser（操作型） | mastra（文档查询型） | **mattpocock（方法论型）** |
|------|---|---|---|
| Skill 数量 | 1 个（core） | 1 个（mastra） | **10 个独立 skill** |
| AI 主要操作 | bash 跑 CLI 驱动浏览器 | bash 查文档 / cat node_modules | **bash 跑工程实践**（写测试、debug、review） |
| Skill 内容 | 完整命令清单 | 教 AI 查文档 | 教 AI 按方法论流程做事 |
| 注册方式 | 单 bundle（SKILL.md + 12 resources） | 单 bundle（SKILL.md + 9 resources） | **批量注册 10 个 session_skill** |
| 触发方式 | `skills:["agent-browser"]` | `skills:["mastra"]` | `skills:["tdd"]` / `skills:["grill-me"]` 等按需触发 |

> **何时用 mattpocock skills**：希望 AI 按工程师最佳实践做事（写测试驱动开发、系统化 debug、严格 code review），而不是凭直觉乱写。

## Skill 集合信息（10 个核心 skill）

按 [README "Why These Skills Exist"](https://github.com/mattpocock/skills#why-these-skills-exist) 重点描述的 4 大问题域保留：

| 问题域 | User-invoked | Model-invoked | 用途 |
|---|---|---|---|
| **#1 Agent 没做对** | `grill-me` `grill-with-docs` | `grilling` | 面试式深挖需求 |
| **#2 太啰嗦** | `grill-with-docs` | — | 建立 CONTEXT.md 共享语言 |
| **#3 代码不工作** | — | `tdd` `diagnosing-bugs` | TDD + 系统化 debug |
| **#4 大泥球** | `to-spec` `improve-codebase-architecture` `implement` | `code-review` | 设计/重构/审查 |
| **必装配置** | `setup-matt-pocock-skills` | — | 一次性配置 issue tracker / 标签 |

### 各 skill 文件结构（示例：`tdd`）

```
mattpocock/tdd/
├── SKILL.md          3.2 KB  ← content（主入口）
├── mocking.md        1.5 KB  ← resource (doc)
├── tests.md          2.2 KB  ← resource (doc)
└── agents/openai.yaml         ← 忽略（OpenAI 平台 UI 配置）
```

> **目录组织**：所有 skill 平铺在 `mattpocock/` 一级下（无 engineering/productivity 中间层），跟仓库原始结构略有差异——本仓库只保留 10 个核心 skill，扁平化更清晰。
>
> **设计哲学**：每个 skill 小而精（< 10 KB），独立使用。Skill 间依赖：`grill-me` → `grilling`，`implement` → `tdd` + `code-review`。

---

## 接入流程概览

| 步骤 | 动作 | 章节 |
|------|------|------|
| 1. 创建 session | `new_sid -kb` 启动沙箱 | T47.1 |
| 2. 验证沙箱 | 确认 Node + git 可用 | T47.2 |
| 3. **批量注册 10 个 skill** | 遍历 `mattpocock/` 目录，每个子目录注册一个 session_skill | T47.3 |
| 4. AI 按需调用 | `prompt_async` 显式 `skills:["tdd"]` 等触发对应方法论 | T47.4-T47.9 |

**关键**：每个 skill 独立注册到 PG，system prompt 同时持有 10 个 manifest（共占 100-300 tokens，比单个 mastra bundle 还少）。

---

## 前置条件

### 1. 沙箱基础环境

| 资源 | 验证 |
|------|------|
| Node.js + npm | `node --version`（写测试用） |
| git | `git --version`（implement / code-review 用） |
| 测试框架（按需） | `npx vitest --version` / `npx jest --version` |

### 2. 测试环境变量与辅助函数

```bash
export BASE="http://localhost:14096"
export PG_URL="postgresql://local@127.0.0.1:15432/opencode"
export MODEL='{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}'
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
```

---

## 一、准备 session

### T47.1 创建 session 并启动沙箱

```bash
SID=$(new_sid -kb)
echo "SID: $SID"
```

---

## 二、验证沙箱预装

### T47.2 确认 Node + git 可用

```bash
exec_in_sandbox "$SID" 'node --version && npm --version && git --version'
# 可选：预装测试框架（T47.5 TDD 用）
exec_in_sandbox "$SID" 'cd /workspace && npm init -y && npm install vitest --save-dev 2>&1 | tail -1'
```

**期望**：Node ≥ 18，npm 可用，git 可用。

---

## 三、批量注册 10 个 skill

### T47.3 遍历 `mattpocock/` 目录批量注册

**前置**：把 mattpocock 仓库导出到本仓库（一次性，只保留 README 重点推荐的 10 个核心 skill）：

```bash
cd /tmp && rm -rf mattpocock-skills && git clone --depth 1 https://github.com/mattpocock/skills.git mattpocock-skills
mkdir -p docs/test-cases/skills/mattpocock

# 10 个核心 skill（README "Why These Skills Exist" 重点描述）
CORE_SKILLS=(
  productivity/grill-me
  productivity/grilling
  engineering/grill-with-docs
  engineering/tdd
  engineering/diagnosing-bugs
  engineering/code-review
  engineering/implement
  engineering/to-spec
  engineering/improve-codebase-architecture
  engineering/setup-matt-pocock-skills
)
for s in "${CORE_SKILLS[@]}"; do
  name=$(basename "$s")
  cp -R /tmp/mattpocock-skills/skills/$s docs/test-cases/skills/mattpocock/$name
done
rm -rf /tmp/mattpocock-skills

# 期望：mattpocock/ 下平铺 10 个 skill 目录（无 engineering/productivity 中间层）
ls docs/test-cases/skills/mattpocock | wc -l
```

**批量注册**（python 遍历 `mattpocock/` 一级子目录）：

```python
import json, os, re, urllib.request

BASE = "http://localhost:14096"
SID = "$SID"  # 替换为当前 session id
ROOT = "docs/test-cases/skills/mattpocock"

def parse_frontmatter(text):
    """从 SKILL.md frontmatter 提取 name + description"""
    m = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
    if not m: return None, None
    fm = m.group(1)
    name = re.search(r'^name:\s*(.+)$', fm, re.MULTILINE)
    desc = re.search(r'^description:\s*"?(.+?)"?\s*$', fm, re.MULTILINE)
    return (name.group(1).strip() if name else None,
            desc.group(1).strip().rstrip('"') if desc else None)

results = []
for skill_name in sorted(os.listdir(ROOT)):
    skill_dir = f"{ROOT}/{skill_name}"
    skill_md = f"{skill_dir}/SKILL.md"
    if not os.path.isfile(skill_md): continue

    content = open(skill_md).read()
    fm_name, fm_desc = parse_frontmatter(content)
    if not fm_name: continue  # 跳过没 frontmatter 的

    # 收集 resources：同级 .md（非 SKILL.md）+ scripts/*
    resources = []
    for fname in sorted(os.listdir(skill_dir)):
        full = f"{skill_dir}/{fname}"
        if fname == "SKILL.md" or fname == "agents" or not os.path.isfile(full): continue
        if fname.endswith(".md"):
            resources.append({"path": fname, "type": "doc", "content": open(full).read()})
    scripts_dir = f"{skill_dir}/scripts"
    if os.path.isdir(scripts_dir):
        for fname in sorted(os.listdir(scripts_dir)):
            resources.append({"path": f"scripts/{fname}", "type": "script",
                              "content": open(f"{scripts_dir}/{fname}").read()})

    body = json.dumps({
        "name": fm_name,
        "description": (fm_desc or "")[:500],
        "content": content,
        "resources": resources,
    }).encode()
    req = urllib.request.Request(f"{BASE}/session/{SID}/skills/create",
                                 data=body, headers={"Content-Type": "application/json"})
    try:
        r = urllib.request.urlopen(req)
        results.append((fm_name, len(content), len(resources), r.status))
    except Exception as e:
        results.append((fm_name, 0, 0, f"ERR:{e}"))

print(f"注册 {len(results)} 个 skill:")
for name, clen, rcount, status in results:
    print(f"  {name:35s} content={clen:6d}c resources={rcount} HTTP={status}")
```

```bash
# PG 验证：10 个 skill 全部入库
psql "$PG_URL" -t -A -c "SELECT count(*) FROM session_skill WHERE session_id='$SID'"
psql "$PG_URL" -t -c "SELECT name, length(content), jsonb_array_length(resources::jsonb) FROM session_skill WHERE session_id='$SID' ORDER BY name"
```

**期望**：
- 注册 10 个 skill 全部成功
- 每个 skill content 1-10 KB，resources 0-3 个
- PG `session_skill` 表新增 10 行

---

## 四、AI 按需调用方法论 skill

### T47.4 触发 `tdd` skill：红绿循环

```bash
BEFORE=$(curl -s "$BASE/session/$SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 tdd skill 在 /workspace/calc 写一个 add(a, b) 函数，要求严格按 red-green-refactor 循环：先写失败测试，跑测试看红，再写实现，跑测试看绿\"}],\"skills\":[\"tdd\"],\"model\":$MODEL}" \
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
        if (p.tool === "skill") console.log(`[${i}] skill ${s.status||"?"} input=${JSON.stringify(s.input||{}).slice(0,150)}`)
        else if (p.tool === "bash") console.log(`[${i}] bash ${s.status||"?"} ${(s.input?.command||"").slice(0,150)}`)
        else if (p.tool === "write" || p.tool === "edit") console.log(`[${i}] ${p.tool} ${s.status||"?"} ${(s.input?.path||s.input?.filePath||"").slice(0,80)}`)
      } else if (p.type === "text" && p.text?.trim()) {
        console.log(`[${i} ${role}] TEXT: ${p.text.slice(0,300)}`)
        if (role === "assistant") assistantDone = true
      }
    }
  }
  lastSeen = msgs.length
  if (assistantDone) break
  await new Promise(r => setTimeout(r, 5000))
}
'
```

**期望**（验证 AI 按 TDD 方法论流程）：
- AI 第一步调 `skill` tool 加载 `tdd` 的 SKILL.md（output 3KB 左右）
- **bash 调用顺序符合 red-green-refactor**：
  1. `write calc.test.ts`（先写测试）
  2. `npx vitest run`（跑测试看红 - FAIL）
  3. `write calc.ts`（最小实现）
  4. `npx vitest run`（跑测试看绿 - PASS）
- AI 文本回复明确标注当前在 red/green/refactor 哪一阶段

---

### T47.5 触发 `grill-me` skill：面试式深挖

**Prompt**：
```text
用 grill-me skill 帮我深挖一个设计：我想做一个"个人记账 App"。请按 skill 教诲 relentlessly interview 我（每次问 1-3 个具体问题，等我回答后再问下一轮），不要直接给方案
```

**期望**：
- AI 加载 `grill-me` SKILL.md（content 很小，147 字节，会引导到 `grilling` skill）
- AI 可能进一步调 `skill` tool 加载 `grilling`（model-invoked skill）
- AI **不直接给方案**，而是按 skill 教诲开始面试（每次问 1-3 个具体问题）

---

### T47.6 触发 `code-review` skill：双轴审查

**前置**：先在沙箱写一段有"味道"的代码：
```bash
exec_in_sandbox "$SID" 'mkdir -p /workspace/review-test && cat > /workspace/review-test/user.ts <<"EOF"
export class User {
  name: string
  age: number
  constructor(name: string, age: number) { this.name = name; this.age = age }
  // 保存到数据库
  async save() {
    const res = await fetch("/api/users", { method: "POST", body: JSON.stringify(this) })
    return res.json()
  }
  // 验证年龄
  validateAge() {
    if (this.age < 0) throw new Error("invalid")
    if (this.age > 150) throw new Error("too old")
    return true
  }
}
EOF'
```

**Prompt**：
```text
用 code-review skill 审查 /workspace/review-test/user.ts 的代码（按 skill 教诲的 Standards + Spec 双轴并行子 agent 审查）
```

**期望**：
- AI 加载 `code-review` SKILL.md（6.7 KB）
- AI 按 skill 教诲用 **双轴并行**（Standards + Spec）审查
- 输出包含具体代码味道（God class / 命名不规范 / 缺测试等）

---

### T47.7 触发 `diagnosing-bugs` skill：系统化 debug

**Prompt**：
```text
用 diagnosing-bugs skill 帮我排查一个 bug：/workspace/calc/calc.test.ts 跑 vitest 时偶尔失败，错误是 "Expected 5 but got 6"。按 skill 教诲的 reproduce → minimise → hypothesise → instrument → fix → regression-test 循环走
```

**期望**：
- AI 加载 `diagnosing-bugs` SKILL.md（8.5 KB）
- AI 按 6 步循环：先重现、再最小化、再假设、再插桩、再修复、最后回归测试

---

### T47.8 触发 `implement` skill：从 spec 到实现

**Prompt**：
```text
用 implement skill 实现一个简单功能：在 /workspace/calc 增加 sub(a,b) 函数。按 skill 教诲：先确认 spec，再在 pre-agreed seams 用 tdd，最后 code-review
```

**期望**：
- AI 加载 `implement` SKILL.md（433 字节，会路由到 `tdd` + `code-review`）
- AI 调 `skill` tool 加载子 skill（tdd, code-review）
- 完整流程：spec → tdd（red-green-refactor）→ code-review

---

### T47.9 异常处理：触发不存在的 skill

**Prompt**：
```text
用 non-existent-skill-name skill 帮我写代码
```

**期望**：
- AI 尝试调 `skill` tool with name="non-existent-skill-name"
- `skill` tool 返回错误 "Skill not found. Available skills: ..."
- AI 列出可用 skill 让用户重选

---

## 五、Progressive Disclosure 验证（多 skill 场景）

> 验证注册 10 个 skill 后 system prompt 几乎不变（manifest 化生效）。

### T47.10 baseline：无 skill 时 system prompt token 数

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

### T47.11 注册 10 个 skill 后 system prompt 变化

```bash
# 按 T47.3 批量注册到 $PD_SID（脚本同 T47.3）

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

**期望**：`(input + cache_read)` 增量 **≤ 1000 tokens**（10 个 manifest × 平均 30 tokens）。**所有 skill content 都不进 system prompt**。

> **多 skill 场景的 progressive disclosure 优势**：10 个 skill 共 100KB+ 内容，全量注入会撑爆 system prompt。manifest 化后只占几百 tokens，AI 按需通过 `skill` tool 加载需要的那个。

### T47.12 显式触发：AI 按 skill 名精确加载

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 tdd skill 告诉我什么是 red-green-refactor\"}],\"skills\":[\"tdd\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

sleep 60

curl -s "$BASE/session/$PD_SID/message" | bun -e '
const msgs = await new Response(Bun.stdin.stream()).json()
const before = '$BEFORE'
for (let i = before; i < msgs.length; i++) {
  for (const p of msgs[i].parts||[]) {
    if (p.type==="tool") {
      const s = p.state||{}
      console.log(`[${i}] ${p.tool} ${s.status||"?"} input=${JSON.stringify(s.input||{}).slice(0,150)}`)
    }
  }
}
'
```

**期望**：
- 第一个 TOOL 是 `skill`，input=`{"name":"tdd"}`（精确选了 tdd，不是其他 21 个）
- skill tool output ≈ 3200 字符（tdd SKILL.md）

### T47.13 同 session 换 skill：触发不同 skill

```bash
BEFORE=$(curl -s "$BASE/session/$PD_SID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")

# 换触发 grill-me（productivity 类）
curl -s -X POST "$BASE/session/$PD_SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 grill-me skill 告诉我它的使用场景\"}],\"skills\":[\"grill-me\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"

sleep 60

curl -s "$BASE/session/$PD_SID/message" | bun -e '
const msgs = await new Response(Bun.stdin.stream()).json()
const before = '$BEFORE'
let skillCalls = []
for (let i = before; i < msgs.length; i++) {
  for (const p of msgs[i].parts||[]) {
    if (p.type==="tool" && p.tool==="skill") {
      skillCalls.push(p.state?.input?.name)
    }
  }
}
console.log(`skill 调用: ${JSON.stringify(skillCalls)}`)
console.log(skillCalls.includes("grill-me") ? "✅ 精确切换到 grill-me" : "⚠️ 未触发 grill-me")
'
```

**期望**：AI 切换到 `grill-me` skill（不是 tdd）。**同 session 多 skill 共存**，按用户指定 skills 数组精确加载。

---

## 六、已知噪声

### N47.1 skill 间依赖（model-invoked）

**症状**：用户调用 `grill-me`（user-invoked）时，AI 会进一步调 `grilling`（model-invoked）；`implement` 会调 `tdd` + `code-review`。

**影响**：单次 prompt 可能触发多个 `skill` tool 调用（每个 skill 一次）。

**缓解**：SaaS 的 manifest 化让多 skill 调用也不会爆 system prompt，每个 skill content 独立加载到 assistant turn。

### N47.2 skill 内容偏哲学（不强制流程）

**症状**：mattpocock skill 教 AI"应该这么做"，但 AI 实际可能跳步（比如 TDD 时直接写实现 + 测试，不严格 red-green-refactor）。

**影响**：跟 agent-browser（CLI 强约束）/ mastra（API 强约束）不同，方法论 skill 依赖 AI 自觉遵循。

**缓解**：在 prompt 里**明确要求 AI 遵循 skill 流程**（如 T47.4 的 prompt 强调"严格按 red-green-refactor 循环"）。

---

## 验收汇总

| 用例 | 结果 | 验证详情 |
|------|------|---------|
| T47.1 创建 session | ✅ | `new_sid -kb` 返回 ses_xxx |
| T47.2 验证沙箱 | ✅ | Node + npm + git 可用 |
| T47.3 批量注册 | ✅ | 10 个 skill 全部入库（PG count=10） |
| T47.4 tdd skill | ✅ | bash 调用顺序：write test → vitest 红 → write impl → vitest 绿 |
| T47.5 grill-me skill | ✅ | AI 不直接给方案，开始面试式提问 |
| T47.6 code-review skill | ✅ | AI 按双轴并行审查，列出代码味道 |
| T47.7 diagnosing-bugs skill | ✅ | AI 按 6 步循环 debug |
| T47.8 implement skill | ✅ | AI 调用 tdd + code-review 子 skill |
| T47.9 异常处理 | ✅ | 不存在 skill 名返回 "Available skills: ..." |
| T47.10 baseline token | ✅ | 无 skill 时 `(input+cache_read)` ≈ 8700 |
| T47.11 注册后 system prompt | ✅ | 注册 10 个 skill 后增量 ≤ 1000 tokens |
| T47.12 精确触发 | ✅ | input 含 `{"name":"tdd"}`，加载 tdd SKILL.md |
| T47.13 多 skill 切换 | ✅ | 同 session 切换到 grill-me |

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| 沙箱预装 | Node + npm + git | ⬜ |
| 批量注册 | 10 个 skill 全部 session_skill 入库 | ⬜ |
| AI 感知 | 按 skills 数组精确加载对应 skill | ⬜ |
| 方法论执行 | AI 按 skill 教诲流程操作（不跳步） | ⬜ |
| 多 skill 共存 | 同 session 切换不同 skill 不互相干扰 | ⬜ |
| Progressive Disclosure | 10 个 manifest 占 system prompt ≤ 1000 tokens | ⬜ |

---

## 测试命令汇总

```bash
# 环境（组合 3）
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

# 2. 验证沙箱
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"node --version && npm --version && git --version"}'

# 3. 批量注册 10 个 skill（脚本同 T47.3）
python3 <<'PYEOF'
import json, os, re, urllib.request
SID = open("/tmp/mattpocock-run-sid.txt").read().strip()
BASE = "http://localhost:14096"
ROOT = "docs/test-cases/skills/mattpocock"

def parse_fm(text):
    m = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
    if not m: return None, None
    fm = m.group(1)
    name = re.search(r'^name:\s*(.+)$', fm, re.MULTILINE)
    desc = re.search(r'^description:\s*"?(.+?)"?\s*$', fm, re.MULTILINE)
    return (name.group(1).strip() if name else None,
            desc.group(1).strip().rstrip('"') if desc else None)

count = 0
for skill_name in sorted(os.listdir(ROOT)):
    skill_dir = f"{ROOT}/{skill_name}"
    skill_md = f"{skill_dir}/SKILL.md"
    if not os.path.isfile(skill_md): continue
    content = open(skill_md).read()
    fm_name, fm_desc = parse_fm(content)
    if not fm_name: continue
    resources = []
    for fname in sorted(os.listdir(skill_dir)):
        full = f"{skill_dir}/{fname}"
        if fname == "SKILL.md" or fname == "agents" or not os.path.isfile(full): continue
        if fname.endswith(".md"):
            resources.append({"path": fname, "type": "doc", "content": open(full).read()})
    body = json.dumps({"name": fm_name, "description": (fm_desc or "")[:500],
                       "content": content, "resources": resources}).encode()
    req = urllib.request.Request(f"{BASE}/session/{SID}/skills/create",
                                 data=body, headers={'Content-Type':'application/json'})
    urllib.request.urlopen(req)
    count += 1
print(f"注册 {count} 个 skill")
PYEOF

# 4. PG 验证
psql "$PG_URL" -t -A -c "SELECT count(*) FROM session_skill WHERE session_id='$SID'"

# 5. AI 用某个 skill（按需切换 skills 数组）
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 tdd skill 在 /workspace 写一个 add 函数\"}],\"skills\":[\"tdd\"],\"model\":$MODEL}" \
  -w "HTTP %{http_code}\n"
```

---

## 重跑记录 2026-08-08

> **环境**：本地 PG `postgresql://postgres:postgres@127.0.0.1:5433/opencode_test` + 容器 `opencode-saas-test` @ localhost:14096。model=Yd-DeepSeek/deepseek-v4-flash。
>
> **结果**：核心链路重跑通过（T47.3/4/5/13），与验收汇总一致。

| 用例 | 结果 | 重跑验证详情 |
|------|------|-------------|
| T47.3 批量注册 | ✅ | 遍历 `mattpocock/` 10 个子目录注册，全部 HTTP 200，PG count=10（tdd 3185c+2 resources、diagnosing-bugs 8471c+1、setup 6860c+5 等） |
| T47.4 tdd 红绿 | ✅ | skill 加载 tdd → read 物化 references → write package.json + calc.test.js（字面量 5 避免同义反复）→ `npm test` fail 1（add 未导出）→ write calc.js 最小实现 → `npm test` pass 1；AI 说明 refactor 属 review 阶段 |
| T47.5 grill-me | ✅ | grill-me prompt 触发后 AI 先加载 `grill-me` 再**链式加载 `grilling`**（grill-me 教 AI 用 grilling 执行审问式流程）——多 skill 链式依赖真实发生；AI 一次问一个问题，grep 找 React 代码（无则转向提问），发 `question`（Measured bottleneck），不直接给方案 |
| T47.13 多 skill 切换 | ✅ | 同一 session 从 tdd 切到 grill-me（+grilling），skill tool 按需加载不同 skill，无冲突 |

> **注意**：grill-me（147c）与 grilling（841c）是轻量 content skill——grill-me 内容极短，主要靠链式调 grilling 生效，验证了元 skill 依赖链。
>
> **清理**：测试 session 已删除。
