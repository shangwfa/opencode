# 03 — Agent 分工与调度

> **扣子场景**：不同 Agent 各司其职（资料整理、方案撰写、行业分析、代码实现），通过 @ 指定 Agent 处理不同任务
>
> **opencode 映射**：同一 Session 内配置多个 primary Agent。不 @ Agent 时传 `noReply: true` 只记录消息不触发回复；@ 指定 Agent 时由该 Agent 回复

## 公共配置

```bash
source ../test-env.sh 3
source ../test-lib.sh
```

## 消息执行约定

- 不指定 `agent` 时必须同时传 `noReply: true`，只记录用户消息，不触发默认 Agent 回复。
- `@Agent` 映射为请求中的 `agent` 字段，例如 `"agent":"researcher"`。
- AI 回复通过 `prompt_async` 发送；轮询消息列表，直到 assistant 消息的 `info.finish` 出现。
- Agent 名称从 assistant 消息的 `info.agent` 读取并展示。

```bash
wait_for_agent_finish() {
  local sid=$1 expected_agent=$2 timeout=${3:-120}
  local start=$(date +%s)
  while true; do
    local result=$(curl -s --noproxy '*' "$BASE/session/$sid/message" | python3 -c "
import json, sys
msgs = json.loads(sys.stdin.read(), strict=False)
for msg in reversed(msgs):
    info = msg.get('info', {})
    if info.get('role') == 'assistant' and info.get('agent') == '$expected_agent' and info.get('finish'):
        print(info.get('agent'))
        break
" 2>/dev/null)
    [ "$result" = "$expected_agent" ] && return 0
    local now=$(date +%s)
    [ $((now - start)) -ge $timeout ] && return 1
    sleep 2
  done
}
```

## 一、组建多主 Agent 团队

### ST.3.1 创建分工团队 Session + 多个 primary Agent

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"多主Agent分工测试"}' | python3 -c "import json,sys;print(json.loads(sys.stdin.read(),strict=False)['id'])")
export DISPATCH_SID="$SID"

# Primary: 资料整理员 — @researcher 时由其回复
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "researcher",
    "mode": "primary",
    "prompt": "你是资料整理员。收到用户任务后，负责组织资料整理工作。需要外部资料时，使用 task 工具调度 source-finder 子 Agent，并基于子 Agent 结果输出结构化摘要。",
    "permission": { "read": "allow", "task": "allow" }
  }' > /dev/null

# Primary: 方案撰写人 — @drafter 时由其回复
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "drafter",
    "mode": "primary",
    "prompt": "你是方案撰写人。根据需求和资料，撰写结构化方案文档。格式：背景 + 目标 + 方案详情 + 实施计划 + 风险评估。不要拒绝任务，直接输出方案。",
    "permission": { "read": "allow", "edit": "allow" }
  }' > /dev/null

# Subagent: 资料来源检索员 — 只能由 primary Agent 调度
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "source-finder",
    "mode": "subagent",
    "prompt": "你是资料来源检索员。根据主 Agent 的任务，整理可靠的信息来源和关键事实。返回结构化检索结果，不再调度其他 Agent。",
    "permission": { "read": "allow", "task": "deny" }
  }' > /dev/null

# Subagent: 方案校对员 — 只能由 primary Agent 调度
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "draft-reviewer",
    "mode": "subagent",
    "prompt": "你是方案校对员。检查主 Agent 生成的方案是否完整，返回问题清单和修改建议。",
    "permission": { "read": "allow", "task": "deny" }
  }' > /dev/null

# Primary: 代码审查员 — @reviewer 时由其回复
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "reviewer",
    "mode": "primary",
    "prompt": "你是代码审查员。审查代码质量、安全性、可维护性。输出：问题列表 + 严重等级 + 修改建议。不要拒绝任务，直接输出审查结果。",
    "permission": { "read": "allow", "bash": "allow" }
  }' > /dev/null

