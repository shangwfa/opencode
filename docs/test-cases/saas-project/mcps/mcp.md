# SaaS Project MCP 测试用例

> 测试流程：创建 Project → 配置 MCP（含 Secret）→ 创建 Session（传 projectId 自动注入）→ 验证 MCP 在会话中生效
>
> 参考用例：[`docs/test-cases/mcps/session-mcp.md`](../../mcps/session-mcp.md)
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

## 一、创建 Project 并配置 MCP

### T54.1 创建 Project

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" \
  -H 'Content-Type: application/json' \
  -d '{"name":"mcp-test-project","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","defaultBranch":"main","auth":{"type":"none"}}}')
export PROJECT_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Project ID: $PROJECT_ID"
```

### T54.2 创建 Remote MCP（带 Headers Secret）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'type': 'remote',
    'url': 'https://mcp.example.com/sse',
    'headers': {'Authorization': 'Bearer secret-token-123', 'X-Custom': 'custom-val'},
    'enabled': True
}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/mcps/search-api', data=body, headers={'Content-Type':'application/json'}, method='PUT')
resp = urllib.request.urlopen(req)
d = json.loads(resp.read())
ok = d['name']=='search-api' and d['type']=='remote' and d['hasSecrets']==True and 'Bearer' not in json.dumps(d)
print(json.dumps({'ok':ok,'name':d['name'],'type':d['type'],'hasSecrets':d['hasSecrets'],'headerKeys':d['headerKeys']}))
"
```

**期望**：`type=remote`，`hasSecrets=true`，`headerKeys=["Authorization","X-Custom"]`，响应不含 `Bearer`。

### T54.3 创建 Local MCP（带 Environment Secret）

```bash
python3 -c "
import json, urllib.request
body = json.dumps({
    'type': 'local',
    'command': ['npx', 'shadcn@latest', 'mcp'],
    'environment': {'NODE_ENV': 'production', 'API_KEY': 'sk-test-456'},
    'enabled': True
}).encode()
req = urllib.request.Request('$BASE/saas/project/$PROJECT_ID/mcps/shadcn', data=body, headers={'Content-Type':'application/json'}, method='PUT')
resp = urllib.request.urlopen(req)
d = json.loads(resp.read())
ok = d['name']=='shadcn' and d['type']=='local' and d['hasSecrets']==True and 'sk-test' not in json.dumps(d)
print(json.dumps({'ok':ok,'name':d['name'],'type':d['type'],'hasSecrets':d['hasSecrets'],'environmentKeys':d['environmentKeys']}))
"
```

**期望**：`type=local`，`hasSecrets=true`，`environmentKeys=["NODE_ENV","API_KEY"]`，响应不含 `sk-test`。

### T54.4 创建无 Secret 的 Remote MCP

```bash
curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/mcps/docs-api" \
  -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://docs.example.com/mcp","enabled":true}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok = d['name']=='docs-api' and d['hasSecrets']==False
print('✅ T54.4' if ok else '❌ T54.4')
"
```

### T54.5 确认 Project MCP 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/mcps" | python3 -c "
import json,sys
mcps=json.load(sys.stdin)
print(f'MCP 总数: {len(mcps)}')
for m in mcps:
    print(f'  {m[\"name\"]}: type={m[\"type\"]} hasSecrets={m[\"hasSecrets\"]} keys={m.get(\"environmentKeys\",[])+m.get(\"headerKeys\",[])}')
ok = len(mcps)==3
print('✅ T54.5' if ok else '❌ T54.5')
"
```

### T54.6 验证 PG 中 Secret 加密

```bash
psql -d "$PG" -Atqc "
SELECT name, 
       secrets IS NOT NULL as has_secret,
       secrets::text NOT LIKE '%secret-token%' as token_safe,
       secrets::text NOT LIKE '%sk-test%' as key_safe
FROM mcp WHERE project_id='$PROJECT_ID' ORDER BY name
"
```

**期望**：search-api 和 shadcn 的 `has_secret=t`，token_safe=t，key_safe=t（密文中不含明文）。

---

## 二、创建 Session 并自动注入 MCP

### T54.7 创建 Session（传 projectId，自动注入 Agent + Skill + MCP）

```bash
RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"mcp-injection-test\"}")
export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SESSION_ID"
```

### T54.8 验证 Session MCP 列表

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
print()
print(f'search-api 注入: {\"✅\" if has_search else \"❌\"}')
print(f'shadcn 注入:     {\"✅\" if has_shadcn else \"❌\"}')
print(f'docs-api 注入:   {\"✅\" if has_docs else \"❌\"}')
ok = has_search and has_shadcn and has_docs
print('✅ T54.8' if ok else '❌ T54.8')
"
```

### T54.9 验证 Secret 正确注入（PG 中有明文 environment/headers）

