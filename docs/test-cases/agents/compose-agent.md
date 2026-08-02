# Compose Agent 编排测试

> 参考 MiMo-Code 的 Compose Agent 实现，验证 opencode SaaS API 能否通过 session agent + session skill 组合实现多步骤编排工作流。
>
> Compose Agent 核心思想：**不是代码层面的编排引擎，而是通过提示工程让 LLM 成为编排器**，使用 skill 作为指令集指导 LLM 按工作流执行。

## 测试环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

---

## T42.1 编排环境搭建：创建 Compose Agent + 编排技能

> **定位**：本节是 T42.2/T42.3 的**前置 fixture**（compose agent + 3 个编排技能的定义）。agent/skill 的 CRUD 通用验证由 T15.x/T16.x 覆盖（见 [`00-preamble.md` 附录 A](./00-preamble.md)），此处只验证 fixture 创建成功 + PG 落库。

创建一个简化版 compose agent，配合 3 个编排技能（plan → execute → review），验证 CRUD + PG 持久化。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"title":"compose-agent-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 1. 创建 compose agent（primary，拥有 skill + task + bash 权限）
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"compose",
    "description":"编排Agent，协调plan→execute→review工作流",
    "mode":"primary",
    "prompt":"你是 Compose Agent — 一个编排器，通过调用 compose 技能来协调工作流。\n\n规则：\n1. 收到任务后，先用 skill 工具加载 compose-plan 技能，制定计划\n2. 计划完成后，用 skill 工具加载 compose-execute 技能，分发子agent执行\n3. 执行完成后，用 skill 工具加载 compose-review 技能，进行代码审查\n4. 所有决策通过 compose:ask 技能路由给用户\n\n你必须按 plan → execute → review 顺序编排，不能跳过步骤。",
    "temperature":0.3,
    "permission":{"skill":"allow","task":"allow","bash":"allow","read":"allow","write":"allow","edit":"allow","glob":"allow","grep":"allow","todowrite":"allow"}
  }'

# 2. 创建 3 个编排技能
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"compose-plan",
    "description":"制定实现计划。当需要规划多步骤任务时使用。",
    "content":"# compose-plan\n\n## 规则\n1. 分析需求，拆解为独立任务\n2. 每个任务包含：目标、涉及文件、验证方法\n3. 将计划写入 /workspace/plan.md\n4. 计划完成后说【PLAN_COMPLETE】\n\n## 输出格式\n```markdown\n# 实现计划\n## Task 1: [标题]\n- 目标: ...\n- 文件: ...\n- 验证: ...\n```"
  }'

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"compose-execute",
    "description":"执行实现计划。读取plan.md，逐步执行每个任务。",
    "content":"# compose-execute\n\n## 规则\n1. 读取 /workspace/plan.md\n2. 按顺序执行每个 Task\n3. 每个 Task 完成后标记【TASK_N_DONE】\n4. 全部完成后说【EXECUTE_COMPLETE】\n5. 使用 write/edit/bash 工具实际执行代码变更"
  }'

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"compose-review",
    "description":"代码审查。验证实现是否符合计划，检查质量问题。",
    "content":"# compose-review\n\n## 规则\n1. 读取 /workspace/plan.md 了解预期\n2. 用 bash/read 工具检查实际实现\n3. 按以下维度审查：功能正确性、代码质量、测试覆盖\n4. 输出审查报告，说【REVIEW_COMPLETE】\n\n## 输出格式\n| 维度 | 状态 | 说明 |\n|------|------|------|"
  }'

# 验证
echo ">>> PG agents:"
psql "$PG_URL" -c \
  "SELECT name, mode FROM session_agents WHERE session_id='$SID';"

echo ">>> PG skills:"
psql "$PG_URL" -c \
  "SELECT name, description FROM session_skill WHERE session_id='$SID';"

echo ">>> API agents:"
curl -s "$BASE/session/$SID/agents" > /tmp/t261_agents.json
python3 -c "
import json
d=json.loads(open('/tmp/t261_agents.json').read(), strict=False)
compose=[a for a in d if a['name']=='compose']
print(f'  compose agent: {\"found\" if compose else \"missing\"}')"

