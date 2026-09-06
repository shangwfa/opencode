# Team Agent —— 用 Session Agents 模拟 dsh-agent-teams 多智能体团队

> **背景（2026-09-06）**：参考 [dsh-agent-teams](https://dshmarket.com/p/NanmiCoder/dsh-agent-teams/)（DeepSeek Harness 生态的多 agent 团队插件），验证其核心流程可**用 opencode SaaS 原生能力模拟**：`session agents`（`/session/:id/agents/create`）定义角色成员 + HTTP 指定 `agent` 发消息作为编排通道。相比依赖模型自主调 `task` 工具的 T16.16，本用例的编排**完全由 HTTP 控制面驱动**，不依赖模型主动调度，稳定可复现。

> 编号 T52（本域独立编号）。公共测试环境和配置见 [`00-preamble.md`](./00-preamble.md)。模型建议 Muse Spark 1.3（`opencode/muse-spark-1.3-contributor-free`）或任意工具调用正常模型。

## 能力对照（dsh-agent-teams → 本用例模拟）

| dsh-agent-teams 特性 | 本用例模拟方式 |
|---|---|
| Captain 当前会话建团队 | 1 个会话 + 若干角色 agent（primary/subagent 混合） |
| Durable 成员（可续接 sub-agent） | session agents 持久化（PG `session_agents`），可按名反复唤醒 |
| 依赖感知任务（DAG） | 编排器按依赖顺序依次唤醒角色，后一角色消息携带前一角色产出 |
| 角色委派 | 每角色独立 prompt/温度/权限（创建时固化） |
| Quality gate（review/repair） | reviewer 角色审查 → 缺陷反馈 → coder 修复循环 |
| 汇总归档 | lead（primary）汇总各角色产出；exec_log 留存团队活动记录 |

## 用例

### 公共变量

```bash
BASE="http://localhost:14096"
SPARK='{"providerID":"opencode","modelID":"muse-spark-1.3-contributor-free"}'
# source docs/test-cases/test-env.sh 3 && source docs/test-cases/test-lib.sh
```

### T52.1 组建团队：创建 captain 会话 + 三名角色成员

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"title":"team-agent-demo"}' | jexec "d['id']")

# lead：captain（primary，可被 HTTP 直接指定汇总）
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' -d '{
  "name":"lead","description":"团队队长","mode":"primary",
  "prompt":"你是团队队长(captain)。你的职责：接收用户目标，规划任务分工，最后汇总各成员产出为一份完整交付报告。每次回复先输出「[CAPTAIN]」。",
  "temperature":0.3}' | jexec "(d.get('name'), d.get('mode'))"

# analyst：需求分析（primary）
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' -d '{
  "name":"analyst","description":"需求分析师","mode":"primary",
  "prompt":"你是需求分析师。对给定需求输出：1) 功能要点  2) 边界与假设  3) 验收标准。不要写代码。",
  "temperature":0.3}' | jexec "(d.get('name'), d.get('mode'))"

# coder：实现者（subagent，只输出代码）
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' -d '{
  "name":"coder","description":"Python实现员","mode":"subagent",
  "prompt":"你是Python实现员。严格按输入的需求与验收标准实现，只输出可运行的 Python 代码块。",
  "temperature":0.3}' | jexec "(d.get('name'), d.get('mode'))"

# reviewer：审查者（subagent，质量门）
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' -d '{
  "name":"reviewer","description":"代码审查员","mode":"subagent",
  "prompt":"你是代码审查员。审查给定实现：输出 严重程度|问题|修复建议 列表。若发现问题输出 [NEEDS_FIX]，否则输出 [APPROVED]。",
  "temperature":0.3}' | jexec "(d.get('name'), d.get('mode'))"
