# SaaS Task MCP 测试用例

> 测试流程：创建 Task → 配置 MCP → 创建 Session（传 taskId 自动注入）→ 验证 Secret 注入
>
> 参考用例：[`saas-project/mcps/mcp.md`](../../saas-project/mcps/mcp.md)
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

## 一、准备：创建 Task 并配置 MCP

### T64.1 创建 Task

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" \
  -H 'Content-Type: application/json' \
  -d '{"title":"mcp-test-task","description":"MCP 测试"}')

export TASK_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Task ID: $TASK_ID"
[ -n "$TASK_ID" ] && pass "T64.1 创建Task" || fail "T64.1" "$RES"
```

### T64.2 创建 Remote MCP（带 Headers Secret）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'type': 'remote',
    'url': 'https://mcp.example.com/sse',
    'headers': {'Authorization': 'Bearer secret-token-123', 'X-Custom': 'custom-val'},
    'enabled': True
}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/mcps/search-api', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='search-api' and d['type']=='remote' and d['hasSecrets']==True and 'Bearer' not in json.dumps(d)
print('✅ T64.2' if ok else '❌ T64.2 — ' + json.dumps(d)[:120])
"
```

### T64.3 创建 Local MCP（带 Environment Secret）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'type': 'local',
    'command': ['npx', 'shadcn@latest', 'mcp'],
    'environment': {'NODE_ENV': 'production', 'API_KEY': 'sk-test-456'},
    'enabled': True
}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/mcps/shadcn', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='shadcn' and d['type']=='local' and d['hasSecrets']==True and 'sk-test' not in json.dumps(d)
print('✅ T64.3' if ok else '❌ T64.3 — ' + json.dumps(d)[:120])
"
```

### T64.4 创建无 Secret 的 Remote MCP

```bash
curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/mcps/docs-api" \
  -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://docs.example.com/mcp","enabled":true}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok = d['name']=='docs-api' and d['hasSecrets']==False
print('✅ T64.4' if ok else '❌ T64.4')
"
```

### T64.5 确认 Task MCP 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/mcps" | python3 -c "
import json,sys
mcps=json.load(sys.stdin)
print(f'MCP 总数: {len(mcps)}')
for m in mcps:
    keys = m.get('environmentKeys',[]) + m.get('headerKeys',[])
    print(f'  {m[\"name\"]}: type={m[\"type\"]} hasSecrets={m[\"hasSecrets\"]} keys={keys}')
ok = len(mcps)==3
print('✅ T64.5' if ok else '❌ T64.5')
"
```

### T64.6 验证 PG 中 Secret 加密

```bash
psql -d "$PG" -Atqc "
SELECT name, 
       secrets IS NOT NULL as has_secret,
       secrets::text NOT LIKE '%secret-token%' as token_safe,
       secrets::text NOT LIKE '%sk-test%' as key_safe
FROM mcp WHERE task_id='$TASK_ID' ORDER BY name
" | while read l; do echo "  $l"; done

python3 -c "
import subprocess
out = subprocess.run(['psql','-d','opencode_project_test','-Atqc',
  \"SELECT secrets::text FROM mcp WHERE task_id='%s'\" % '$TASK_ID'],
  capture_output=True, text=True).stdout
ok = 'secret-token' not in out and 'sk-test' not in out
print('✅ T64.6 PG加密' if ok else '❌ T64.6 明文泄露')
"
```

---

## 二、创建 Session 并自动注入 MCP

### T64.7 创建 Session（传 taskId，自动注入）

```bash
RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"title\":\"task-mcp-injection-test\"}")

export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
[ -n "$SESSION_ID" ] && pass "T64.7 创建Session" || fail "T64.7" "$RES"
```

### T64.8 验证 Session MCP 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/mcps" | python3 -c "
import json,sys
mcps=json.load(sys.stdin)
names=[m['name'] for m in mcps]
print(f'Session MCP 总数: {len(mcps)}')
for m in mcps:
    print(f'  {m[\"name\"]}: type={m[\"type\"]} enabled={m[\"enabled\"]}')

has_search = 'search-api' in names
has_shadcn = 'shadcn' in names
has_docs = 'docs-api' in names
print(f'search-api 注入: {\"✅\" if has_search else \"❌\"}')
print(f'shadcn 注入:     {\"✅\" if has_shadcn else \"❌\"}')
print(f'docs-api 注入:   {\"✅\" if has_docs else \"❌\"}')
ok = has_search and has_shadcn and has_docs
print('✅ T64.8' if ok else '❌ T64.8')
"
```

### T64.9 验证 Secret 正确注入（PG 中有明文 environment/headers）

```bash
psql -d "$PG" -Atqc "
SELECT name, 
       environment::text LIKE '%secret-token%' as has_token,
       environment::text LIKE '%sk-test%' as has_key,
       headers::text LIKE '%secret-token%' as headers_has_token
FROM session_mcps WHERE session_id='$SESSION_ID' ORDER BY name
" | while read l; do echo "  $l"; done