echo ">>> API skills:"
curl -s "$BASE/session/$SID/skills" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(f'  skills: {[s[\"name\"] for s in d]}')"
```

**期望**：
- PG `session_agents` 含 `compose/primary`
- PG `session_skill` 含 3 个 `compose-plan`、`compose-execute`、`compose-review`
- API 列表合并了全局 agent + compose agent
- API skills 列表含 3 个编排技能

> ⚠️ **skill 命名约束**（2026-08-01 实测）：skill `name` 必须匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$`（`skill/index.ts:148`，1-64 个由连字符分隔的小写字母数字段），**不允许冒号 `:`**。原文档 `compose:plan` 等冒号命名会返回 400（`Expected a string matching the RegExp ...`）。本文档已改为连字符命名 `compose-plan` / `compose-execute` / `compose-review`。
>
> ⚠️ **todowrite 权限**（2026-08-01 实测）：compose agent 的 permission **必须包含 `todowrite: allow`**，否则编排流程中 `todowrite` 工具默认 `ask`，HTTP API 模式无人应答会**永远卡在 running**（与 subagent 权限卡住问题同因，见 `local-test-env.md` 常见问题表）。

---

## T42.2 Compose Agent 编排执行（plan → execute → review）

用 compose agent 执行一个简单的编程任务，验证 LLM 按编排流程调用 compose 技能。

```bash
# 使用 T42.1 创建的 SID
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请创建一个 Python 计算器模块：\n1. /workspace/calc.py — 包含 add, subtract, multiply, divide 四个函数\n2. /workspace/test_calc.py — 包含每个函数的测试\n3. 运行测试确认通过\n\n按照 compose 工作流执行：先用 compose-plan 制定计划，再用 compose-execute 执行，最后用 compose-review 审查。\"}],
    \"skills\":[\"compose-plan\",\"compose-execute\",\"compose-review\"],
    \"agent\":\"compose\",
    \"model\":$MODEL
  }" > /tmp/t262_ai.json

# 验证 AI 回复
python3 -c "
import json
d=json.loads(open('/tmp/t262_ai.json').read(), strict=False)
for p in d.get('parts',[]):
    t=p.get('type','')
    if t=='text': print(f'[text]: {p.get(\"text\",\"\")[:300]}')
    elif t=='tool': print(f'[tool]: {p.get(\"tool\",\"?\")}({p.get(\"state\",{}).get(\"status\",\"?\")})')
"

# PG 验证 skill tool 调用（应有 compose-plan/execute/review 的加载记录）
psql "$PG_URL" -c "
SELECT p.data->>'tool' as tool, p.data->'state'->>'status' as status,
       substring(p.data->'state'->>'output' from 1 for 80) as output
FROM part p JOIN message m ON p.message_id=m.id
WHERE m.session_id='$SID' AND p.data->>'type'='tool'
ORDER BY p.time_created;
"

# exec 验证文件是否创建
curl -s -m 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"ls -la /workspace/calc.py /workspace/test_calc.py 2>&1"}' > /tmp/t262_ls.json
python3 -c "import json;d=json.loads(open('/tmp/t262_ls.json').read(),strict=False);print(d.get('stdout',''))"

# exec 运行测试
curl -s -m 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace && python3 -m pytest test_calc.py -v 2>&1 || python3 test_calc.py 2>&1"}' > /tmp/t262_test.json
python3 -c "import json;d=json.loads(open('/tmp/t262_test.json').read(),strict=False);print(d.get('stdout','')[:500])"
```

**期望**：
- PG `part` 表有 `skill(completed)` 调用，output 含 `compose-plan` 等
- PG `part` 表有 `write(completed)` / `bash(completed)` 等工具调用
- exec 确认 `/workspace/calc.py` 和 `/workspace/test_calc.py` 存在
- 测试通过（add/subtract/multiply/divide 四个函数均正确）

---

## T42.3 Compose Agent 子 agent 分发（parallel）

验证 compose agent 通过 task 工具分发子 agent 并行执行独立任务。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"title":"compose-parallel-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建 compose agent + implementer subagent
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"compose","description":"编排器","mode":"primary",
    "prompt":"你是编排器。收到多个独立任务时，用 @implementer 子agent并行执行。每个任务一个 @implementer。",
    "temperature":0.3,
    "permission":{"task":"allow","bash":"allow","read":"allow","write":"allow","edit":"allow","skill":"allow","glob":"allow","grep":"allow","todowrite":"allow"}
  }' > /dev/null

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"implementer","description":"实现者子agent","mode":"subagent",
    "prompt":"你是实现者。按指令创建文件，简洁执行。",
    "temperature":0.3,
    "permission":{"bash":"allow","read":"allow","write":"allow","edit":"allow","glob":"allow","grep":"allow","todowrite":"allow"}
  }' > /dev/null

