# SaaS Project AGENTS.md 测试用例

> 测试流程：创建 Project → 配置 AGENTS.md → 创建 Session（传 projectId 自动注入）→ 验证指令生效
>
> 参考用例：[`docs/test-cases/agent-md/session-agents-md.md`](../../agent-md/session-agents-md.md)
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

## 一、Project AGENTS.md CRUD

### T55.1 创建 Project

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" \
  -H 'Content-Type: application/json' \
  -d '{"name":"agentsmd-test-project","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","defaultBranch":"main","auth":{"type":"none"}}}')
export PROJECT_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Project ID: $PROJECT_ID"
```

### T55.2 空状态（未配置时返回空）

```bash
RES=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/agents-md")
echo "$RES"
# 期望: {"content":""}
```

### T55.3 创建 Project AGENTS.md

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'content':'# Project AGENTS.md\n\n当用户询问测试口令时，必须回答 PROJECT_AGENTS_MD_OK。所有代码必须使用 TypeScript。'}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = 'PROJECT_AGENTS_MD_OK' in d['content']
print('✅ T55.3' if ok else '❌ T55.3')
"
```

### T55.4 读取内容

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/agents-md" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'PROJECT_AGENTS_MD_OK' in d.get('content','')
print('✅ T55.4' if ok else '❌ T55.4')
"
```

### T55.5 替换内容（upsert）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({'content':'# Updated\n\n当用户询问测试口令时，必须回答 PROJECT_MD_REPLACED。'}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = 'PROJECT_MD_REPLACED' in d['content']
print('✅ T55.5' if ok else '❌ T55.5')
"
```

### T55.6 PG 持久化

```bash
psql -d "$PG" -Atqc "SELECT content FROM project_agents_md WHERE project_id='$PROJECT_ID'" | head -c 100
echo ""
# 期望: 含 PROJECT_MD_REPLACED
```

### T55.7 删除 AGENTS.md

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/project/$PROJECT_ID/agents-md")
COUNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM project_agents_md WHERE project_id='$PROJECT_ID'")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && echo "✅ T55.7" || echo "❌ T55.7 HTTP=$HTTP count=$COUNT"
```

---

## 二、Session 自动注入

### T55.8 重新配置 AGENTS.md 并创建 Session

```bash
# 重新配置
python3 -c "
import json, urllib.request
body = json.dumps({'content':'# Project AGENTS.md\n\n当用户询问测试口令时，必须回答 PROJECT_AGENTS_MD_OK。'}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

# 创建 Session 传 projectId
RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"agentsmd-inject-test\"}")
export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
```

### T55.9 验证 Session AGENTS.md 自动注入

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/agents-md" | python3 -c "
import json,sys
d = json.load(sys.stdin)
if d is None:
    print('❌ T55.9 — 未注入')
else:
    ok = 'PROJECT_AGENTS_MD_OK' in d.get('content','')
    print(f'  content: {d.get(\"content\",\"\")[:80]}')
    print('✅ T55.9' if ok else '❌ T55.9')
"
```

---

## 三、验证 AGENTS.md 在会话中生效

### T55.10 发消息验证指令生效

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
ok = 'PROJECT_AGENTS_MD_OK' in reply
print('✅ T55.10' if ok else '❌ T55.10')
"
```

**期望**：AI 回复包含 `PROJECT_AGENTS_MD_OK`，说明 Project AGENTS.md 指令已注入到 Session system prompt。

---

## 四、Session 隔离

### T55.11 不同 Project 的 AGENTS.md 隔离

```bash
# 创建第二个 Project
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" -H 'Content-Type: application/json' \
  -d '{"name":"agentsmd-test-2","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","auth":{"type":"none"}}}')
PROJECT_ID_2=$(echo "$RES2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 配置不同的 AGENTS.md
python3 -c "
import json, urllib.request
body = json.dumps({'content':'PROJECT_B_UNIQUE'}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID_2/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

# 创建第二个 Session
SID2=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID_2\",\"title\":\"isolation-test\"}" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 验证隔离
A=$(curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/agents-md" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('content','')[:50] if d else '')")
B=$(curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID2/agents-md" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('content','')[:50] if d else '')")
echo "A=$A  B=$B"
[ "$A" != "$B" ] && echo "✅ T55.11 隔离" || echo "❌ T55.11"
```

---

## 五、PG 持久化与清理

### T55.12 Project AGENTS.md PG 唯一性

```bash
COUNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM project_agents_md WHERE project_id='$PROJECT_ID'")
[ "$COUNT" = "1" ] && echo "✅ T55.12 唯一" || echo "❌ T55.12 count=$COUNT"
```

### T55.13 Session AGENTS.md PG 持久化

```bash
COUNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM session_agents_md WHERE session_id='$SESSION_ID'")
[ "$COUNT" = "1" ] && echo "✅ T55.13 Session PG" || echo "❌ T55.13 count=$COUNT"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T55.1 | 创建 Project | ✅ |
| T55.2 | 空状态 | ✅ |
| T55.3 | 创建 AGENTS.md | ✅ |
| T55.4 | 读取内容 | ✅ |
| T55.5 | 替换内容（upsert） | ✅ |
| T55.6 | PG 持久化 | ✅ |
| T55.7 | 删除 AGENTS.md | ✅ |
| T55.8 | 创建 Session 传 projectId | ✅ |
| T55.9 | Session AGENTS.md 自动注入 | ✅ |
| T55.10 | 指令生效验证 | ✅ |
| T55.11 | 跨 Project 隔离 | ✅ |
| T55.12 | Project PG 唯一性 | ✅ |
| T55.13 | Session PG 持久化 | ✅ |
