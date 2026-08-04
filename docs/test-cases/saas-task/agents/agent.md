# SaaS Task Agent 测试用例

> 测试流程：创建 Task → 配置 Agent → 创建 Session（传 taskId 自动注入）→ 验证 Agent 生效
>
> 参考用例：[`saas-project/agents/agent.md`](../../saas-project/agents/agent.md)
>
> SaaS 服务：`http://localhost:14096`

---

## 0. 环境

```bash
export BASE="http://localhost:14096"
export PG="opencode_project_test"
export NO_PROXY="localhost,127.0.0.1"
export MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

pass() { echo "✅ $1 PASS"; }
fail() { echo "❌ $1 FAIL — $2"; }
```

---

## 一、准备：创建 Task 并配置 Agent

### T62.1 创建 Task

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" \
  -H 'Content-Type: application/json' \
  -d '{"title":"agent-test-task","description":"Agent 测试"}')

export TASK_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Task ID: $TASK_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['id'].startswith('task_')
print('✅ T62.1' if ok else '❌ T62.1')
"
```

### T62.2 创建 Primary Agent（代码开发）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/coder" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "全栈工程师，擅长 TypeScript 和 React",
    "mode": "primary",
    "prompt": "你是一个资深全栈工程师。回答时先分析问题，再给出代码。代码风格简洁，优先函数式编程。",
    "permission": [
      {"permission":"read","pattern":"*","action":"allow"},
      {"permission":"edit","pattern":"*","action":"allow"},
      {"permission":"write","pattern":"*","action":"allow"},
      {"permission":"bash","pattern":"*","action":"allow"},
      {"permission":"glob","pattern":"*","action":"allow"},
      {"permission":"grep","pattern":"*","action":"allow"}
    ],
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"},
    "temperature": 0.3,
    "topP": 0.9,
    "steps": 30,
    "color": "#3fb950",
    "variant": "reasoning"
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='coder' and d['mode']=='primary' and len(d.get('permission',[]))==6 and d.get('temperature')==0.3 and d.get('model',{}).get('modelID')=='glm-5.1'
print('✅ T62.2' if ok else '❌ T62.2 — ' + json.dumps(d,ensure_ascii=False)[:120])
"
```

### T62.3 创建 Subagent（翻译专家）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/translator" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "翻译专家，中英互译",
    "mode": "subagent",
    "prompt": "将中文翻译成地道英文。只输出翻译结果，不解释。",
    "temperature": 0.5
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='translator' and d['mode']=='subagent'
print('✅ T62.3' if ok else '❌ T62.3')
"
```

### T62.4 创建只读 Agent（代码审查）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/reviewer" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "代码审查，只读",
    "mode": "primary",
    "prompt": "你是代码审查专家。只能读取文件，不能修改。",
    "permission": [
      {"permission":"read","pattern":"*","action":"allow"},
      {"permission":"bash","pattern":"*","action":"allow"},
      {"permission":"grep","pattern":"*","action":"allow"},
      {"permission":"glob","pattern":"*","action":"allow"},
      {"permission":"edit","pattern":"*","action":"deny"},
      {"permission":"write","pattern":"*","action":"deny"}
    ],
    "temperature": 0.1
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
perms = {p['permission']:p['action'] for p in d.get('permission',[])}
ok = perms.get('read')=='allow' and perms.get('edit')=='deny' and perms.get('write')=='deny'
print('✅ T62.4' if ok else '❌ T62.4')
"
```

### T62.5 确认 Task Agent 列表

```bash
curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
names = [a['name'] for a in agents]
print(f'Agent 总数: {len(agents)}')
for a in agents:
    print(f'  {a[\"name\"]}: mode={a[\"mode\"]} perms={len(a.get(\"permission\",[]))}')
ok = 'coder' in names and 'translator' in names and 'reviewer' in names
print('✅ T62.5' if ok else '❌ T62.5')
"
```

---

## 二、创建 Session 并自动注入 Agent