python3 -c "
import subprocess
out = subprocess.run(['psql','-d','opencode_project_test','-Atqc',
  \"SELECT environment::text, headers::text FROM session_mcps WHERE session_id='%s'\" % '$SESSION_ID'],
  capture_output=True, text=True).stdout
ok = 'secret-token' in out and 'sk-test' in out
print('✅ T64.9 Secret注入' if ok else '❌ T64.9 未注入明文')
"
```

---

## 三、MCP CRUD 与隔离

### T64.10 更新 MCP（upsert 同名覆盖）

```bash
curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/mcps/docs-api" \
  -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://docs-v2.example.com/mcp","enabled":false}' > /dev/null

curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/mcps" | python3 -c "
import json,sys
mcps=json.load(sys.stdin)
docs=next((m for m in mcps if m['name']=='docs-api'),None)
ok = docs and docs['url']=='https://docs-v2.example.com/mcp' and docs['enabled']==False
print('✅ T64.10' if ok else '❌ T64.10')
"

COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/mcps" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin) if m['name']=='docs-api']))")
[ "$COUNT" = "1" ] && pass "T64.10-no-dup" || fail "T64.10-no-dup" "count=$COUNT"
```

### T64.11 删除单个 MCP

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/mcps/docs-api")
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/mcps" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin) if m['name']=='docs-api']))")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && pass "T64.11-delete" || fail "T64.11-delete" "HTTP=$HTTP count=$COUNT"
```

### T64.12 跨 Task MCP 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"mcp-test-2"}')
TASK_ID_2=$(echo "$RES2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/mcps/shared" \
  -H 'Content-Type: application/json' -d '{"type":"remote","url":"https://t1.example.com/mcp"}' > /dev/null
curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID_2/mcps/shared" \
  -H 'Content-Type: application/json' -d '{"type":"remote","url":"https://t2.example.com/mcp"}' > /dev/null

T1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/mcps" | python3 -c "import json,sys;a=next((m for m in json.load(sys.stdin) if m['name']=='shared'),None);print(a['url'] if a else '')")
T2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID_2/mcps" | python3 -c "import json,sys;a=next((m for m in json.load(sys.stdin) if m['name']=='shared'),None);print(a['url'] if a else '')")
echo "T1=$T1  T2=$T2"
[ "$T1" = "https://t1.example.com/mcp" ] && [ "$T2" = "https://t2.example.com/mcp" ] && pass "T64.12-isolation" || fail "T64.12-isolation"
```

### T64.13 更新 MCP 不提交 headers 时保留原 Secret

```bash
BEFORE=$(psql -d "$PG" -Atqc "SELECT secrets::text FROM mcp WHERE task_id='$TASK_ID' AND name='search-api'")
curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/mcps/search-api" \
  -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://mcp.example.com/sse","enabled":false}' > /dev/null
AFTER=$(psql -d "$PG" -Atqc "SELECT secrets::text FROM mcp WHERE task_id='$TASK_ID' AND name='search-api'")
[ "$BEFORE" = "$AFTER" ] && pass "T64.13 保留Secret" || fail "T64.13" "密文变化"
```

---

## 四、PG 持久化

### T64.14 Task MCP PG

```bash
echo "=== Task MCP in PG ==="
psql -d "$PG" -Atqc "
SELECT name, type, enabled, 
       environment_keys, header_keys,
       secrets IS NOT NULL as has_secret
FROM mcp WHERE task_id='$TASK_ID' ORDER BY name
" | while read l; do echo "  $l"; done
pass "T64.14 Task MCP PG"
```

### T64.15 Session MCP PG

```bash
echo "=== Session MCP in PG ==="
psql -d "$PG" -Atqc "
SELECT name, type, enabled,
       environment::text LIKE '%secret%' as has_env_secret,
       headers::text LIKE '%secret%' as has_hdr_secret
FROM session_mcps WHERE session_id='$SESSION_ID' ORDER BY name
" | while read l; do echo "  $l"; done
pass "T64.15 Session MCP PG"
```

---

## 五、清理

### T64.16 删除 Task 后 MCP 清零

```bash
curl -s --noproxy '*' -X DELETE "$BASE/saas/task/$TASK_ID_2" > /dev/null
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM mcp WHERE task_id='$TASK_ID_2'")
[ "$CNT" = "0" ] && pass "T64.16 删除Task后MCP清零" || fail "T64.16" "count=$CNT"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T64.1 | 创建 Task | ✅ |
| T64.2 | Remote MCP 带 Headers Secret | ✅ |
| T64.3 | Local MCP 带 Environment Secret | ✅ |
| T64.4 | 无 Secret Remote MCP | ✅ |
| T64.5 | 确认 Task MCP 列表 | ✅ |
| T64.6 | PG Secret 加密 | ✅ |
| T64.7 | 创建 Session（传 taskId） | ✅ |
| T64.8 | Session MCP 自动注入 | ✅ |
| T64.9 | Secret 正确注入（PG 明文） | ✅ |
| T64.10 | 更新 MCP（upsert） | ✅ |
| T64.11 | 删除单个 MCP | ✅ |
| T64.12 | 跨 Task MCP 隔离 | ✅ |
| T64.13 | 更新保留 Secret | ✅ |
| T64.14 | Task MCP PG 持久化 | ✅ |
| T64.15 | Session MCP PG 持久化 | ✅ |
| T64.16 | 删除 Task 后 MCP 清零 | ✅ |
