# Session Agents（会话级动态 Agent）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十六、Session Agents（会话级动态 Agent）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），`BASE` 和 `MODEL` 已配置。仅 PG 模式（SaaS）下生效。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

### T16.1 创建会话级 agent

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "poet",
    "description": "诗人 agent，专写五言绝句",
    "mode": "primary",
    "prompt": "你是一个唐朝诗人。用户说什么，你都回复一首五言绝句。只输出诗歌本身，不要解释。",
    "temperature": 0.9
  }' | python3 -m json.tool
```
**期望**：返回 `Agent.Info`，`name=poet`，`mode=primary`，`temperature=0.9`

### T16.2 列出会话 agents（全局 + 会话级合并）

```bash
curl -s "$BASE/session/$SID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
for a in agents:
    print(f'{a[\"name\"]}: {a.get(\"description\",\"\")} mode={a[\"mode\"]}')
"
```
**期望**：列表中包含全局 agent（build/explore/plan 等）和会话级 `poet`

### T16.3 Upsert 更新同名 agent

```bash
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "poet",
    "description": "诗人 agent（更新版），写七言律诗",
    "mode": "primary",
    "prompt": "你是一个宋朝诗人。用户说什么，你都回复一首七言律诗。只输出诗歌本身。",
    "temperature": 0.7
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print('updated:', d['description'], 'temp:', d.get('temperature'))"
```
**期望**：description 更新为"更新版"，temperature=0.7，列表仍只有 1 个 poet

### T16.4 删除单个会话 agent

```bash
curl -s -X DELETE "$BASE/session/$SID/agents/poet" -w "\nstatus: %{http_code}\n"
curl -s "$BASE/session/$SID/agents" | python3 -c "import json,sys;print([a['name'] for a in json.load(sys.stdin)])"
```
**期望**：DELETE 返回 204，列表中 poet 已消失（全局 agent 仍在）

### T16.5 清空所有会话级 agents

```bash
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"a1","description":"Agent 1","prompt":"You are agent 1"}' > /dev/null
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"a2","description":"Agent 2","prompt":"You are agent 2"}' > /dev/null

curl -s -X DELETE "$BASE/session/$SID/agents" -w "clear: %{http_code}\n"
curl -s "$BASE/session/$SID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
session_names = [a['name'] for a in agents if a['name'] in ('a1','a2')]
print(f'a1/a2残留: {session_names}')
"
```
**期望**：HTTP 204，a1/a2 已清空，全局 agent 仍在

### T16.6 用自定义 primary agent 发消息

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"agent-msg-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "analyst",
    "description": "数据分析师，只输出 JSON 格式",
    "mode": "primary",
    "prompt": "你是一个数据分析师。无论用户问什么，你都用 JSON 格式回答。回答必须是一个合法的 JSON 对象。",
    "temperature": 0.3
  }' > /dev/null

curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"列出当前目录下有哪些文件和目录，用JSON格式\"}],\"agent\":\"analyst\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
text = ''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')
print(text[:300])
print('包含JSON:', '{' in text and '}' in text)
"
```
**期望**：AI 使用 analyst agent 回复，回复内容包含 JSON 格式

### T16.7 创建带自定义权限的只读 agent

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "reviewer",
    "description": "代码审查 agent，只读",
    "mode": "primary",
    "prompt": "你是代码审查专家。仔细审查代码并给出改进建议。你只能读取文件，不能写入。",
    "permission": [
      {"permission": "read", "pattern": "*", "action": "allow"},
      {"permission": "bash", "pattern": "*", "action": "allow"},
      {"permission": "grep", "pattern": "*", "action": "allow"},
      {"permission": "glob", "pattern": "*", "action": "allow"},
      {"permission": "edit", "pattern": "*", "action": "deny"},
      {"permission": "write", "pattern": "*", "action": "deny"}
    ]
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'permission数={len(d.get(\"permission\",[]))}')"

curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 ls 列出 /workspace 下的文件\"}],\"agent\":\"reviewer\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type') == 'tool':
        print(f'tool: {p[\"tool\"]} status: {p.get(\"state\",{}).get(\"status\")}')
    if p.get('type') == 'text':
        print(f'text: {p.get(\"text\",\"\")[:200]}')
"
```
**期望**：reviewer agent 创建成功，权限数=6，能读取文件但尝试写入时被权限拒绝

### T16.8 创建 subagent 模式 agent 并通过 @ 调用

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "translator",
    "description": "翻译专家，将中文翻译成英文",
    "mode": "subagent",
    "prompt": "你是翻译专家。将用户提供的中文内容翻译成地道英文。只输出翻译结果。",
    "temperature": 0.5
  }' > /dev/null

curl -s --max-time 90 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"@translator 帮我把这段话翻译成英文：今天天气真好，适合出去散步。\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type') == 'text':
        t = p.get('text','')
        print(f'text: {t[:300]}')
        eng = [w for w in ['weather','walk','nice','stroll'] if w in t.lower()]
        if eng: print(f'PASS: 包含英文翻译关键词 {eng}')
"
```
**期望**：主 agent 调用 translator 子 agent，输出英文翻译

### T16.9 不同 session 的 agents 互相隔离

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"session-A"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"session-B"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_A/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"shared-name","description":"属于 Session A","prompt":"You are Session A agent"}' > /dev/null
curl -s -X POST "$BASE/session/$SID_B/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"shared-name","description":"属于 Session B","prompt":"You are Session B agent"}' > /dev/null

echo "Session A:"
curl -s "$BASE/session/$SID_A/agents" | python3 -c "import json,sys;[print(f'  {a[\"name\"]}: {a[\"description\"]}') for a in json.load(sys.stdin) if a['name']=='shared-name']"
echo "Session B:"
curl -s "$BASE/session/$SID_B/agents" | python3 -c "import json,sys;[print(f'  {a[\"name\"]}: {a[\"description\"]}') for a in json.load(sys.stdin) if a['name']=='shared-name']"
```
**期望**：A 显示"属于 Session A"，B 显示"属于 Session B"，互不影响

### T16.10 删除 session 后 agents 级联清理

```bash
SID_DEL=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_DEL/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"to-delete","description":"将被级联删除","prompt":"test"}' > /dev/null

curl -s -X DELETE "$BASE/session/$SID_DEL" > /dev/null

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID_DEL/agents")
echo "After delete session: agents endpoint returns $STATUS"
```
**期望**：删除 session 后，agents 端点返回 404，数据已级联清理

### T16.11 完整工作流（创建→执行→验证→清理）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"full-workflow"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Step 1: 创建 agent
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "python-coder",
    "description": "Python 编程专家",
    "mode": "primary",
    "prompt": "你是 Python 编程专家。用户描述需求，你生成干净的 Python 代码。",
    "temperature": 0.4,
    "steps": 10
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'Created: {d[\"name\"]} mode={d[\"mode\"]}')"

# Step 2: 用 agent 创建文件
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"在 /workspace 创建 calculator.py，包含 add/subtract/multiply/divide 四个函数\"}],\"agent\":\"python-coder\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type') == 'tool':
        print(f'  tool: {p[\"tool\"]} status: {p.get(\"state\",{}).get(\"status\")}')
    if p.get('type') == 'text':
        print(f'  AI: {p.get(\"text\",\"\")[:200]}')
"

# Step 3: 验证 agent 仍在
curl -s "$BASE/session/$SID/agents" | python3 -c "import json,sys;print('python-coder exists:', any(a['name']=='python-coder' for a in json.load(sys.stdin)))"

# Step 4: 删除 agent
curl -s -X DELETE "$BASE/session/$SID/agents/python-coder" -w "delete: %{http_code}\n"
curl -s "$BASE/session/$SID/agents" | python3 -c "import json,sys;print('python-coder deleted:', not any(a['name']=='python-coder' for a in json.load(sys.stdin)))"
```
**期望**：完整流程顺利执行，agent 创建→执行→验证→删除

