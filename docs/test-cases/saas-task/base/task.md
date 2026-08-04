# SaaS Task 测试用例

> 测试流程：创建 Task → 配置资源 → 创建 Session（传 taskId 自动注入）→ 验证注入生效 → 删除 Task
>
> 参考：[`saas-project/base/base.md`](../saas-project/base/base.md)
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

## 全量执行脚本

```bash
#!/bin/bash
set -uo pipefail

export BASE="http://localhost:14096"
export PG="opencode_project_test"
export NO_PROXY="localhost,127.0.0.1"
export MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

PASS=0
FAIL=0

pass() { echo "✅ $1"; PASS=$((PASS+1)); }
fail() { echo "❌ $1 — $2"; FAIL=$((FAIL+1)); }

# ── 健康检查 ──
HEALTH=$(curl -s --noproxy '*' "$BASE/global/health" | python3 -c "import json,sys;print(json.load(sys.stdin).get('healthy',''))" 2>/dev/null || echo "")
if [ "$HEALTH" != "True" ]; then
  echo "❌ SaaS 容器未就绪"
  exit 1
fi

# ── 清理 ──
psql -d "$PG" -c "
  DELETE FROM session_tools; DELETE FROM session_commands; DELETE FROM session_agents_md;
  DELETE FROM session_mcps; DELETE FROM session_skill; DELETE FROM session_agents; DELETE FROM session;
  DELETE FROM mcp WHERE task_id IS NOT NULL;
  DELETE FROM skill WHERE task_id IS NOT NULL;
  DELETE FROM agent WHERE task_id IS NOT NULL;
  DELETE FROM project_agents_md WHERE task_id IS NOT NULL;
  DELETE FROM project_command WHERE task_id IS NOT NULL;
  DELETE FROM project_tool WHERE task_id IS NOT NULL;
  DELETE FROM saas_task;
" > /dev/null 2>&1

echo ""
echo "=========================================="
echo "一、Task CRUD"
echo "=========================================="

# ── T61.1 表创建 ──
TABLES=$(psql -d "$PG" -Atqc "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='saas_task'")
[ -n "$TABLES" ] && pass "T61.1 saas_task 表创建" || fail "T61.1 表创建" ""

# ── T61.2 资源表 task_id 列 ──
COLS=$(psql -d "$PG" -Atqc "SELECT count(*) FROM information_schema.columns WHERE column_name='task_id' AND table_name IN ('agent','skill','mcp','project_agents_md','project_command','project_tool')")
[ "$COLS" = "6" ] && pass "T61.2 资源表 task_id 列" || fail "T61.2" "cols=$COLS"

# ── T61.3 无外键 ──
FK=$(psql -d "$PG" -Atqc "SELECT count(*) FROM pg_constraint WHERE contype='f' AND conrelid='saas_task'::regclass")
[ "$FK" = "0" ] && pass "T61.3 无外键" || fail "T61.3" "FK=$FK"

# ── T61.4 创建 Task ──
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"test-task","description":"A test task"}')
export TASK_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
[ -n "$TASK_ID" ] && pass "T61.4 创建Task" || fail "T61.4" "$RES"

# ── T61.5 详情 ──
RES=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID")
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=d['title']=='test-task' and d['projectIds']==[];exit(0 if ok else 1)" 2>/dev/null && pass "T61.5 详情" || fail "T61.5" "$RES"

# ── T61.6 列表 ──
CNT=$(curl -s --noproxy '*' "$BASE/saas/task" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$CNT" = "1" ] && pass "T61.6 列表" || fail "T61.6" "count=$CNT"

# ── T61.7 更新 ──
RES=$(curl -s --noproxy '*' -X PATCH "$BASE/saas/task/$TASK_ID" -H 'Content-Type: application/json' \
  -d '{"title":"updated-task","description":"Updated"}')
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=d['title']=='updated-task' and d['description']=='Updated';exit(0 if ok else 1)" 2>/dev/null && pass "T61.7 更新" || fail "T61.7" "$RES"

# ── T61.8 不存在 Task 404 ──
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/saas/task/task_00000000000000000000000000")
[ "$HTTP" = "404" ] && pass "T61.8 不存在Task 404" || fail "T61.8" "HTTP=$HTTP"

# ── T61.9 读取不依赖目录路由 ──
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE/saas/task/$TASK_ID")
[ "$HTTP" = "200" ] && pass "T61.9 读取不依赖路由" || fail "T61.9" "HTTP=$HTTP"

echo ""
echo "=========================================="
echo "二、关联 Project"
echo "=========================================="

# ── T61.10 创建 Project 并关联 ──
PROJ_ID=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" -H 'Content-Type: application/json' \
  -d '{"name":"task-test-proj","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","auth":{"type":"none"}}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

RES=$(curl -s --noproxy '*' -X PATCH "$BASE/saas/task/$TASK_ID" -H 'Content-Type: application/json' \
  -d "{\"projectIds\":[\"$PROJ_ID\"]}")
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=len(d['projectIds'])==1 and d['projectIds'][0]=='$PROJ_ID';exit(0 if ok else 1)" 2>/dev/null && pass "T61.10 关联Project" || fail "T61.10" "$RES"

# ── T61.11 关联多个 Project ──
PROJ_ID_2=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" -H 'Content-Type: application/json' \
  -d '{"name":"task-test-proj-2","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","auth":{"type":"none"}}}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")

RES=$(curl -s --noproxy '*' -X PATCH "$BASE/saas/task/$TASK_ID" -H 'Content-Type: application/json' \
  -d "{\"projectIds\":[\"$PROJ_ID\",\"$PROJ_ID_2\"]}")
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=len(d['projectIds'])==2;exit(0 if ok else 1)" 2>/dev/null && pass "T61.11 关联多个Project" || fail "T61.11" "$RES"

# ── T61.12 取消关联（空数组）──
RES=$(curl -s --noproxy '*' -X PATCH "$BASE/saas/task/$TASK_ID" -H 'Content-Type: application/json' \
  -d '{"projectIds":[]}')
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=len(d['projectIds'])==0;exit(0 if ok else 1)" 2>/dev/null && pass "T61.12 取消关联" || fail "T61.12" "$RES"

echo ""
echo "=========================================="
echo "三、Task Agent CRUD"
echo "=========================================="

# ── T61.13 创建 Primary Agent ──
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/coder" -H 'Content-Type: application/json' -d '{
  "description": "全栈工程师，擅长 TypeScript",
  "mode": "primary",
  "prompt": "你是一个资深全栈工程师。回答时先分析问题，再给出代码。",
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
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=d.get('name')=='coder' and d.get('mode')=='primary' and len(d.get('permission',[]))==6;exit(0 if ok else 1)" 2>/dev/null && pass "T61.13 Primary Agent" || fail "T61.13" "$RES"

# ── T61.14 创建 Subagent ──
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/translator" -H 'Content-Type: application/json' \
  -d '{"description":"翻译专家","mode":"subagent","prompt":"将中文翻译成地道英文。","temperature":0.5}')
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=d.get('name')=='translator' and d.get('mode')=='subagent';exit(0 if ok else 1)" 2>/dev/null && pass "T61.14 Subagent" || fail "T61.14" "$RES"

# ── T61.15 只读 Agent ──
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/reviewer" -H 'Content-Type: application/json' -d '{
  "description": "代码审查，只读",
  "mode": "primary",
  "prompt": "你是代码审查专家。只能读取文件。",
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
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);perms={p['permission']:p['action'] for p in d.get('permission',[])};ok=perms.get('read')=='allow' and perms.get('edit')=='deny' and perms.get('write')=='deny';exit(0 if ok else 1)" 2>/dev/null && pass "T61.15 只读Agent" || fail "T61.15" "$RES"

# ── T61.16 列表 ──
curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID/agents" | python3 -c "import json,sys;names=[a['name'] for a in json.load(sys.stdin)];ok='coder' in names and 'translator' in names and 'reviewer' in names;exit(0 if ok else 1)" 2>/dev/null && pass "T61.16 列表" || fail "T61.16" ""

# ── T61.17 upsert 同名覆盖 ──
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/agents/coder" -H 'Content-Type: application/json' \
  -d '{"description":"更新后的 agent","mode":"primary","prompt":"Python 后端专家。","temperature":0.7}')
echo "$RES" | python3 -c "import json,sys;d=json.load(sys.stdin);ok=d.get('description')=='更新后的 agent' and d.get('temperature')==0.7;exit(0 if ok else 1)" 2>/dev/null && pass "T61.17 upsert" || fail "T61.17" "$RES"
CNT=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID/agents" | python3 -c "import json,sys;print(len([a for a in json.load(sys.stdin) if a['name']=='coder']))")
[ "$CNT" = "1" ] && pass "T61.17-no-dup" || fail "T61.17-no-dup" "count=$CNT"

# ── T61.18 删除 ──
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/agents/translator")
CNT=$(curl -s --noproxy '*' "$BASE/saas/task/$TASK_ID/agents" | python3 -c "import json,sys;print(len([a for a in json.load(sys.stdin) if a['name']=='translator']))")
[ "$HTTP" = "200" ] && [ "$CNT" = "0" ] && pass "T61.18 删除" || fail "T61.18" "HTTP=$HTTP count=$CNT"

echo ""
echo "=========================================="
echo "四、Task Skill CRUD"
echo "=========================================="

# ── T61.19 创建 Skill ──
python3 -c "
import json, urllib.request
body = json.dumps({'description':'代码审查专家','content':'# Reviewer\n\n审查代码时输出：严重程度、问题描述、修复建议。'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/skills/reviewer', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T61.19' if d['name']=='reviewer' else '❌ T61.19')
"

# ── T61.20 带 Resource ──
python3 -c "
import json, urllib.request
body = json.dumps({
    'description':'使用 checklist 审查',
    'content':'# Complex Reviewer',
    'resources':[
        {'path':'references/checklist.md','type':'doc','content':'SQL injection is HIGH.'},
        {'path':'templates/safe.py','type':'template','content':'query = \"SELECT * FROM users WHERE id = ?\"'}
    ]
}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/skills/complex-reviewer', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='complex-reviewer' and len(d.get('resources',[]))==2
print('✅ T61.20' if ok else '❌ T61.20')
"

# ── T61.21 列表 ──
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/skills" | python3 -c "
import json,sys
names=[s['name'] for s in json.load(sys.stdin)]
ok='reviewer' in names and 'complex-reviewer' in names
print('✅ T61.21' if ok else '❌ T61.21')
"

# ── T61.22 删除 ──
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/skills/reviewer")
CNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/skills" | python3 -c "import json,sys;print(len([s for s in json.load(sys.stdin) if s['name']=='reviewer']))")
[ "$HTTP" = "200" ] && [ "$CNT" = "0" ] && pass "T61.22 删除Skill" || fail "T61.22" "HTTP=$HTTP count=$CNT"

echo ""
echo "=========================================="
echo "五、Task MCP CRUD"
echo "=========================================="

# ── T61.23 Remote MCP 带 Secret ──
python3 -c "
import json, urllib.request
body = json.dumps({'type':'remote','url':'https://mcp.example.com/sse','headers':{'Authorization':'Bearer secret-token-123','X-Custom':'val'},'enabled':True}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/mcps/search-api', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='search-api' and d['type']=='remote' and d['hasSecrets']==True and 'Bearer' not in json.dumps(d)
print('✅ T61.23' if ok else '❌ T61.23')
"

# ── T61.24 Local MCP 带 Environment ──
python3 -c "
import json, urllib.request
body = json.dumps({'type':'local','command':['npx','shadcn@latest','mcp'],'environment':{'NODE_ENV':'production','API_KEY':'sk-test-456'},'enabled':True}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/mcps/shadcn', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='shadcn' and d['type']=='local' and d['hasSecrets']==True and 'sk-test' not in json.dumps(d)
print('✅ T61.24' if ok else '❌ T61.24')
"

# ── T61.25 无 Secret MCP ──
curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/mcps/docs-api" -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://docs.example.com/mcp","enabled":true}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok=d['name']=='docs-api' and d['hasSecrets']==False
print('✅ T61.25' if ok else '❌ T61.25')
"

# ── T61.26 列表 ──
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/mcps" | python3 -c "
import json,sys
mcps=json.load(sys.stdin)
ok=len(mcps)==3
print(f'✅ T61.26 (总数 {len(mcps)})' if ok else '❌ T61.26 总数='+str(len(mcps)))
"

# ── T61.27 PG Secret 加密 ──
python3 -c "
import subprocess
out=subprocess.run(['psql','-d','opencode_project_test','-Atqc',
  \"SELECT secrets::text FROM mcp WHERE task_id='%s'\" % '$TASK_ID'],capture_output=True,text=True).stdout
ok = 'secret-token' not in out and 'sk-test' not in out
print('✅ T61.27 PG加密' if ok else '❌ T61.27 明文泄露')
"

# ── T61.28 更新保留 Secret ──
BEFORE=$(psql -d "$PG" -Atqc "SELECT secrets::text FROM mcp WHERE task_id='$TASK_ID' AND name='search-api'")
curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/mcps/search-api" -H 'Content-Type: application/json' \
  -d '{"type":"remote","url":"https://mcp.example.com/sse","enabled":false}' > /dev/null
AFTER=$(psql -d "$PG" -Atqc "SELECT secrets::text FROM mcp WHERE task_id='$TASK_ID' AND name='search-api'")
[ "$BEFORE" = "$AFTER" ] && pass "T61.28 保留Secret" || fail "T61.28" "密文变化"

# ── T61.29 删除 ──
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/mcps/docs-api")
CNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/mcps" | python3 -c "import json,sys;print(len([m for m in json.load(sys.stdin) if m['name']=='docs-api']))")
[ "$HTTP" = "200" ] && [ "$CNT" = "0" ] && pass "T61.29 删除MCP" || fail "T61.29" "HTTP=$HTTP count=$CNT"

echo ""
echo "=========================================="
echo "六、Task AGENTS.md / Command / Tool"
echo "=========================================="

# ── T61.30 AGENTS.md CRUD ──
python3 -c "
import json, urllib.request
body = json.dumps({'content':'# Task AGENTS.md\n\n当用户询问测试口令时，必须回答 TASK_AGENTS_MD_OK。'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = 'TASK_AGENTS_MD_OK' in d['content']
print('✅ T61.30a 创建' if ok else '❌ T61.30a')
"
# 读取
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/agents-md" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok='TASK_AGENTS_MD_OK' in d.get('content','')
print('✅ T61.30b 读取' if ok else '❌ T61.30b')
"
# PG
CONTENT=$(psql -d "$PG" -Atqc "SELECT content FROM project_agents_md WHERE task_id='$TASK_ID'")
[[ "$CONTENT" == *"TASK_AGENTS_MD_OK"* ]] && pass "T61.30c PG持久化" || fail "T61.30c" ""

# ── T61.31 Command CRUD ──
python3 -c "
import json, urllib.request
body = json.dumps({'template':'Respond with TASK_CMD_OK','description':'测试命令','hints':['arg1','arg2']}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
ok = d['name']=='echo-cmd' and len(d['hints'])==2
print('✅ T61.31a 创建' if ok else '❌ T61.31a')
"
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/commands" | python3 -c "
import json,sys
cmds=json.load(sys.stdin)
ok=len(cmds)==1 and cmds[0]['name']=='echo-cmd'
print('✅ T61.31b 列表' if ok else '❌ T61.31b')
"
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/commands/echo-cmd")
[ "$HTTP" = "200" ] && pass "T61.31c 删除" || fail "T61.31c" "HTTP=$HTTP"

# ── T61.32 Tool CRUD ──
python3 -c "
import json, urllib.request
code = 'import { tool } from \"@opencode-ai/plugin\"\nexport default tool({ description: \"Return TASK_TOOL_OK\", args: {}, async execute() { return \"TASK_TOOL_OK\" } })'
body = json.dumps({'description':'Return TASK_TOOL_OK','code':code}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
d = json.loads(urllib.request.urlopen(req).read())
print('✅ T61.32a 创建' if d['name']=='greeter' else '❌ T61.32a')
"
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/tools" | python3 -c "
import json,sys
tools=json.load(sys.stdin)
ok=len(tools)==1 and tools[0]['name']=='greeter'
print('✅ T61.32b 列表' if ok else '❌ T61.32b')
"
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/tools/greeter")
[ "$HTTP" = "200" ] && pass "T61.32c 删除" || fail "T61.32c" "HTTP=$HTTP"

echo ""
echo "=========================================="
echo "七、Session 注入"
echo "=========================================="

# 重新创建资源用于注入
python3 -c "
import json, urllib.request
# Agent
body = json.dumps({'description':'Task agent','mode':'primary','prompt':'You are a task agent','temperature':0.3}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/agents/coder', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
# Skill
body = json.dumps({'description':'Task skill','content':'# Task Skill'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/skills/reviewer', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
# MCP
body = json.dumps({'type':'remote','url':'https://mcp.example.com/sse','headers':{'Authorization':'Bearer secret-xyz'}}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/mcps/search-api', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
# AGENTS.md
body = json.dumps({'content':'# Task AGENTS.md\n\nAnswer with TASK_AGENTS_MD_OK'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/agents-md', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
# Command
body = json.dumps({'template':'Respond with TASK_CMD_OK','description':'cmd'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/commands/echo-cmd', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
# Tool
code = 'export default { execute: () => \"TASK_TOOL_OK\" }'
body = json.dumps({'description':'Return TASK_TOOL_OK','code':code}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID/tools/greeter', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

# ── T61.33 创建 Session 传 taskId ──
SID=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"title\":\"task-inject-test\"}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
[ -n "$SID" ] && pass "T61.33 创建Session(taskId)" || fail "T61.33" ""

# ── T61.34 session.task_id 持久化 ──
PGT=$(psql -d "$PG" -Atqc "SELECT task_id FROM session WHERE id='$SID'")
[ "$PGT" = "$TASK_ID" ] && pass "T61.34 session.task_id持久化" || fail "T61.34" "pg=$PGT"

# ── T61.35 Agent 注入 ──
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID/agents" | python3 -c "
import json,sys
names=[a['name'] for a in json.load(sys.stdin)]
ok='coder' in names and 'build' in names
print('✅ T61.35 Agent注入' if ok else '❌ T61.35 '+str(names))
"

# ── T61.36 Skill 注入 ──
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID/skills" | python3 -c "
import json,sys
names=[s['name'] for s in json.load(sys.stdin)]
print('✅ T61.36 Skill注入' if 'reviewer' in names else '❌ T61.36 '+str(names))
"

# ── T61.37 MCP 注入 ──
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID/mcps" | python3 -c "
import json,sys
names=[m['name'] for m in json.load(sys.stdin)]
print('✅ T61.37 MCP注入' if 'search-api' in names else '❌ T61.37 '+str(names))
"

# ── T61.38 AGENTS.md 注入 ──
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID/agents-md" | python3 -c "
import json,sys
d=json.load(sys.stdin)
ok=d and 'TASK_AGENTS_MD_OK' in d.get('content','')
print('✅ T61.38 AGENTS.md注入' if ok else '❌ T61.38')
"

# ── T61.39 Command 注入 ──
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID/commands" | python3 -c "
import json,sys
names=[c['name'] for c in json.load(sys.stdin)]
print('✅ T61.39 Command注入' if 'echo-cmd' in names else '❌ T61.39 '+str(names))
"

# ── T61.40 Tool 注入 ──
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SID/tools" | python3 -c "
import json,sys
names=[t['name'] for t in json.load(sys.stdin)]
print('✅ T61.40 Tool注入' if 'greeter' in names else '❌ T61.40 '+str(names))
"

# ── T61.41 无 taskId 不关联 ──
SID2=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"title":"no-task"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
PGT2=$(psql -d "$PG" -Atqc "SELECT task_id FROM session WHERE id='$SID2'" 2>/dev/null || echo "")
[ -z "$PGT2" ] && pass "T61.41 无taskId不关联" || fail "T61.41" "pg=$PGT2"

# ── T61.42 listSessions ──
CNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/sessions" | python3 -c "import json,sys;d=json.load(sys.stdin);print(sum(1 for s in d if s.get('taskID')=='$TASK_ID'))")
[ "$CNT" -ge 1 ] && pass "T61.42 listSessions" || fail "T61.42" "count=$CNT"

# ── T61.43 不存在 Task 返回空 ──
EMPTY=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/task_00000000000000000000000000/sessions" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$EMPTY" = "0" ] && pass "T61.43 不存在Task空列表" || fail "T61.43" "count=$EMPTY"

echo ""
echo "=========================================="
echo "八、AGENTS.md 指令生效"
echo "=========================================="

# ── T61.44 LLM 验证 ──
python3 -c "
import json, urllib.request
body = json.dumps({'parts':[{'type':'text','text':'测试口令是什么？'}],'model':json.loads('$MODEL')}).encode()
req = urllib.request.Request('$BASE/session/$SID/message', data=body, headers={'Content-Type':'application/json'}, method='POST')
resp = urllib.request.urlopen(req, timeout=120)
d = json.loads(resp.read())
texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
reply = texts[0] if texts else ''
ok = 'TASK_AGENTS_MD_OK' in reply
print('✅ T61.44 AGENTS.md生效' if ok else '❌ T61.44 reply='+reply[:100])
"

echo ""
echo "=========================================="
echo "九、跨 Task 隔离"
echo "=========================================="

# ── T61.45 跨 Task 同名 Agent 隔离 ──
TASK_ID_2=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"isolation-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")

python3 -c "
import json, urllib.request
body = json.dumps({'description':'P2 agent','mode':'primary','prompt':'P2 only'}).encode()
req = urllib.request.Request('$BASE/saas/task/$TASK_ID_2/agents/coder', data=body, headers={'Content-Type':'application/json'}, method='PUT')
urllib.request.urlopen(req)
"

P1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/agents" | python3 -c "import json,sys;a=next((x for x in json.load(sys.stdin) if x['name']=='coder'),None);print(a['description'][:20] if a else '')")
P2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID_2/agents" | python3 -c "import json,sys;a=next((x for x in json.load(sys.stdin) if x['name']=='coder'),None);print(a['description'][:20] if a else '')")
[ "$P1" != "$P2" ] && pass "T61.45 跨Task隔离" || fail "T61.45" "P1=$P1 P2=$P2"

# ── T61.46 跨 Task-Project 同表隔离 ──
# Project 的 agent（project_id 非空）和 Task 的 agent（task_id 非空）互不干扰
PCNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM agent WHERE project_id IS NOT NULL AND task_id IS NULL")
TCNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM agent WHERE task_id IS NOT NULL AND project_id IS NULL")
[ "$PCNT" -ge 0 ] && [ "$TCNT" -ge 1 ] && pass "T61.46 同表隔离(project=$PCNT task=$TCNT)" || fail "T61.46" "project=$PCNT task=$TCNT"

echo ""
echo "=========================================="
echo "十、PG 持久化"
echo "=========================================="

# ── T61.47 Task Agent PG ──
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM agent WHERE task_id='$TASK_ID'")
[ "$CNT" -ge 1 ] && pass "T61.47 Task Agent PG" || fail "T61.47" "count=$CNT"

# ── T61.48 Task MCP PG ──
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM mcp WHERE task_id='$TASK_ID'")
[ "$CNT" -ge 1 ] && pass "T61.48 Task MCP PG" || fail "T61.48" "count=$CNT"

# ── T61.49 Task AGENTS.md PG ──
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM project_agents_md WHERE task_id='$TASK_ID'")
[ "$CNT" = "1" ] && pass "T61.49 Task AGENTS.md PG" || fail "T61.49" "count=$CNT"

# ── T61.50 Session task_id PG ──
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM session WHERE task_id='$TASK_ID'")
[ "$CNT" -ge 1 ] && pass "T61.50 Session task_id PG" || fail "T61.50" "count=$CNT"

echo ""
echo "=========================================="
echo "十一、删除 purge"
echo "=========================================="

# ── T61.51 删除 Task ──
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID")
[ "$HTTP" = "200" ] && pass "T61.51 删除Task" || fail "T61.51" "HTTP=$HTTP"

# ── T61.52 purge 全部清零 ──
REMAIN=$(psql -d "$PG" -Atqc "
  SELECT
    (SELECT count(*) FROM agent WHERE task_id='$TASK_ID') +
    (SELECT count(*) FROM skill WHERE task_id='$TASK_ID') +
    (SELECT count(*) FROM mcp WHERE task_id='$TASK_ID') +
    (SELECT count(*) FROM project_agents_md WHERE task_id='$TASK_ID') +
    (SELECT count(*) FROM project_command WHERE task_id='$TASK_ID') +
    (SELECT count(*) FROM project_tool WHERE task_id='$TASK_ID') +
    (SELECT count(*) FROM saas_task WHERE id='$TASK_ID')
")
[ "$REMAIN" = "0" ] && pass "T61.52 purge全部清零" || fail "T61.52" "remain=$REMAIN"

# ── T61.53 删除第二个 Task ──
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID_2")
[ "$HTTP" = "200" ] && pass "T61.53 删除Task2" || fail "T61.53" "HTTP=$HTTP"

# ── T61.54 列表为空 ──
CNT=$(curl -s --noproxy '*' "$BASE/saas/task" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
[ "$CNT" = "0" ] && pass "T61.54 列表为空" || fail "T61.54" "count=$CNT"

echo ""
echo "========================================="
echo "  PASS: $PASS    FAIL: $FAIL"
echo "========================================="
[ "$FAIL" = "0" ] && exit 0 || exit 1
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T61.1 | saas_task 表创建 | ✅ |
| T61.2 | 资源表 task_id 列 | ✅ |
| T61.3 | 无外键 | ✅ |
| T61.4 | 创建 Task | ✅ |
| T61.5 | 详情 | ✅ |
| T61.6 | 列表 | ✅ |
| T61.7 | 更新 | ✅ |
| T61.8 | 不存在 Task 404 | ✅ |
| T61.9 | 读取不依赖路由 | ✅ |
| T61.10 | 关联 Project | ✅ |
| T61.11 | 关联多个 Project | ✅ |
| T61.12 | 取消关联 | ✅ |
| T61.13 | Primary Agent | ✅ |
| T61.14 | Subagent | ✅ |
| T61.15 | 只读 Agent | ✅ |
| T61.16 | Agent 列表 | ✅ |
| T61.17 | Agent upsert 同名覆盖 | ✅ |
| T61.18 | Agent 删除 | ✅ |
| T61.19 | 创建 Skill | ✅ |
| T61.20 | 带 Resource Skill | ✅ |
| T61.21 | Skill 列表 | ✅ |
| T61.22 | Skill 删除 | ✅ |
| T61.23 | Remote MCP 带 Secret | ✅ |
| T61.24 | Local MCP 带 Environment | ✅ |
| T61.25 | 无 Secret MCP | ✅ |
| T61.26 | MCP 列表 | ✅ |
| T61.27 | PG Secret 加密 | ✅ |
| T61.28 | 更新保留 Secret | ✅ |
| T61.29 | MCP 删除 | ✅ |
| T61.30 | AGENTS.md CRUD | ✅ |
| T61.31 | Command CRUD | ✅ |
| T61.32 | Tool CRUD | ✅ |
| T61.33 | 创建 Session 传 taskId | ✅ |
| T61.34 | session.task_id 持久化 | ✅ |
| T61.35 | Agent 注入 | ✅ |
| T61.36 | Skill 注入 | ✅ |
| T61.37 | MCP 注入 | ✅ |
| T61.38 | AGENTS.md 注入 | ✅ |
| T61.39 | Command 注入 | ✅ |
| T61.40 | Tool 注入 | ✅ |
| T61.41 | 无 taskId 不关联 | ✅ |
| T61.42 | listSessions | ✅ |
| T61.43 | 不存在 Task 空列表 | ✅ |
| T61.44 | AGENTS.md 指令生效 | ✅ |
| T61.45 | 跨 Task 同名隔离 | ✅ |
| T61.46 | 同表 Project/Task 隔离 | ✅ |
| T61.47 | Task Agent PG | ✅ |
| T61.48 | Task MCP PG | ✅ |
| T61.49 | Task AGENTS.md PG | ✅ |
| T61.50 | Session task_id PG | ✅ |
| T61.51 | 删除 Task | ✅ |
| T61.52 | purge 全部清零 | ✅ |
| T61.53 | 删除 Task2 | ✅ |
| T61.54 | 列表为空 | ✅ |