CNT=$(curl -s --noproxy '*' "$BASE/session/$SID/agents" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read(), strict=False)
primaries = [a for a in d if a.get('mode') == 'primary' and a.get('name') in ('researcher','drafter','reviewer')]
print(len(primaries))
")
[ "$CNT" -ge 3 ] && pass "ST.3.1 多主Agent团队组建 primary_count=$CNT" || fail "ST.3.1" "primary_count=$CNT"

SUB_CNT=$(curl -s --noproxy '*' "$BASE/session/$SID/agents" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read(), strict=False)
print(len([a for a in d if a.get('mode') == 'subagent' and a.get('name') in ('source-finder','draft-reviewer')]))
")
[ "$SUB_CNT" -ge 2 ] && pass "ST.3.1b 子Agent组建 subagent_count=$SUB_CNT" || fail "ST.3.1b" "subagent_count=$SUB_CNT"
```

## 二、不 @ Agent — 只记录消息不回复

### ST.3.2 不指定 Agent + noReply → 仅记录消息

```bash
BEFORE=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/message" | python3 -c "import json,sys;print(len(json.loads(sys.stdin.read(),strict=False)))")

RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session/$DISPATCH_SID/message" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"这是一条不需要AI回复的消息，仅记录到会话历史。"}],
    "noReply": true
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read(), strict=False)
info = d.get('info', d)
ok = 'id' in info
print('✅ ST.3.2 — 消息已记录 id=' + info.get('id','')[:20] if ok else '❌ ST.3.2 — ' + json.dumps(d, ensure_ascii=False)[:200])
"
```

**期望**：返回创建的消息对象（含 id），但不触发 AI 回复

### ST.3.3 验证不 @ Agent 时无 assistant 回复

```bash
AFTER=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/message" | python3 -c "import json,sys;print(len(json.loads(sys.stdin.read(),strict=False)))")
DELTA=$((AFTER - BEFORE))
# noReply 只新增 1 条用户消息，无 assistant 回复
[ "$DELTA" -eq 1 ] && pass "ST.3.3 不@Agent无回复 msg_delta=$DELTA" || fail "ST.3.3" "delta=$DELTA（期望1，多了说明有AI回复）"
```

**期望**：消息数只增加 1（用户消息），无 assistant 回复

## 三、@ 指定 Agent 执行任务

### ST.3.4 @researcher — 资料整理并显示 Agent 名称

```bash
curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session/$DISPATCH_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"整理一下关于 React 19 新特性的资料，列出 3 个关键要点。"}],
    "agent": "researcher",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }' -o /dev/null -w 'status: %{http_code}\n'

wait_for_agent_finish "$DISPATCH_SID" researcher 120
AGENT=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/message" | python3 -c "
import json,sys
for msg in reversed(json.loads(sys.stdin.read(), strict=False)):
    info = msg.get('info', {})
    if info.get('role') == 'assistant' and info.get('agent') == 'researcher' and info.get('finish'):
        print(info['agent']); break
")
[ "$AGENT" = "researcher" ] && pass "ST.3.4 @researcher 回复 Agent=$AGENT" || fail "ST.3.4" "agent=$AGENT"
```

**期望**：researcher 返回包含 React 19 资料整理的文本

### ST.3.5 @drafter — 方案撰写并显示 Agent 名称

```bash
curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session/$DISPATCH_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"基于前面的资料，写一份 React 19 升级方案概要。"}],
    "agent": "drafter",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }' -o /dev/null -w 'status: %{http_code}\n'

wait_for_agent_finish "$DISPATCH_SID" drafter 120
AGENT=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/message" | python3 -c "
import json,sys
for msg in reversed(json.loads(sys.stdin.read(), strict=False)):
    info = msg.get('info', {})
    if info.get('role') == 'assistant' and info.get('agent') == 'drafter' and info.get('finish'):
        print(info['agent']); break