### T16.12 不存在的 session 创建 agent → 404

```bash
curl -s -o /dev/null -w "status: %{http_code}\n" "$BASE/session/ses_NOTEXIST/agents/create" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"name":"test","description":"test","prompt":"test"}'
```
**期望**：404

### T16.13 不存在的 session 列出 agents → 404

```bash
curl -s -o /dev/null -w "status: %{http_code}\n" "$BASE/session/ses_NOTEXIST/agents"
```
**期望**：404

### T16.14 非法 mode 值 → 400

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"bad","mode":"invalid"}' -w "\nstatus: %{http_code}\n"
```
**期望**：400，错误信息包含 `"mode"` 校验失败

### T16.15 缺少必填字段 name → 400

```bash
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{}' -w "\nstatus: %{http_code}\n"
```
**期望**：400，错误信息包含 `"name"` expected string

### T16.16 多 agent 协作（主 agent 调度多个 subagent）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"multi-agent-collab"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SID"

# 创建主 agent（项目经理）
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "manager",
    "description": "项目经理，负责分配任务给专家 agent",
    "mode": "primary",
    "prompt": "你是项目经理。用户提出需求后，你需要将任务拆分并分配给合适的专家 agent。使用 @agent_name 的方式调用子 agent。每次只分配一个子任务，等子 agent 完成后再分配下一个。所有子任务完成后，汇总结果返回给用户。",
    "temperature": 0.3
  }' > /dev/null

# 创建 subagent：翻译专家
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "translator",
    "description": "翻译专家，中文翻译成英文",
    "mode": "subagent",
    "prompt": "你是翻译专家。将用户提供的中文内容翻译成地道英文。只输出翻译结果，不要解释。",
    "temperature": 0.5
  }' > /dev/null

# 创建 subagent：代码专家
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "coder",
    "description": "代码专家，写 Python 代码",
    "mode": "subagent",
    "prompt": "你是 Python 代码专家。根据需求写出干净、可运行的 Python 代码。只输出代码，放在 ```python 代码块中。",
    "temperature": 0.4
  }' > /dev/null

# 确认 3 个 agent 都存在
echo "Agents:"
curl -s "$BASE/session/$SID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
custom = [a for a in agents if a['name'] in ('manager','translator','coder')]
for a in custom:
    print(f'  {a[\"name\"]}: mode={a[\"mode\"]} desc={a.get(\"description\",\"\")}')
print(f'验证: 3个自定义agent = {len(custom)==3} (期望 True)')
"

# 用主 agent 发消息，让它调度 translator 和 coder
echo ""
echo "输入: POST /session/$SID/message {agent:manager}"
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请完成以下两个任务：1. 把「你好世界」翻译成英文；2. 写一个 Python 函数计算斐波那契数列的第 n 项。请分别调用 @translator 和 @coder 来完成。\"}],\"agent\":\"manager\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
tools = []
texts = []
for p in d.get('parts',[]):
    if p.get('type') == 'tool':
        tools.append(p['tool'])
        status = p.get('state',{}).get('status','?')
        print(f'  [tool] {p[\"tool\"]} status={status}')
    if p.get('type') == 'text':
        texts.append(p.get('text',''))
full = ' '.join(texts)
print(f'  AI回复 (前500字): {full[:500]}')
has_eng = any(w in full.lower() for w in ['hello','world','fibonacci','def ','python'])
has_task = 'task' in tools or len(tools) >= 2
print(f'  验证: 调度了子任务tool = {has_task} (tool列表: {tools})')
print(f'  验证: 回复包含翻译+代码内容 = {has_eng}')
"
```
**期望**：主 agent (manager) 自动调度 @translator 和 @coder 子 agent，分别完成翻译和代码生成子任务，最终汇总结果。验证方式：回复文本包含翻译内容（如 "Hello World"）和代码内容（如 `def`/`fibonacci`）

---

