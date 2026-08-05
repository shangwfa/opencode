# 01 — 创建 AI 团队

> **扣子场景**：创建项目工作空间 → 添加多个 Agent → 组建 AI 团队
>
> **opencode 映射**：创建 Session（= 项目工作空间）→ 配置多个 Session Agent（primary + subagent）→ 验证团队组建

## 公共配置

```bash
source ../test-env.sh 3
source ../test-lib.sh
```

## 一、创建项目工作空间（Session）

### ST.1.1 创建 Session（新品发布方案）

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"新品发布方案"}')

export TEAM_SID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
echo "Team Session: $TEAM_SID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'id' in d and d['id'].startswith('ses_')
print('✅ ST.1.1' if ok else '❌ ST.1.1 — ' + json.dumps(d)[:120])
"
```

**期望**：返回 `ses_` 前缀的 session ID

### ST.1.2 验证 Session 独立工作空间

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$TEAM_SID")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('id') == '$TEAM_SID' and d.get('title') == '新品发布方案'
print('✅ ST.1.2' if ok else '❌ ST.1.2 — ' + json.dumps(d)[:120])
"
```

**期望**：Session title 正确，ID 匹配

### ST.1.3 列出所有 Session

```bash
CNT=$(curl -s --noproxy '*' "$BASE/session" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$CNT" -ge 1 ] && pass "ST.1.3 列出Session" || fail "ST.1.3" "count=$CNT"
```

## 二、组建 AI 团队（配置多 Agent）

### ST.1.4 创建 Primary Agent — 项目经理

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$TEAM_SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "manager",
    "mode": "primary",
    "prompt": "你是项目经理，负责统筹新品发布方案。根据用户需求，将任务分配给合适的团队成员（subagent）执行。你可以调度 writer、analyst、designer 等角色。",
    "permission": { "read": "allow", "edit": "allow", "bash": "allow", "task": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'manager' and d.get('mode') == 'primary'
print('✅ ST.1.4' if ok else '❌ ST.1.4 — ' + json.dumps(d)[:120])
"
```

**期望**：返回 name=manager, mode=primary

### ST.1.5 创建 Subagent — 内容撰稿人

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$TEAM_SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "writer",
    "mode": "subagent",
    "prompt": "你是资深内容撰稿人，擅长撰写营销文案、新闻稿、产品介绍。收到任务后直接输出高质量文案。",
    "permission": { "read": "allow", "edit": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'writer' and d.get('mode') == 'subagent'
print('✅ ST.1.5' if ok else '❌ ST.1.5 — ' + json.dumps(d)[:120])
"
```

### ST.1.6 创建 Subagent — 数据分析师

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$TEAM_SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "analyst",
    "mode": "subagent",
    "prompt": "你是数据分析师，擅长市场分析、竞品调研、用户画像分析。用数据驱动决策。",
    "permission": { "read": "allow", "bash": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'analyst' and d.get('mode') == 'subagent'
print('✅ ST.1.6' if ok else '❌ ST.1.6 — ' + json.dumps(d)[:120])
"
```

### ST.1.7 创建 Subagent — 设计师

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$TEAM_SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "designer",
    "mode": "subagent",
    "prompt": "你是视觉设计师，负责产品视觉方案、海报设计描述、UI 交互建议。输出设计思路和描述。",
    "permission": { "read": "allow", "edit": "allow" }
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('name') == 'designer' and d.get('mode') == 'subagent'
print('✅ ST.1.7' if ok else '❌ ST.1.7 — ' + json.dumps(d)[:120])
"
```

## 三、验证团队阵容

### ST.1.8 列出 Session Agent — 团队完整

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$TEAM_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
names = [a.get('name','') for a in d]
# 应包含全局默认 agent + 4 个会话级 agent
has_team = all(n in names for n in ['manager','writer','analyst','designer'])
primary_count = sum(1 for a in d if a.get('mode') == 'primary')
subagent_count = sum(1 for a in d if a.get('mode') == 'subagent')
ok = has_team and primary_count >= 1 and subagent_count >= 3
print(f'✅ ST.1.8 — agents={names} primary={primary_count} subagent={subagent_count}' if ok else f'❌ ST.1.8 — {names}')
"
```

**期望**：Agent 列表包含 manager(primary) + writer/analyst/designer(subagent)

### ST.1.9 PG 持久化 — session_agents 表

```bash
CNT=$(psql -d "$PG_URL" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$TEAM_SID'")
[ "$CNT" -ge 4 ] && pass "ST.1.9 Agent PG持久化 count=$CNT" || fail "ST.1.9" "count=$CNT"
```

**期望**：PG session_agents 表至少 4 条记录

## 四、不同 Session 的 Agent 隔离

### ST.1.10 创建第二个 Session（不同项目）

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"合同审查项目"}')
export OTHER_SID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 第二个 Session 不应有第一个的 Agent
RES=$(curl -s --noproxy '*' "$BASE/session/$OTHER_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
names = [a.get('name','') for a in d]
has_writer = 'writer' in names
print('✅ ST.1.10 — 隔离正常 writer不存在' if not has_writer else '❌ ST.1.10 — Agent 泄露到其他Session')
"
```

**期望**：第二个 Session 的 Agent 列表不包含第一个 Session 的 writer/analyst/designer

summary