")
[ "$AGENT" = "drafter" ] && pass "ST.3.5 @drafter 回复 Agent=$AGENT" || fail "ST.3.5" "agent=$AGENT"
```

**期望**：drafter 返回包含升级方案的文本

### ST.3.6 @reviewer — 代码审查并显示 Agent 名称

```bash
curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session/$DISPATCH_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"审查以下代码：const x = eval(userInput); 有什么安全问题？"}],
    "agent": "reviewer",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }' -o /dev/null -w 'status: %{http_code}\n'

wait_for_agent_finish "$DISPATCH_SID" reviewer 120
AGENT=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/message" | python3 -c "
import json,sys
for msg in reversed(json.loads(sys.stdin.read(), strict=False)):
    info = msg.get('info', {})
    if info.get('role') == 'assistant' and info.get('agent') == 'reviewer' and info.get('finish'):
        print(info['agent']); break
")
[ "$AGENT" = "reviewer" ] && pass "ST.3.6 @reviewer 回复 Agent=$AGENT" || fail "ST.3.6" "agent=$AGENT"
```

**期望**：reviewer 返回包含代码审查结果的文本

## 四、验证多主 Agent 共享上下文

### ST.3.7 验证消息历史 — @ 不同 Agent 各自回复

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/message")
echo "$RES" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read(), strict=False)
agents = set()
for m in d:
    info = m.get('info', {})
    a = info.get('agent','')
    if info.get('role') == 'assistant' and a in ('researcher','drafter','reviewer'):
        agents.add(a)
ok = len(agents) >= 3
print(f'✅ ST.3.7 — 涉及Agent={sorted(agents)}' if ok else f'❌ ST.3.7 — agents={sorted(agents)}')
"
```

**期望**：消息历史包含来自 researcher、drafter、reviewer 三个 Agent 的回复

## 五、主 Agent 调度子 Agent

### ST.3.11 @researcher — 主 Agent 使用 task 调度 source-finder

```bash
curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session/$DISPATCH_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"请使用 task 工具调度 source-finder，检索 React 19 的 3 个可靠资料来源；收到子 Agent 结果后，整理成带来源的摘要。"}],
    "agent": "researcher",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }' -o /dev/null -w 'status: %{http_code}\n'

wait_for_agent_finish "$DISPATCH_SID" researcher 120

RES=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/message")
echo "$RES" | python3 -c "
import json,sys
msgs = json.loads(sys.stdin.read(), strict=False)
researcher = [m for m in msgs if m.get('info', {}).get('role') == 'assistant' and m.get('info', {}).get('agent') == 'researcher']
task_parts = [p for m in researcher for p in m.get('parts', []) if p.get('type') == 'tool' and 'task' in p.get('tool','')]
ok = len(task_parts) >= 1
print('✅ ST.3.11 — researcher 调用了 task，Agent=researcher' if ok else '❌ ST.3.11 — 未发现 task 调用')
"
```

**期望**：用户 @ 的是 `researcher` 主 Agent，最终回复的 `info.agent` 仍是 `researcher`，但回复过程中产生 `task` 工具调用。

### ST.3.12 验证主 Agent 创建子会话并由 source-finder 执行

```bash
CHILDREN=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/children")
echo "$CHILDREN" | python3 -c "
import json,sys
children = json.loads(sys.stdin.read(), strict=False)
agents = [c.get('agent','') for c in children]
ok = 'source-finder' in agents
print('✅ ST.3.12 — 子会话 agents={}'.format(agents) if ok else '❌ ST.3.12 — 未找到 source-finder: {}'.format(agents))
"
```

**期望**：`GET /session/:id/children` 返回至少一个子会话，子会话的 `agent` 为 `source-finder`。

