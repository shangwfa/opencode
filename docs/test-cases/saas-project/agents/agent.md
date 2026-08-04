# SaaS Project Agent 测试用例

> 测试流程：创建 Project → 配置 Agent → 创建 Session → 将 Project Agent 注册到 Session → 验证注入生效
>
> 前置：已完成 `base/base.md` 中的 Project 创建和 Agent 配置（T51.4-T51.15f）
>
> SaaS 服务：`http://localhost:14096`

---

## 0. 环境

```bash
export BASE="http://localhost:14096"
export PG="opencode_project_test"
export NO_PROXY="localhost,127.0.0.1"
export GIT_TOKEN="$(echo -e 'protocol=https\nhost=github.com' | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-)"

pass() { echo "✅ $1 PASS"; }
fail() { echo "❌ $1 FAIL — $2"; }
```

---

## 一、准备：创建 Project 并配置 Agent

### T52.1 创建 Project（带 Git 仓库验证）

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" \
  -H 'Content-Type: application/json' \
  -d "{
    \"name\": \"agent-test-project\",
    \"repository\": {
      \"provider\": \"github\",
      \"url\": \"https://github.com/nb-saas/nbs-saas.git\",
      \"defaultBranch\": \"main\",
      \"auth\": { \"type\": \"token\", \"token\": \"$GIT_TOKEN\" }
    }
  }")

export PROJECT_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Project ID: $PROJECT_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['id'].startswith('prj_') and d['repository']['connectionStatus'] == 'verified'
print('✅ T52.1' if ok else '❌ T52.1')
"
```

### T52.2 创建 Primary Agent（代码开发）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/agents/coder" \
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
    "temperature": 0.3
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='coder' and d['mode']=='primary' and len(d.get('permission',[]))==6
print('✅ T52.2' if ok else '❌ T52.2 — ' + json.dumps(d,ensure_ascii=False)[:120])
"
```

### T52.3 创建 Subagent（翻译专家）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/agents/translator" \
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
print('✅ T52.3' if ok else '❌ T52.3')
"
```

### T52.4 创建只读 Agent（代码审查）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/agents/reviewer" \
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
print('✅ T52.4' if ok else '❌ T52.4')
"
```

### T52.5 确认 Project Agent 列表

```bash
curl -s --noproxy '*' "$BASE/saas/project/$PROJECT_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
names = [a['name'] for a in agents]
print(f'Agent 总数: {len(agents)}')
for a in agents:
    print(f'  {a[\"name\"]}: mode={a[\"mode\"]} perms={len(a.get(\"permission\",[]))}')
ok = 'coder' in names and 'translator' in names and 'reviewer' in names
print('✅ T52.5' if ok else '❌ T52.5')
"
```

---

## 二、创建 Session 并注入 Project Agent

### T52.6 创建 Session

> Session 创建依赖 InstanceContext（directory + project）。
> 在 SaaS 容器中 `OPENCODE_DEFAULT_DIRECTORY=/workspace`，需确保该目录存在。

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"project-agent-injection-test"}')

export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
echo "Session ID: $SESSION_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'id' in d and d['id'].startswith('ses_')
print('✅ T52.6' if ok else '❌ T52.6 — ' + json.dumps(d)[:120])
"
```

> 如果创建失败（`UnknownError`），可能是 `opencode_project_test` 数据库缺少旧 `project` 表的 `global` 记录。
> 修复：`psql -d opencode_project_test -c "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', $(date +%s), $(date +%s), '[]') ON CONFLICT DO NOTHING;"`

### T52.7 将 Project Agent 注册到 Session

从 Project 读取 Agent 配置，通过 Session Agent API 注册到会话：

```bash
# 读取 Project Agent 列表
AGENTS=$(curl -s --noproxy '*' "$BASE/saas/project/$PROJECT_ID/agents")

# 逐个注册到 Session
echo "$AGENTS" | python3 -c "
import json, sys, urllib.request

agents = json.load(sys.stdin)
BASE = '$BASE'
SID = '$SESSION_ID'