```

**期望**：4 个 agent 创建成功；PG 持久化：

```bash
pgval "SELECT name || ':' || mode FROM session_agents WHERE session_id='$SID' ORDER BY name"
# 期望 4 行: analyst:primary / coder:subagent / lead:primary / reviewer:subagent
```

### T52.2 团队工单：captain 规划并发出任务（依赖顺序）

> 用 lead（captain）发消息把用户目标转成「含依赖顺序的团队工单」——这是控制面里 captain 委派的表达。

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"团队任务：为用户实现函数 divide(a,b)。分工顺序：analyst分析 → coder实现 → reviewer审查。请输出本团队工单（含成员与依赖顺序），不要执行。"}],"agent":"lead","model":$SPARK}' \
  | jexec "d['info'].get('agent')" | sed 's/^/agent: /'
```

**期望**：响应 `agent=lead`，回复以 `[CAPTAIN]` 开头并列出分工顺序

### T52.3 依赖任务 1——analyst 产出需求（无前置）

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"分析函数 divide(a,b)：两数相除。给出功能要点、边界假设（除零/负数/类型）、验收标准。"}],"agent":"analyst","model":$SPARK}' \
  -o /tmp/team-analyst.json
python3 -c "
import json; d=json.load(open('/tmp/team-analyst.json'),strict=False)
t=''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')
print('agent:', d['info'].get('agent'))
print('含验收标准:', '验收' in t or 'acceptance' in t.lower())
print('含除零边界:', '0' in t and ('除' in t or 'div' in t.lower() or 'zero' in t.lower()))
open('/tmp/team-analyst-out.txt','w').write(t)"
```

**期望**：analyst 回复含验收标准与除零边界；产出保存到 `/tmp/team-analyst-out.txt` 供下游依赖

### T52.4 依赖任务 2——coder 依据 analyst 分析实现（依赖满足）

```bash
ANALYSIS=$(cat /tmp/team-analyst-out.txt)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"依据以下需求分析实现 divide(a,b)：\n---\n$ANALYSIS\n---\n请实现函数并处理除零。\"}],\"agent\":\"coder\",\"model\":$SPARK}" \
  -o /tmp/team-coder.json
python3 -c "
import json; d=json.load(open('/tmp/team-coder.json'),strict=False)
t=''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')
code=t.split('\`\`\`')[1] if '\`\`\`' in t else t
print('agent:', d['info'].get('agent'))
print('含 def divide:', 'def divide' in t)
print('含除零处理:', 'raise' in t or 'ZeroDivisionError' in t or '== 0' in t or 'b == 0' in t)
open('/tmp/team-coder-out.txt','w').write(code)"
```

**期望**：coder 依据分析实现 `def divide`，处理除零；代码存 `/tmp/team-coder-out.txt`

### T52.5 依赖任务 3——reviewer 审查实现（质量门）

```bash
CODE=$(cat /tmp/team-coder-out.txt)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"审查以下 divide 实现，检查除零处理与边界：\n\`\`\`python\n$CODE\n\`\`\`\n若通过输出 [APPROVED]，否则输出 [NEEDS_FIX] 并给出修复建议。\"}],\"agent\":\"reviewer\",\"model\":$SPARK}" \
  | jexec "''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:300]" | sed 's/^/reviewer: /'
```

**期望**：reviewer 输出 `[APPROVED]`（或 `[NEEDS_FIX]` + 建议，进入 T52.6 修复循环）

### T52.6 质量门修复循环（可选，若 T52.5 为 NEEDS_FIX）

> reviewer 反馈作为 coder 的下一轮输入，实现修复，再交回 reviewer 复审——模拟 quality gate 的 repair/re-review。人工判定为 [APPROVED] 时此环节可跳过。

```bash
CODE=$(cat /tmp/team-coder-out.txt)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"reviewer 反馈需修复。修复以下实现后重新输出：\n\`\`\`python\n$CODE\n\`\`\`\n\"}],\"agent\":\"coder\",\"model\":$SPARK}" \
  | jexec "d['info'].get('agent')" | sed 's/^/fix agent: /'
```

**期望**：coder 产出修复版；审查通过后进入汇总

### T52.7 汇总归档：captain 汇总三角色产出

```bash
ANALYSIS=$(cat /tmp/team-analyst-out.txt); CODE=$(cat /tmp/team-coder-out.txt)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"汇总团队成员产出为最终交付报告（需求分析结论 + 最终代码 + 审查结论）：\n[分析] $ANALYSIS\n[实现] \`\`\`python\n$CODE\n\`\`\`\n\"}],\"agent\":\"lead\",\"model\":$SPARK}" \
  | jexec "(d['info'].get('agent'), len(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')))" | sed 's/^/汇总: /'