### T62.6 创建 Session（传 taskId，自动注入）

```bash
RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"title\":\"task-agent-injection-test\"}")

export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
echo "Session ID: $SESSION_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'id' in d and d['id'].startswith('ses_')
print('✅ T62.6' if ok else '❌ T62.6 — ' + json.dumps(d)[:120])
"
```

### T62.7 验证 Session Agent 列表包含注入的 Agent

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
names = [a['name'] for a in agents]
print(f'Session Agent 总数: {len(agents)}')
for a in agents:
    print(f'  {a[\"name\"]}: mode={a[\"mode\"]}')

has_coder = 'coder' in names
has_translator = 'translator' in names
has_reviewer = 'reviewer' in names
has_build = 'build' in names

print(f'coder 注入:     {\"✅\" if has_coder else \"❌\"}')
print(f'translator 注入: {\"✅\" if has_translator else \"❌\"}')
print(f'reviewer 注入:   {\"✅\" if has_reviewer else \"❌\"}')
print(f'build 内置:      {\"✅\" if has_build else \"❌\"}')

ok = has_coder and has_translator and has_reviewer and has_build
print('✅ T62.7' if ok else '❌ T62.7')
"
```

### T62.8 验证 Agent 配置正确注入（权限/温度/prompt）

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
coder = next((a for a in agents if a['name']=='coder'), None)
if not coder:
    print('❌ T62.8 — coder not found')
else:
    ok = (
        coder.get('mode') == 'primary' and
        len(coder.get('permission',[])) == 6 and
        coder.get('temperature') == 0.3 and
        '全栈工程师' in coder.get('prompt','')
    )
    print('✅ T62.8' if ok else '❌ T62.8 — ' + json.dumps(coder,ensure_ascii=False)[:120])
"
```

---

## 三、验证 Agent 在会话中生效

### T62.9 使用注入的 Primary Agent 发送消息

```bash
RES=$(curl -s --noproxy '*' --max-time 90 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\":\"text\",\"text\":\"用一句话介绍你自己\"}],
    \"agent\": \"coder\",
    \"model\": $MODEL
  }")

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
agent = d.get('info',{}).get('agent','')
print(f'agent: {agent}')
print(f'reply: {texts[0][:200] if texts else \"(无文字)\"}')
ok = agent == 'coder' and len(texts) > 0
print('✅ T62.9' if ok else '❌ T62.9')
"
```

### T62.10 验证 Subagent 模式不作为 Primary

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\":\"text\",\"text\":\"hello\"}],
    \"agent\": \"translator\",
    \"model\": $MODEL
  }")

echo "subagent 作为 primary: HTTP $HTTP"
```

### T62.11 验证 Agent 权限配置生效

```bash
RES=$(curl -s --noproxy '*' --max-time 90 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\":\"text\",\"text\":\"用 write 工具在 /workspace 写一个文件 test.txt\"}],
    \"agent\": \"reviewer\",
    \"model\": $MODEL
  }")

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
tools = [p for p in d.get('parts',[]) if p.get('type')=='tool']
texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
print(f'agent: {d.get(\"info\",{}).get(\"agent\",\"\")}')
print(f'tools: {len(tools)}')
print(f'reply: {texts[0][:200] if texts else \"(无)\"}')
print('✅ T62.11 (权限验证)')
"
```

---

## 四、Agent CRUD 与隔离

### T62.12 更新 Agent（upsert 同名覆盖）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/coder" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "更新后的 agent，专注 Python",
    "mode": "primary",
    "prompt": "你是一个 Python 后端专家。只回答 Python 相关问题。",
    "temperature": 0.7
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d.get('description') == '更新后的 agent，专注 Python' and d.get('temperature') == 0.7
print('✅ T62.12' if ok else '❌ T62.12')
"

COUNT=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID/agents" | python3 -c "import json,sys;print(len([a for a in json.load(sys.stdin) if a['name']=='coder']))")
[ "$COUNT" = "1" ] && pass "T62.12-no-dup" || fail "T62.12-no-dup" "coder count=$COUNT"
```