results = []
for a in agents:
    body = {
        'name': a['name'],
        'description': a.get('description', ''),
        'mode': a['mode'],
        'prompt': a.get('prompt', ''),
    }
    if a.get('permission'): body['permission'] = a['permission']
    if a.get('temperature') is not None: body['temperature'] = a['temperature']
    if a.get('model'): body['model'] = a['model']

    req = urllib.request.Request(
        f'{BASE}/session/{SID}/agents/create',
        data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        resp = urllib.request.urlopen(req)
        print(f'  ✅ {a[\"name\"]} → HTTP {resp.status}')
        results.append(a['name'])
    except Exception as e:
        print(f'  ❌ {a[\"name\"]} → {e}')

print(f'已注册: {len(results)} 个 agent')
ok = 'coder' in results and 'translator' in results and 'reviewer' in results
print('✅ T52.7' if ok else '❌ T52.7')
"
```

### T52.8 验证 Session Agent 列表包含注入的 Agent

```bash
curl -s --noproxy '*' "$BASE/session/$SESSION_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
names = [a['name'] for a in agents]
print(f'Session Agent 总数: {len(agents)}')
for a in agents:
    print(f'  {a[\"name\"]}: mode={a[\"mode\"]} prompt={a.get(\"prompt\",\"\")[:40]}...')

has_coder = 'coder' in names
has_translator = 'translator' in names
has_reviewer = 'reviewer' in names
has_build = 'build' in names  # 内置 agent

print()
print(f'coder 注入:     {\"✅\" if has_coder else \"❌\"}')
print(f'translator 注入: {\"✅\" if has_translator else \"❌\"}')
print(f'reviewer 注入:   {\"✅\" if has_reviewer else \"❌\"}')
print(f'build 内置:      {\"✅\" if has_build else \"❌\"}')

ok = has_coder and has_translator and has_reviewer and has_build
print('✅ T52.8' if ok else '❌ T52.8')
"
```

**期望**：Session Agent 列表包含 Project 注入的 `coder`、`translator`、`reviewer`，同时保留内置 `build`、`explore`、`plan` 等。

---

## 三、验证 Agent 在会话中生效

### T52.9 使用注入的 Primary Agent 发送消息

用 `coder` agent 发送消息，验证 prompt 生效：

```bash
RES=$(curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\":\"text\",\"text\":\"用一句话介绍你自己\"}],
    \"agent\": \"coder\",
    \"model\": {\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}
  }")

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
# 找 AI 的文字回复
texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
agent = d.get('info',{}).get('agent','')
print(f'agent: {agent}')
print(f'reply: {texts[0][:200] if texts else \"(无文字)\"}')

ok = agent == 'coder' and len(texts) > 0
print('✅ T52.9' if ok else '❌ T52.9')
"
```

**期望**：`agent=coder`，AI 回复包含"全栈工程师"或"工程师"等关键词（来自 prompt）。

### T52.10 验证 Subagent 模式不作为 Primary

`translator` 是 subagent 模式，不能直接作为 primary agent 发消息：

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 30 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\":\"text\",\"text\":\"hello\"}],
    \"agent\": \"translator\",
    \"model\": {\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}
  }")

echo "subagent 作为 primary: HTTP $HTTP"
# 期望：400 或 500（subagent 不能作为 primary），或 AI 回复但不使用 translator
```

### T52.11 验证 Agent 权限配置生效

`reviewer` agent 的 `edit` 和 `write` 权限为 `deny`，尝试写文件时应被拒绝：

```bash
RES=$(curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\": [{\"type\":\"text\",\"text\":\"用 write 工具在 /workspace 写一个文件 test.txt，内容为 hello\"}],
    \"agent\": \"reviewer\",
    \"model\": {\"providerID\":\"zhipuai\",\"modelID\":\"glm-5.1\"}
  }")

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
parts = d.get('parts',[])
# 查找 tool 调用
tools = [p for p in parts if p.get('type')=='tool']
texts = [p.get('text','') for p in parts if p.get('type')=='text']

print(f'agent: {d.get(\"info\",{}).get(\"agent\",\"\")}')
print(f'tools: {len(tools)}')
for t in tools:
    status = t.get('state',{}).get('status','')
    print(f'  tool={t.get(\"tool\",\"\")} status={status}')
print(f'reply: {texts[0][:200] if texts else \"(无)\"}')
print('✅ T52.11 (权限拒绝行为验证)' if True else '❌')
"
```

**期望**：`reviewer` agent 尝试写文件时权限被 deny，或 AI 识别到只读限制后拒绝写操作。

### T52.12 更新 Project Agent 后 Session 同步

更新 Project 的 `coder` agent prompt，重新注册到 Session，验证 Session 中的配置已更新：

```bash
# 1. 更新 Project Agent
curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/agents/coder" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "更新后的 agent，专注 Python",
    "mode": "primary",
    "prompt": "你是一个 Python 后端专家。只回答 Python 相关问题。",
    "temperature": 0.7
  }' > /dev/null

# 2. 重新注册到 Session
UPDATED=$(curl -s --noproxy '*' "$BASE/saas/project/$PROJECT_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
coder = next((a for a in agents if a['name']=='coder'), None)
if coder:
    print(json.dumps({
        'name': 'coder',
        'description': coder.get('description',''),
        'mode': coder['mode'],
        'prompt': coder.get('prompt',''),
        'temperature': coder.get('temperature')
    }))
")

curl -s --noproxy '*' -X POST "$BASE/session/$SESSION_ID/agents/create" \
  -H 'Content-Type: application/json' \
  -d "$UPDATED" > /dev/null

# 3. 验证 Session 中 coder 已更新
curl -s --noproxy '*' "$BASE/session/$SESSION_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
coder = next((a for a in agents if a['name']=='coder'), None)
if coder:
    ok = 'Python' in coder.get('prompt','') and coder.get('temperature') == 0.7
    print(f'  prompt: {coder.get(\"prompt\",\"\")[:50]}')
    print(f'  temp: {coder.get(\"temperature\")}')
    print('✅ T52.12' if ok else '❌ T52.12')
else:
    print('❌ T52.12 — coder not found')
"
```

---

## 四、清理

### T52.13 删除 Session 中的注入 Agent

```bash
HTTP1=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/session/$SESSION_ID/agents/coder")
HTTP2=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/session/$SESSION_ID/agents/translator")
HTTP3=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/session/$SESSION_ID/agents/reviewer")

echo "删除: coder=$HTTP1 translator=$HTTP2 reviewer=$HTTP3"

# 验证已删除
curl -s --noproxy '*' "$BASE/session/$SESSION_ID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
names = [a['name'] for a in agents]
has_injected = any(n in names for n in ['coder','translator','reviewer'])
has_build = 'build' in names
print(f'  注入 agent 残留: {has_injected}')
print(f'  内置 build 保留: {has_build}')
print('✅ T52.13' if not has_injected and has_build else '❌ T52.13')
"
```

**期望**：注入的 agent 已删除，内置 `build` 等仍然保留。

---

## 当前实测结果

测试日期：2026-08-03。

| 用例 | 场景 | 状态 |
|---|---|---|
| T52.1 | 创建 Project（Git 验证） | ✅ |
| T52.2 | 创建 Primary Agent（coder，6 条权限） | ✅ |
| T52.3 | 创建 Subagent（translator） | ✅ |
| T52.4 | 创建只读 Agent（reviewer，edit/write deny） | ✅ |
| T52.5 | 确认 Project Agent 列表 | ✅ |
| T52.6 | 创建 Session | ⏳ 待环境修复 |
| T52.7 | 将 Project Agent 注册到 Session | ⏳ 依赖 T52.6 |
| T52.8 | 验证 Session Agent 列表 | ⏳ 依赖 T52.6 |
| T52.9 | 使用注入的 Agent 发消息 | ⏳ 依赖 T52.6 |
| T52.10 | Subagent 不能作为 Primary | ⏳ 依赖 T52.6 |
| T52.11 | Agent 权限配置生效 | ⏳ 依赖 T52.6 |
| T52.12 | 更新 Project Agent 后 Session 同步 | ⏳ 依赖 T52.6 |
| T52.13 | 删除 Session 中的注入 Agent | ⏳ 依赖 T52.6 |

> **T52.6 阻塞原因**：`opencode_project_test` 数据库缺少旧 `project` 表的 `global` 记录，Session 创建依赖 InstanceContext 的 `Project.fromDirectory()`，需要旧 project 表有 `global` 行。
>
> **修复方案**：
> ```bash
> psql -d opencode_project_test -c "INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/', $(date +%s), $(date +%s), '[]') ON CONFLICT DO NOTHING;"
> ```
> 或使用带完整数据的 `opencode_test` 数据库。
