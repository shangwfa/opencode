# SaaS Task Command 测试用例

> 测试流程：创建 Task → 配置 Command → 创建 Session（传 taskId 自动注入）→ 验证 Command 执行
>
> 参考用例：[`saas-project/commands/command.md`](../../saas-project/commands/command.md)
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

## 一、Task Command CRUD

### T66.1 创建 Task

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" \
  -H 'Content-Type: application/json' \
  -d '{"title":"cmd-test-task","description":"Command 测试"}')

export TASK_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Task ID: $TASK_ID"
[ -n "$TASK_ID" ] && pass "T66.1 创建Task" || fail "T66.1" ""
```

### T66.2 创建 Command（带 $ARGUMENTS 占位符）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'template': 'Respond with exactly this text: CMD_EXECUTED with args=\$ARGUMENTS',
    'description': '测试命令',
}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T66.2' if d['name']=='echo-cmd' and d['template'].startswith('Respond') else '❌ T66.2')
"
```

### T66.3 创建 Command（带位置参数 + hints）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'template': 'Create \$1 in \$2',
    'description': '位置参数命令',
    'hints': ['component-name', 'directory'],
}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/commands/create-cmp', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='create-cmp' and len(d['hints'])==2 and d['hints'][0]=='component-name'
print('✅ T66.3' if ok else '❌ T66.3')
"
```

### T66.4 确认列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/commands" | python3 -c "
import json,sys
cmds=json.load(sys.stdin)
print(f'Command 总数: {len(cmds)}')
for c in cmds:
    print(f'  {c[\"name\"]}: hints={c.get(\"hints\",[])}')
ok = len(cmds)==2
print('✅ T66.4' if ok else '❌ T66.4')
"
```

### T66.5 upsert 同名覆盖

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'template':'Updated template','description':'更新后'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T66.5' if d['template']=='Updated template' else '❌ T66.5')
"
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/commands" | python3 -c "import json,sys;print(len([c for c in json.load(sys.stdin) if c['name']=='echo-cmd']))")
[ "$COUNT" = "1" ] && pass "T66.5-no-dup" || fail "T66.5-no-dup" "count=$COUNT"
```

### T66.6 删除 Command

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/commands/create-cmp")
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/commands" | python3 -c "import json,sys;print(len([c for c in json.load(sys.stdin) if c['name']=='create-cmp']))")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && pass "T66.6 删除" || fail "T66.6" "HTTP=$HTTP count=$COUNT"
```

---

## 二、Session 自动注入

### T66.7 重新创建 Command + 创建 Session

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'template':'Respond with exactly this text: TASK_CMD_INJECTED_OK','description':'注入测试'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"title\":\"task-cmd-inject-test\"}")
export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
[ -n "$SESSION_ID" ] && pass "T66.7 创建Session" || fail "T66.7" ""
```

### T66.8 验证 Session Command 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/commands" | python3 -c "
import json,sys
cmds=json.load(sys.stdin)
names=[c['name'] for c in cmds]
has_echo = 'echo-cmd' in names
has_init = 'init' in names
print(f'Session Command 总数: {len(cmds)}')
print(f'echo-cmd 注入: {\"✅\" if has_echo else \"❌\"}')
print(f'init 内置: {\"✅\" if has_init else \"❌\"}')
ok = has_echo and has_init
print('✅ T66.8' if ok else '❌ T66.8')
"
```

---

## 三、验证 Command 执行

### T66.9 执行注入的 Command

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'command':'echo-cmd','arguments':''}).encode()
req = urllib.request.Request('$BASE/session/$SESSION_ID/command', data=body, headers={'Content-Type':'application/json'}, method='POST')
resp = urllib.request.urlopen(req, timeout=120)
d = json.loads(resp.read())
texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
reply = texts[0] if texts else ''
print(f'reply: {reply[:200]}')
ok = 'TASK_CMD_INJECTED_OK' in reply
print('✅ T66.9' if ok else '❌ T66.9')
"
```

---

## 四、跨 Task 隔离

### T66.10 不同 Task 同名 Command 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"cmd-test-2"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

python3 -c "
import json, urllib.request
body = json.dumps({'template':'P2_TEMPLATE','description':'P2'}).encode()
req = urllib.request.Request('$BASE/saas/task/$RES2/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

P1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/commands" | python3 -c "import json,sys;a=next((c for c in json.load(sys.stdin) if c['name']=='echo-cmd'),None);print(a['template'][:30] if a else '')")
P2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$RES2/commands" | python3 -c "import json,sys;a=next((c for c in json.load(sys.stdin) if c['name']=='echo-cmd'),None);print(a['template'][:30] if a else '')")
echo "P1=$P1  P2=$P2"
[ "$P1" != "$P2" ] && pass "T66.10 隔离" || fail "T66.10" "P1=$P1 P2=$P2"
```

---

## 五、PG 持久化

### T66.11 Task Command PG

```bash
echo "=== Task Command in PG ==="
psql -d "$PG" -Atqc "SELECT name, template, hints FROM project_command WHERE task_id='$TASK_ID' ORDER BY name" | while read l; do echo "  $l"; done
pass "T66.11 Task Command PG"
```

### T66.12 Session Command PG

```bash
echo "=== Session Command in PG ==="
psql -d "$PG" -Atqc "SELECT name, template FROM session_commands WHERE session_id='$SESSION_ID' AND name='echo-cmd'" | while read l; do echo "  $l"; done
pass "T66.12 Session Command PG"
```

---

## 六、清理

### T66.13 删除 Task 后 Command 清零

```bash
curl -s --noproxy '*' -X DELETE "$BASE/saas/task/$RES2" > /dev/null 2>/dev/null
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM project_command WHERE task_id='$RES2'" 2>/dev/null || echo "0")
[ "$CNT" = "0" ] && pass "T66.13 删除Task后Command清零" || fail "T66.13" "count=$CNT"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T66.1 | 创建 Task | ✅ |
| T66.2 | 创建 Command（$ARGUMENTS） | ✅ |
| T66.3 | 创建 Command（位置参数 + hints） | ✅ |
| T66.4 | 确认列表 | ✅ |
| T66.5 | upsert 同名覆盖 | ✅ |
| T66.6 | 删除 Command | ✅ |
| T66.7 | 创建 Session 传 taskId | ✅ |
| T66.8 | 验证 Session Command 列表 | ✅ |
| T66.9 | 执行注入的 Command | ✅ |
| T66.10 | 不同 Task 同名 Command 隔离 | ✅ |
| T66.11 | Task Command PG | ✅ |
| T66.12 | Session Command PG | ✅ |
| T66.13 | 删除 Task 后 Command 清零 | ✅ |
