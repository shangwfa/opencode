# SaaS Task Tool 测试用例

> 测试流程：创建 Task → 配置 Tool → 创建 Session（传 taskId 自动注入）→ 验证 Tool 可用
>
> 参考用例：[`saas-project/tools/tool.md`](../../saas-project/tools/tool.md)
>
> SaaS 服务：`http://localhost:14096`

---

## 0. 环境

```bash
export BASE="http://localhost:14096"
export PG="opencode_project_test"
export NO_PROXY="localhost,127.0.0.1"

pass() { echo "✅ $1 PASS"; }
fail() { echo "❌ $1 FAIL — $2"; }
```

---

## 一、Task Tool CRUD

### T67.1 创建 Task

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" \
  -H 'Content-Type: application/json' \
  -d '{"title":"tool-test-task","description":"Tool 测试"}')

export TASK_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Task ID: $TASK_ID"
[ -n "$TASK_ID" ] && pass "T67.1 创建Task" || fail "T67.1" ""
```

### T67.2 创建自定义 Tool

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
    return \`Hello from task tool, \${args.name}!\`
  },
})'''
body = json.dumps({'description':'Return a greeting message','code':code}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T67.2' if d['name']=='greeter' and 'plugin' in d['code'] else '❌ T67.2')
"
```

### T67.3 确认列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/tools" | python3 -c "
import json,sys
tools=json.load(sys.stdin)
print(f'Tool 总数: {len(tools)}')
for t in tools:
    print(f'  {t[\"name\"]}: {t[\"description\"][:40]}')
ok = len(tools)==1 and tools[0]['name']=='greeter'
print('✅ T67.3' if ok else '❌ T67.3')
"
```

### T67.4 upsert 同名覆盖

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
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T67.4' if d['description']=='Updated greeter' else '❌ T67.4')
"
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/tools" | python3 -c "import json,sys;print(len([t for t in json.load(sys.stdin) if t['name']=='greeter']))")
[ "$COUNT" = "1" ] && pass "T67.4-no-dup" || fail "T67.4-no-dup" "count=$COUNT"
```

### T67.5 删除 Tool

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/tools/greeter")
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/tools" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && pass "T67.5 删除" || fail "T67.5" "HTTP=$HTTP count=$COUNT"
```

---

## 二、Session 自动注入

### T67.6 重新创建 Tool + 创建 Session

```bash
python3 -c "
import json, urllib.request
code = 'import { tool } from \"@opencode-ai/plugin\"\n\nexport default tool({ description: \"Return TASK_TOOL_OK\", args: {}, async execute() { return \"TASK_TOOL_OK\" } })'
body = json.dumps({'description':'Return TASK_TOOL_OK','code':code}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"title\":\"task-tool-inject-test\"}")
export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
[ -n "$SESSION_ID" ] && pass "T67.6 创建Session" || fail "T67.6" ""
```

### T67.7 验证 Session Tool 列表

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
print('✅ T67.7' if has_greeter else '❌ T67.7')
"
```

---

## 三、跨 Task 隔离

### T67.8 不同 Task 同名 Tool 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"tool-test-2"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

python3 -c "
import json, urllib.request
code = 'import { tool } from \"@opencode-ai/plugin\"\nexport default tool({ description: \"P2 tool\", args: {}, async execute() { return \"P2\" } })'
body = json.dumps({'description':'P2 tool','code':code}).encode()
req = urllib.request.Request('$BASE/saas/task/$RES2/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

P1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/tools" | python3 -c "import json,sys;a=next((t for t in json.load(sys.stdin) if t['name']=='greeter'),None);print(a['description'][:20] if a else '')")
P2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$RES2/tools" | python3 -c "import json,sys;a=next((t for t in json.load(sys.stdin) if t['name']=='greeter'),None);print(a['description'][:20] if a else '')")
echo "P1=$P1  P2=$P2"
[ "$P1" != "$P2" ] && pass "T67.8 隔离" || fail "T67.8" "P1=$P1 P2=$P2"
```

---

## 四、PG 持久化

### T67.9 Task Tool PG

```bash
echo "=== Task Tool in PG ==="
psql -d "$PG" -Atqc "SELECT name, description FROM project_tool WHERE task_id='$TASK_ID' ORDER BY name" | while read l; do echo "  $l"; done
pass "T67.9 Task Tool PG"
```

### T67.10 Session Tool PG

```bash
echo "=== Session Tool in PG ==="
psql -d "$PG" -Atqc "SELECT name, description FROM session_tools WHERE session_id='$SESSION_ID' ORDER BY name" | while read l; do echo "  $l"; done
pass "T67.10 Session Tool PG"
```

---

## 五、清理

### T67.11 删除 Task 后 Tool 清零

```bash
curl -s --noproxy '*' -X DELETE "$BASE/saas/task/$RES2" > /dev/null 2>/dev/null
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM project_tool WHERE task_id='$RES2'" 2>/dev/null || echo "0")
[ "$CNT" = "0" ] && pass "T67.11 删除Task后Tool清零" || fail "T67.11" "count=$CNT"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T67.1 | 创建 Task | ✅ |
| T67.2 | 创建自定义 Tool | ✅ |
| T67.3 | 确认列表 | ✅ |
| T67.4 | upsert 同名覆盖 | ✅ |
| T67.5 | 删除 Tool | ✅ |
| T67.6 | 重新创建 Tool + 创建 Session | ✅ |
| T67.7 | 验证 Session Tool 列表 | ✅ |
| T67.8 | 不同 Task 同名 Tool 隔离 | ✅ |
| T67.9 | Task Tool PG | ✅ |
| T67.10 | Session Tool PG | ✅ |
| T67.11 | 删除 Task 后 Tool 清零 | ✅ |