# 发送并行任务
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请同时执行以下两个独立任务，用 @implementer 并行分发：\n1. 创建 /workspace/hello.py 内容为 print('hello')\n2. 创建 /workspace/world.py 内容为 print('world')\"}],
    \"agent\":\"compose\",
    \"model\":$MODEL
  }" > /dev/null

# PG 验证 task 调用
psql "$PG_URL" -c "
SELECT p.data->>'tool' as tool, p.data->'state'->>'status' as status
FROM part p JOIN message m ON p.message_id=m.id
WHERE m.session_id='$SID' AND p.data->>'type'='tool' AND p.data->>'tool'='task'
ORDER BY p.time_created;
"

# exec 验证两个文件
curl -s -m 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"python3 /workspace/hello.py && python3 /workspace/world.py"}' > /tmp/t263_exec.json
python3 -c "import json;d=json.loads(open('/tmp/t263_exec.json').read(),strict=False);print(d.get('stdout',''))"
```

**期望**：
- PG `session_agents` 含 `compose(primary)` + `implementer(subagent)`
- PG `part` 表有 2 个 `task(completed)` 调用
- exec 输出 `hello\nworld`

---

## T42.4 编排隔离：compose 技能仅在 compose session 可见

> **去重说明**（2026-07-17）：session skill 跨 session 隔离的通用验证见 T15.18（附录 A G6）。本节仅需确认 compose 技能无特殊泄露路径——按 G6 模式：A 创建 `compose-plan`，B 的 skills 列表为 `[]`，PG `session_skill` 按 `session_id` 隔离。

**期望**：A 有 `compose-plan`，B 为 `[]`，PG 确认隔离

---

## T42.5 编排状态持久化：重启后 compose agent + skills 恢复

验证 compose agent 和 skills 在服务重启后仍可查询。

```bash
# 创建 session + agent + skill
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"compose-persist"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"compose","description":"编排器","mode":"primary","prompt":"编排"}' > /dev/null
curl -s -X POST "$BASE/session/$SID/skills/create" -H 'Content-Type: application/json' \
  -d '{"name":"compose-plan","description":"计划","content":"# Plan"}' > /dev/null

# PG 验证（重启前）
PG_AGENT_BEFORE=$(psql "$PG_URL" -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID'")
PG_SKILL_BEFORE=$(psql "$PG_URL" -t -A -c "SELECT COUNT(*) FROM session_skill WHERE session_id='$SID'")
echo "重启前: agent=$PG_AGENT_BEFORE, skill=$PG_SKILL_BEFORE"

# 重启
docker restart opencode-saas-test
sleep 12

# 重新配置权限
curl -s -X PATCH "$BASE/global/config" -H 'Content-Type: application/json' \
  -d '{"permission":{"bash":"allow","edit":"allow","write":"allow","glob":"allow","grep":"allow","list":"allow","read":"allow","webfetch":"allow"}}' > /dev/null

# PG 验证（重启后）
PG_AGENT_AFTER=$(psql "$PG_URL" -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID'")
PG_SKILL_AFTER=$(psql "$PG_URL" -t -A -c "SELECT COUNT(*) FROM session_skill WHERE session_id='$SID'")
echo "重启后: agent=$PG_AGENT_AFTER, skill=$PG_SKILL_AFTER"

# API 验证
curl -s "$BASE/session/$SID/agents" > /tmp/t265_agents.json
python3 -c "import json;d=json.loads(open('/tmp/t265_agents.json').read(),strict=False);print('compose:', any(a['name']=='compose' for a in d))"
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print('skills:', [s['name'] for s in d])"
```

**期望**：重启前后 PG 数量一致，API 仍能查到 compose agent 和 skills

---

## 验收汇总

| 用例 | 场景 | 验证层 | 结果 |
|------|------|--------|------|
| T42.1 | 创建 compose agent + 3 个编排技能 | HTTP + PG + API | |
| T42.2 | plan→execute→review 编排执行 | PG skill/tool 调用 + exec 验证文件 | |
| T42.3 | 子 agent 并行分发 | PG task 调用 + exec 验证 | |
| T42.4 | 编排技能 session 隔离 | PG + API | |
| T42.5 | 重启后持久化恢复 | PG + docker restart + API | |
