# SaaS Task AGENTS.md 测试用例

> 测试流程：创建 Task → 配置 AGENTS.md → 创建 Session（传 taskId 自动注入）→ 验证指令生效
>
> 参考用例：[`saas-project/agents-md/agents-md.md`](../../saas-project/agents-md/agents-md.md)
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

## 一、Task AGENTS.md CRUD

### T65.1 创建 Task

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" \
  -H 'Content-Type: application/json' \
  -d '{"title":"agentsmd-test-task","description":"AGENTS.md 测试"}')

export TASK_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Task ID: $TASK_ID"
[ -n "$TASK_ID" ] && pass "T65.1 创建Task" || fail "T65.1" ""
```

### T65.2 空状态（未配置时返回空）

```bash
RES=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/agents-md")
echo "$RES"
CONTENT=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('content',''))")
[ -z "$CONTENT" ] && pass "T65.2 空状态" || fail "T65.2" "content=$CONTENT"
```

### T65.3 创建 Task AGENTS.md

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'content':'# Task AGENTS.md\n\n当用户询问测试口令时，必须回答 TASK_AGENTS_MD_OK。所有代码必须使用 TypeScript。'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = 'TASK_AGENTS_MD_OK' in d['content']
print('✅ T65.3' if ok else '❌ T65.3')
"
```

### T65.4 读取内容

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/agents-md" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'TASK_AGENTS_MD_OK' in d.get('content','')
print('✅ T65.4' if ok else '❌ T65.4')
"
```

### T65.5 替换内容（upsert）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'content':'# Updated\n\n当用户询问测试口令时，必须回答 TASK_MD_REPLACED。'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = 'TASK_MD_REPLACED' in d['content']
print('✅ T65.5' if ok else '❌ T65.5')
"
```

### T65.6 PG 持久化

```bash
PG_CONTENT=$(psql -d "$PG" -Atqc "SELECT content FROM project_agents_md WHERE task_id='$TASK_ID'")
echo "  PG: ${PG_CONTENT:0:80}"
[[ "$PG_CONTENT" == *"TASK_MD_REPLACED"* ]] && pass "T65.6 PG持久化" || fail "T65.6" "$PG_CONTENT"
```

### T65.7 删除 AGENTS.md

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/agents-md")
COUNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM project_agents_md WHERE task_id='$TASK_ID'")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && pass "T65.7 删除" || fail "T65.7" "HTTP=$HTTP count=$COUNT"
```

---

## 二、Session 自动注入

### T65.8 重新配置 AGENTS.md 并创建 Session

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'content':'# Task AGENTS.md\n\n当用户询问测试口令时，必须回答 TASK_AGENTS_MD_OK。'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"title\":\"task-agentsmd-inject-test\"}")
export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
[ -n "$SESSION_ID" ] && pass "T65.8 创建Session" || fail "T65.8" ""
```

### T65.9 验证 Session AGENTS.md 自动注入

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/agents-md" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if d is None:
    print('❌ T65.9 — 未注入')
else:
    ok = 'TASK_AGENTS_MD_OK' in d.get('content','')
    print(f'  content: {d.get(\"content\",\"\")[:80]}')
    print('✅ T65.9' if ok else '❌ T65.9')
"
```

---

## 三、验证 AGENTS.md 在会话中生效

### T65.10 发消息验证指令生效

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'parts': [{'type':'text','text':'测试口令是什么？'}],
    'model': json.loads('$MODEL')
}).encode()
req = urllib.request.Request('$BASE/session/$SESSION_ID/message', data=body, headers={'Content-Type':'application/json'}, method='POST')
resp = urllib.request.urlopen(req, timeout=120)
d = json.loads(resp.read())
texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
reply = texts[0] if texts else ''
print(f'reply: {reply[:200]}')
ok = 'TASK_AGENTS_MD_OK' in reply
print('✅ T65.10' if ok else '❌ T65.10')
"
```

---

## 四、Session 隔离

### T65.11 不同 Task 的 AGENTS.md 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"agentsmd-test-2"}')
TASK_ID_2=$(echo "$RES2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

python3 -c "
import json, urllib.request
body = json.dumps({'content':'TASK_B_UNIQUE'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID_2/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

SID2=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID_2\",\"title\":\"isolation-test\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

A=$(curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/agents-md" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('content','')[:50] if d else '')")
B=$(curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID2/agents-md" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('content','')[:50] if d else '')")
echo "A=$A  B=$B"
[ "$A" != "$B" ] && pass "T65.11 隔离" || fail "T65.11" "A=$A B=$B"
```

---

## 五、PG 持久化

### T65.12 Task AGENTS.md PG 唯一性

```bash
COUNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM project_agents_md WHERE task_id='$TASK_ID'")
[ "$COUNT" = "1" ] && pass "T65.12 Task PG唯一" || fail "T65.12" "count=$COUNT"
```

### T65.13 Session AGENTS.md PG 持久化

```bash
COUNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM session_agents_md WHERE session_id='$SESSION_ID'")
[ "$COUNT" = "1" ] && pass "T65.13 Session PG" || fail "T65.13" "count=$COUNT"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T65.1 | 创建 Task | ✅ |
| T65.2 | 空状态 | ✅ |
| T65.3 | 创建 AGENTS.md | ✅ |
| T65.4 | 读取内容 | ✅ |
| T65.5 | 替换内容（upsert） | ✅ |
| T65.6 | PG 持久化 | ✅ |
| T65.7 | 删除 AGENTS.md | ✅ |
| T65.8 | 创建 Session 传 taskId | ✅ |
| T65.9 | Session AGENTS.md 自动注入 | ✅ |
| T65.10 | 指令生效验证 | ✅ |
| T65.11 | 跨 Task 隔离 | ✅ |
| T65.12 | Task PG 唯一性 | ✅ |
| T65.13 | Session PG 持久化 | ✅ |