```bash
psql -d "$PG" -Atqc "
SELECT name, 
       environment::text LIKE '%secret-token%' as has_token,
       environment::text LIKE '%sk-test%' as has_key,
       headers::text LIKE '%secret-token%' as headers_has_token
FROM session_mcps WHERE session_id='$SESSION_ID' ORDER BY name
"
```

**期望**：search-api 的 `headers_has_token=t`，shadcn 的 `has_key=t`（Session MCP 存储的是明文，从 Project 解密后注入）。

---

## 三、MCP CRUD 与隔离

### T54.10 更新 MCP（upsert 同名覆盖）

```bash
curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/mcps/docs-api" \
  -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://docs-v2.example.com/mcp","enabled":false}' > /dev/null

curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/mcps" | python3 -c "
import json,sys
mcps=json.load(sys.stdin)
docs=next((m for m in mcps if m['name']=='docs-api'),None)
ok = docs and docs['url']=='https://docs-v2.example.com/mcp' and docs['enabled']==False
print('✅ T54.10' if ok else '❌ T54.10')
"

COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/mcps" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin) if m['name']=='docs-api']))")
[ "$COUNT" = "1" ] && echo "✅ T54.10-no-dup" || echo "❌ T54.10-no-dup count=$COUNT"
```

### T54.11 删除单个 MCP

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/project/$PROJECT_ID/mcps/docs-api")
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/mcps" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin) if m['name']=='docs-api']))")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && echo "✅ T54.11 delete" || echo "❌ T54.11 HTTP=$HTTP count=$COUNT"
```

### T54.12 跨 Project MCP 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" -H 'Content-Type: application/json' \
  -d '{"name":"mcp-test-project-2","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","auth":{"type":"none"}}}')
PROJECT_ID_2=$(echo "$RES2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/mcps/shared" \
  -H 'Content-Type: application/json' -d '{"type":"remote","url":"https://p1.example.com/mcp"}' > /dev/null
curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID_2/mcps/shared" \
  -H 'Content-Type: application/json' -d '{"type":"local","command":["echo","p2"]}' > /dev/null

P1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/mcps" | python3 -c "import json,sys;m=next((x for x in json.load(sys.stdin) if x['name']=='shared'),None);print(m['type'] if m else '')")
P2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID_2/mcps" | python3 -c "import json,sys;m=next((x for x in json.load(sys.stdin) if x['name']=='shared'),None);print(m['type'] if m else '')")
[ "$P1" = "remote" ] && [ "$P2" = "local" ] && echo "✅ T54.12 隔离" || echo "❌ T54.12 P1=$P1 P2=$P2"
```

---

## 四、MCP 更新保留已有 Secret

### T54.13 更新 MCP 不提交 headers 时保留原 Secret

```bash
# 记录更新前
BEFORE=$(psql -d "$PG" -Atqc "SELECT secrets::text FROM mcp WHERE project_id='$PROJECT_ID' AND name='search-api'")

# PUT 仅修改 enabled，不提交 headers
curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/mcps/search-api" \
  -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://mcp.example.com/sse","enabled":false}' > /dev/null

AFTER=$(psql -d "$PG" -Atqc "SELECT secrets::text FROM mcp WHERE project_id='$PROJECT_ID' AND name='search-api'")
[ "$BEFORE" = "$AFTER" ] && echo "✅ T54.13 保留Secret" || echo "❌ T54.13 密文变化"
```

---

## 五、PG 持久化验证

### T54.14 Project MCP PG 持久化

```bash
psql -d "$PG" -Atqc "
SELECT name, type, enabled, 
       environment_keys, header_keys,
       secrets IS NOT NULL as has_secret
FROM mcp WHERE project_id='$PROJECT_ID' ORDER BY name
"
```

### T54.15 Session MCP PG 持久化

```bash
psql -d "$PG" -Atqc "
SELECT name, type, enabled,
       environment::text LIKE '%secret%' as has_env_secret,
       headers::text LIKE '%secret%' as has_hdr_secret
FROM session_mcps WHERE session_id='$SESSION_ID' ORDER BY name
"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T54.1 | 创建 Project | ✅ |
| T54.2 | Remote MCP（Headers Secret） | ✅ |
| T54.3 | Local MCP（Environment Secret） | ✅ |
| T54.4 | 无 Secret Remote MCP | ✅ |
| T54.5 | Project MCP 列表 | ✅ |
| T54.6 | PG Secret 加密验证 | ✅ |
| T54.7 | 创建 Session 传 projectId | ✅ |
| T54.8 | Session MCP 自动注入 | ✅ |
| T54.9 | Secret 正确解密注入 | ✅ |
| T54.10 | upsert 同名覆盖 | ✅ |
| T54.11 | 删除单个 MCP | ✅ |
| T54.12 | 跨 Project 隔离 | ✅ |
| T54.13 | 更新保留已有 Secret | ✅ |
| T54.14 | Project MCP PG 持久化 | ✅ |
| T54.15 | Session MCP PG 持久化 | ✅ |
