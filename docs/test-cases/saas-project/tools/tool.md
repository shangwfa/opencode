# SaaS Project Tool 测试用例

> 测试流程：创建 Project → 配置自定义 Tool → 创建 Session（传 projectId 自动注入）→ 验证工具可用
>
> 参考用例：[`docs/test-cases/tools/session-tools.md`](../../tools/session-tools.md)
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

## 一、Project Tool CRUD

### T57.1 创建 Project

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" \
  -H 'Content-Type: application/json' \
  -d '{"name":"tool-test-project","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","defaultBranch":"main","auth":{"type":"none"}}}')
export PROJECT_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Project ID: $PROJECT_ID"
```

### T57.2 创建自定义 Tool

```bash
python3 -c "
import json, urllib.request
code = '''import { tool } from \"@opencode-ai/plugin\"

export default tool({
  description: \"Return a greeting message\",
  args: {
    name: tool.schema.string().describe(\"Name to greet\"),
  },
  async execute(args) {
    return \`Hello from project tool, \${args.name}!\`
  },
})'''
body = json.dumps({'description':'Return a greeting message','code':code}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T57.2' if d['name']=='greeter' and 'plugin' in d['code'] else '❌ T57.2')
"
```

### T57.3 确认列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/tools" | python3 -c "
import json,sys
tools=json.load(sys.stdin)
print(f'Tool 总数: {len(tools)}')
for t in tools:
    print(f'  {t[\"name\"]}: {t[\"description\"][:40]}')
ok = len(tools)==1 and tools[0]['name']=='greeter'
print('✅ T57.3' if ok else '❌ T57.3')
"
```

### T57.4 upsert 同名覆盖

```bash
python3 -c "
import json, urllib.request
code = '''import { tool } from \"@opencode-ai/plugin\"

export default tool({
  description: \"Updated greeter\",
  args: {
    name: tool.schema.string().describe(\"Name\"),
  },
  async execute(args) {
    return \`Updated: \${args.name}\`
  },
})'''
body = json.dumps({'description':'Updated greeter','code':code}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T57.4' if d['description']=='Updated greeter' else '❌ T57.4')
"
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/tools" | python3 -c "import json,sys;print(len([t for t in json.load(sys.stdin) if t['name']=='greeter']))")
[ "$COUNT" = "1" ] && echo "✅ T57.4-no-dup" || echo "❌ T57.4-no-dup"
```

### T57.5 删除 Tool

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/project/$PROJECT_ID/tools/greeter")
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/tools" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && echo "✅ T57.5" || echo "❌ T57.5 HTTP=$HTTP count=$COUNT"
```

---

## 二、Session 自动注入

### T57.6 重新创建 Tool + 创建 Session

```bash
# 重新创建 greeter tool
python3 -c "
import json, urllib.request
code = '''import { tool } from \"@opencode-ai/plugin\"

export default tool({
  description: \"Return PROJECT_TOOL_OK\",
  args: {},
  async execute() {
    return \"PROJECT_TOOL_OK\"
  },
})'''
body = json.dumps({'description':'Return PROJECT_TOOL_OK','code':code}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

# 创建 Session
RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"tool-inject-test\"}")
export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
```

### T57.7 验证 Session Tool 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/tools" | python3 -c "
import json,sys
tools=json.load(sys.stdin)
names=[t['name'] for t in tools]
print(f'Session Tool 总数: {len(tools)}')
for t in tools:
    print(f'  {t[\"name\"]}: {t[\"description\"][:40]}')
has_greeter = 'greeter' in names
print(f'greeter 注入: {\"✅\" if has_greeter else \"❌\"}')
print('✅ T57.7' if has_greeter else '❌ T57.7')
"
```

---

## 三、跨 Project 隔离

### T57.8 不同 Project 同名 Tool 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" -H 'Content-Type: application/json' \
  -d '{"name":"tool-test-2","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","auth":{"type":"none"}}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

python3 -c "
import json, urllib.request
code = '''import { tool } from \"@opencode-ai/plugin\"
export default tool({ description: \"P2 tool\", args: {}, async execute() { return \"P2\" } })'''
body = json.dumps({'description':'P2 tool','code':code}).encode()
req = urllib.request.Request('$BASE/saas/project/$RES2/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

P1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/tools" | python3 -c "import json,sys;t=next((x for x in json.load(sys.stdin) if x['name']=='greeter'),None);print(t['description'][:20] if t else '')")
P2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$RES2/tools" | python3 -c "import json,sys;t=next((x for x in json.load(sys.stdin) if x['name']=='greeter'),None);print(t['description'][:20] if t else '')")
echo "P1=$P1  P2=$P2"
[ "$P1" != "$P2" ] && echo "✅ T57.8 隔离" || echo "❌ T57.8"
```

---

## 四、PG 持久化

### T57.9 Project Tool PG

```bash
psql -d "$PG" -Atqc "SELECT name, description FROM project_tool WHERE project_id='$PROJECT_ID' ORDER BY name" | while read l; do echo "  $l"; done
```

### T57.10 Session Tool PG

```bash
psql -d "$PG" -Atqc "SELECT name, description FROM session_tools WHERE session_id='$SESSION_ID' ORDER BY name" | while read l; do echo "  $l"; done
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T57.1 | 创建 Project | ✅ |
| T57.2 | 创建自定义 Tool | ✅ |
| T57.3 | 确认列表 | ✅ |
| T57.4 | upsert 同名覆盖 | ✅ |
| T57.5 | 删除 Tool | ✅ |
| T57.6 | 创建 Session 传 projectId | ✅ |
| T57.7 | Session Tool 自动注入 | ✅ |
| T57.8 | 跨 Project 隔离 | ✅ |
| T57.9 | Project Tool PG | ✅ |
| T57.10 | Session Tool PG | ✅ |