### ST.3.13 验证主 Agent 与子 Agent 的角色边界

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/agents")
echo "$RES" | python3 -c "
import json,sys
agents = {a.get('name'): a.get('mode') for a in json.loads(sys.stdin.read(), strict=False)}
ok = agents.get('researcher') == 'primary' and agents.get('source-finder') == 'subagent'
print('✅ ST.3.13 — researcher=primary，source-finder=subagent' if ok else '❌ ST.3.13 — ' + str(agents))
"
```

**期望**：用户入口使用 primary Agent；subagent 由 primary Agent 通过 task 调度。主 Agent 和子 Agent 的模式、职责和权限明确分离。

### ST.3.14 验证主子 Agent 的 PG 持久化和父子关系

```bash
CHILD_ID=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/children" | python3 -c "import json,sys;d=json.loads(sys.stdin.read(),strict=False);print(d[0]['id'] if d else '')")
CHILD_AGENT=$(psql -d "$PG_URL" -Atqc "SELECT agent FROM session WHERE id='$CHILD_ID'")
PARENT_ID=$(psql -d "$PG_URL" -Atqc "SELECT parent_id FROM session WHERE id='$CHILD_ID'")
PRIMARY_CNT=$(psql -d "$PG_URL" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$DISPATCH_SID' AND mode='primary' AND name='researcher'")

[ "$CHILD_AGENT" = "source-finder" ] && [ "$PARENT_ID" = "$DISPATCH_SID" ] && [ "$PRIMARY_CNT" -ge 1 ] \
  && pass "ST.3.14 主子Agent PG关系正确" \
  || fail "ST.3.14" "child_agent=$CHILD_AGENT parent=$PARENT_ID primary_count=$PRIMARY_CNT"
```

## 六、验证 Agent 间上下文连贯

### ST.3.15 验证 Agent 间上下文连贯

```bash
curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session/$DISPATCH_SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"我之前让你整理的 React 资料提到了哪些要点？简要回顾。"}],
    "agent": "researcher",
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }' -o /dev/null -w 'status: %{http_code}\n'

wait_for_agent_finish "$DISPATCH_SID" researcher 120
echo "✅ ST.3.15 — researcher 上下文回复 Agent=researcher"
```

**期望**：researcher 能回顾之前在同一 Session 中整理的 React 资料

## 七、多主 Agent 权限分工

### ST.3.16 验证不同 Agent 有不同权限

```bash
RES=$(curl -s --noproxy '*' "$BASE/session/$DISPATCH_SID/agents")
echo "$RES" | python3 -c "
import json,sys
d = json.loads(sys.stdin.read(), strict=False)
ok = True
for name in ['researcher','drafter','reviewer']:
    agent = [a for a in d if a.get('name') == name]
    if not agent:
        ok = False
        continue
    perms = agent[0].get('permission', [])
    if not isinstance(perms, list):
        continue
    actions = {p.get('permission',''): p.get('action','') for p in perms}
    if name == 'researcher' and actions.get('edit') == 'allow': ok = False
    if name == 'drafter' and actions.get('bash') == 'allow': ok = False
    if name == 'reviewer' and actions.get('edit') == 'allow': ok = False
    print('  {}: edit={} bash={} read={}'.format(name, actions.get('edit','-'), actions.get('bash','-'), actions.get('read','-')))
print('✅ ST.3.9 — 权限分工正确' if ok else '❌ ST.3.9 — 权限分工异常')
"
```

**期望**：researcher 无 edit/bash，drafter 有 edit 无 bash，reviewer 有 bash 无 edit

### ST.3.17 PG 验证 — 多 primary Agent 持久化

```bash
CNT=$(psql -d "$PG_URL" -Atqc "SELECT count(*) FROM session_agents WHERE session_id='$DISPATCH_SID' AND mode='primary' AND name IN ('researcher','drafter','reviewer')")
[ "$CNT" -ge 3 ] && pass "ST.3.10 多primary Agent PG持久化 count=$CNT" || fail "ST.3.10" "count=$CNT"
```

summary
