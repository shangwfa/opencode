# SaaS Project Command 测试用例

> 测试流程：创建 Project → 配置 Command → 创建 Session（传 projectId 自动注入）→ 验证命令执行
>
> 参考用例：[`docs/test-cases/commands/session-commands.md`](../../commands/session-commands.md)
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

## 一、Project Command CRUD

### T56.1 创建 Project

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" \
  -H 'Content-Type: application/json' \
  -d '{"name":"cmd-test-project","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","defaultBranch":"main","auth":{"type":"none"}}}')
export PROJECT_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Project ID: $PROJECT_ID"
```

### T56.2 创建 Command（带 $ARGUMENTS 占位符）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'template': 'Respond with exactly this text: CMD_EXECUTED with args=$ARGUMENTS',
    'description': '测试命令',
}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T56.2' if d['name']=='echo-cmd' and d['template'].startswith('Respond') else '❌ T56.2')
"
```

### T56.3 创建 Command（带位置参数 + hints）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'template': 'Create $1 in $2',
    'description': '位置参数命令',
    'hints': ['component-name', 'directory'],
}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/commands/create-cmp', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='create-cmp' and len(d['hints'])==2 and d['hints'][0]=='component-name'
print('✅ T56.3' if ok else '❌ T56.3')
"
```

### T56.4 确认列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/commands" | python3 -c "
import json,sys
cmds=json.load(sys.stdin)
print(f'Command 总数: {len(cmds)}')
for c in cmds:
    print(f'  {c[\"name\"]}: hints={c.get(\"hints\",[])}')
ok = len(cmds)==2
print('✅ T56.4' if ok else '❌ T56.4')
"
```

### T56.5 upsert 同名覆盖

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'template':'Updated template','description':'更新后'}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T56.5' if d['template']=='Updated template' else '❌ T56.5')
"
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/commands" | python3 -c "import json,sys;print(len([c for c in json.load(sys.stdin) if c['name']=='echo-cmd']))")
[ "$COUNT" = "1" ] && echo "✅ T56.5-no-dup" || echo "❌ T56.5-no-dup count=$COUNT"
```

### T56.6 删除 Command

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/project/$PROJECT_ID/commands/create-cmp")
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/commands" | python3 -c "import json,sys;print(len([c for c in json.load(sys.stdin) if c['name']=='create-cmp']))")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && echo "✅ T56.6" || echo "❌ T56.6 HTTP=$HTTP count=$COUNT"
```

---

## 二、Session 自动注入

### T56.7 创建 Session 传 projectId

```bash
# 重新创建 echo-cmd
python3 -c "
import json, urllib.request
body = json.dumps({'template':'Respond with exactly this text: CMD_INJECTED_OK','description':'注入测试'}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"cmd-inject-test\"}")
export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
```

### T56.8 验证 Session Command 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/commands" | python3 -c "
import json,sys
cmds=json.load(sys.stdin)
names=[c['name'] for c in cmds]
has_echo = 'echo-cmd' in names
has_init = 'init' in names  # 内置命令
print(f'Session Command 总数: {len(cmds)}')
print(f'echo-cmd 注入: {\"✅\" if has_echo else \"❌\"}')
print(f'init 内置: {\"✅\" if has_init else \"❌\"}')
ok = has_echo and has_init
print('✅ T56.8' if ok else '❌ T56.8')
"
```

---

## 三、验证命令执行

### T56.9 执行注入的 Command

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
ok = 'CMD_INJECTED_OK' in reply
print('✅ T56.9' if ok else '❌ T56.9')
"
```

**期望**：AI 回复包含 `CMD_INJECTED_OK`，说明 Project Command 正确注入到 Session 并可执行。

---

## 四、跨 Project 隔离

### T56.10 不同 Project 同名 Command 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" -H 'Content-Type: application/json' \
  -d '{"name":"cmd-test-2","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","auth":{"type":"none"}}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

python3 -c "
import json, urllib.request
body = json.dumps({'template':'P2_TEMPLATE','description':'P2'}).encode()
req = urllib.request.Request('$BASE/saas/project/$RES2/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

P1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/commands" | python3 -c "import json,sys;c=next((x for x in json.load(sys.stdin) if x['name']=='echo-cmd'),None);print(c['template'][:30] if c else '')")
P2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$RES2/commands" | python3 -c "import json,sys;c=next((x for x in json.load(sys.stdin) if x['name']=='echo-cmd'),None);print(c['template'][:30] if c else '')")
echo "P1=$P1  P2=$P2"
[ "$P1" != "$P2" ] && echo "✅ T56.10 隔离" || echo "❌ T56.10"
```

---

## 五、PG 持久化

### T56.11 Project Command PG

```bash
psql -d "$PG" -Atqc "SELECT name, template, hints FROM project_command WHERE project_id='$PROJECT_ID' ORDER BY name" | while read l; do echo "  $l"; done
```

### T56.12 Session Command PG

```bash
psql -d "$PG" -Atqc "SELECT name, template FROM session_commands WHERE session_id='$SESSION_ID' AND name='echo-cmd'" | while read l; do echo "  $l"; done
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T56.1 | 创建 Project | ✅ |
| T56.2 | 创建 Command（$ARGUMENTS） | ✅ |
| T56.3 | 创建 Command（位置参数 + hints） | ✅ |
| T56.4 | 确认列表 | ✅ |
| T56.5 | upsert 同名覆盖 | ✅ |
| T56.6 | 删除 Command | ✅ |
| T56.7 | 创建 Session 传 projectId | ✅ |
| T56.8 | Session Command 自动注入 | ✅ |
| T56.9 | 执行注入的 Command | ✅ |
| T56.10 | 跨 Project 隔离 | ✅ |
| T56.11 | Project Command PG | ✅ |
| T56.12 | Session Command PG | ✅ |