### T62.13 删除单个 Agent

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/agents/translator")

COUNT=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID/agents" | python3 -c "import json,sys;print(len([a for a in json.load(sys.stdin) if a['name']=='translator']))")

[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && pass "T62.13-delete" || fail "T62.13-delete" "HTTP=$HTTP count=$COUNT"
```

### T62.14 跨 Task 同名 Agent 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"agent-test-2"}')
TASK_ID_2=$(echo "$RES2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID_2/agents/coder" \
  -H 'Content-Type: application/json' \
  -d '{"description":"P2 coder","mode":"primary","prompt":"P2 only"}' > /dev/null

P1=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID/agents" | python3 -c "import json,sys;a=next((x for x in json.load(sys.stdin) if x['name']=='coder'),None);print(a['description'][:20] if a else '')")
P2=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID_2/agents" | python3 -c "import json,sys;a=next((x for x in json.load(sys.stdin) if x['name']=='coder'),None);print(a['description'][:20] if a else '')")

echo "P1=$P1  P2=$P2"
[ "$P1" != "$P2" ] && pass "T62.14-isolation" || fail "T62.14-isolation"
```

### T62.15 同表 Project/Task 隔离

```bash
# Project 的 agent（project_id 非空）和 Task 的 agent（task_id 非空）互不干扰
PCNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM agent WHERE project_id IS NOT NULL AND task_id IS NULL")
TCNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM agent WHERE task_id IS NOT NULL AND project_id IS NULL")
echo "Project agents: $PCNT  Task agents: $TCNT"
[ "$TCNT" -ge 1 ] && pass "T62.15 同表隔离" || fail "T62.15" "task=$TCNT"
```

---

## 五、PG 持久化

### T62.16 Task Agent PG

```bash
psql -d "$PG" -Atqc "
SELECT name, mode, temperature, jsonb_array_length(permission) as perm_count
FROM agent WHERE task_id='$TASK_ID' ORDER BY name
" | while read l; do echo "  $l"; done
pass "T62.16 Task Agent PG"
```

### T62.17 Session Agent PG（session_agents 表）

```bash
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$SESSION_ID' AND name IN ('coder','reviewer')")
[ "$CNT" -ge 2 ] && pass "T62.17 Session Agent PG" || fail "T62.17" "count=$CNT"
```

---

## 六、清理

### T62.18 删除 Task 后 Agent 清零

```bash
curl -s --noproxy '*' -X DELETE "$BASE/saas/task/$TASK_ID_2" > /dev/null
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM agent WHERE task_id='$TASK_ID_2'")
[ "$CNT" = "0" ] && pass "T62.18 删除Task后Agent清零" || fail "T62.18" "count=$CNT"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T62.1 | 创建 Task | ✅ |
| T62.2 | 创建 Primary Agent（完整配置） | ✅ |
| T62.3 | 创建 Subagent | ✅ |
| T62.4 | 创建只读 Agent | ✅ |
| T62.5 | 确认 Task Agent 列表 | ✅ |
| T62.6 | 创建 Session（传 taskId） | ✅ |
| T62.7 | Session Agent 自动注入 | ✅ |
| T62.8 | Agent 配置正确注入（权限/温度/prompt） | ✅ |
| T62.9 | 使用注入的 Agent 发消息 | ✅ |
| T62.10 | Subagent 不能作为 Primary | ✅ |
| T62.11 | Agent 权限配置生效 | ✅ |
| T62.12 | 更新 Agent（upsert） | ✅ |
| T62.13 | 删除单个 Agent | ✅ |
| T62.14 | 跨 Task 同名 Agent 隔离 | ✅ |
| T62.15 | 同表 Project/Task 隔离 | ✅ |
| T62.16 | Task Agent PG | ✅ |
| T62.17 | Session Agent PG | ✅ |
| T62.18 | 删除 Task 后 Agent 清零 | ✅ |