```

**期望**：lead 汇总含分析+代码+审查三段；该 agent 消息在消息树中留存（归档记录）

### T52.8 团队活动审计：exec_log 留存（归档痕迹）

```bash
psql "$PG_URL" -t -A -c "SELECT source, count(*) FROM exec_log WHERE session_id='$SID' GROUP BY source ORDER BY source" 2>/dev/null \
  | grep -E "agent-create|agent-clear" || pgval "SELECT count(*) FROM exec_log WHERE session_id='$SID' AND source LIKE 'agent%'"
```

**期望**：`agent-create` ≥ 4（4 名成员创建留痕）；消息树含 lead/analyst/coder/reviewer 各 agent 的 assistant 消息：

```bash
psql "$PG_URL" -t -A -c "SELECT count(DISTINCT m.agent) FROM message m JOIN session s ON s.id=m.session_id WHERE m.session_id='$SID'" 2>/dev/null \
  || pgval "SELECT count(DISTINCT agent) FROM message WHERE session_id='$SID'"
# 期望 ≥ 3（lead/analyst/coder/reviewer 中实际发过消息的 agent）
```

### T52.9 成员可续接：复用团队承接新任务（durable member 语义）

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"新任务：实现 multiply(a,b) 函数（可直接用 *）。"}],"agent":"coder","model":$SPARK}' \
  | jexec "d['info'].get('agent')" | sed 's/^/复用 coder: /'
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"把 multiply 实现加入团队交付记录，输出最终交付清单。"}],"agent":"lead","model":$SPARK}' \
  | jexec "(d['info'].get('agent'), ''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:100])" | sed 's/^/复用 lead: /'
```

**期望**：同一批 session agents 可反复唤醒承接新任务（会话内成员持久化，等价 durable sub-agent）

---

## 测试结果

| 用例 | 结果 | 备注 |
|------|------|------|
| T52.1 组建团队 | ✅ | 4 成员创建成功，PG session_agents count=4 |
| T52.2 captain 工单 | ✅ | agent=lead，回复含 [CAPTAIN] 与 analyst/coder/reviewer 分工 |
| T52.3 analyst 产出 | ✅ | agent=analyst，含验收标准与除零边界 |
| T52.4 coder 实现 | ✅ | agent=coder，依赖分析产出 `def divide` + 除零处理；脚本注意用 python 构造 JSON（shell 拼接会因特殊字符 Invalid JSON） |
| T52.5 reviewer 审查 | ✅ | 输出 [APPROVED]（质量门通过） |
| T52.6 修复循环 | — | T52.5 一次通过未触发；修复路径见文档（reviewer 反馈→coder→复审） |
| T52.7 汇总归档 | ✅ | agent=lead 汇总含代码+分析 |
| T52.8 审计留痕 | ✅ | exec_log agent-create=4；message 树 lead×2/analyst×1/coder×2/reviewer×2（data->>'role'='assistant'） |
| T52.9 成员复用 | ✅ | 同一 coder 会话内续接新任务（def multiply），成员持久化生效 |

> 复测记录（2026-09-06，merge upstream/dev v1.18.29 后，镜像 `t0906-merged-1.18.29`，组合 3，模型 `opencode/muse-spark-1.3-contributor-free`）：**T52 全部用例实测通过**。本套用例验证：openCode SaaS 原生能力（session agents + HTTP 指定 agent 发消息）可稳定编排「captain→多角色成员→依赖任务链→质量门→汇总归档→成员复用」的完整团队流程，作为 dsh-agent-teams 重型能力的轻量替代。要点：① primary 与 subagent 均可被 HTTP `agent` 参数直接唤醒（subagent 无需依赖模型自主调 task）；② 下游角色消息携带上游产出即实现「依赖感知」；③ 编排完全由控制面驱动，不依赖模型主动调度，规避了 deepseek/spark 工具调用消极的问题。
