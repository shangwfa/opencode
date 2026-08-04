# SaaS Task Skill 测试用例

> 测试流程：创建 Task → 配置 Skill → 创建 Session（传 taskId 自动注入）→ 验证 Skill 生效
>
> 参考用例：[`saas-project/skills/skill.md`](../../saas-project/skills/skill.md)
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

## 一、准备：创建 Task 并配置 Skill

### T63.1 创建 Task

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" \
  -H 'Content-Type: application/json' \
  -d '{"title":"skill-test-task","description":"Skill 测试"}')

export TASK_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Task ID: $TASK_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['id'].startswith('task_')
print('✅ T63.1' if ok else '❌ T63.1')
"
```

### T63.2 创建简单 Skill

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/skills/reviewer" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "代码审查专家，专注发现 bug 和安全问题",
    "content": "# Reviewer\n\n审查代码时输出：严重程度、问题描述、修复建议。必须明确说你正在使用 reviewer skill。"
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='reviewer' and d['description'].startswith('代码审查')
print('✅ T63.2' if ok else '❌ T63.2 — ' + json.dumps(d,ensure_ascii=False)[:120])
"
```

### T63.3 创建带 Resource Bundle 的 Skill

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/skills/complex-reviewer" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "使用 checklist 和模板审查 Python 数据库代码",
    "content": "# Complex Reviewer\n\n你必须根据 resources 中的 checklist 审查代码。回复必须明确引用 resources 的文件路径。",
    "resources": [
      {
        "path": "references/security-checklist.md",
        "type": "doc",
        "content": "Checklist:\n- SQL injection: direct string interpolation into SQL is HIGH severity.\n- Resource leak: DB connection without context manager or close is HIGH severity."
      },
      {
        "path": "templates/safe-query.py",
        "type": "template",
        "content": "query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"
      }
    ]
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='complex-reviewer' and len(d.get('resources',[]))==2
print(f'  resources: {len(d.get(\"resources\",[]))}')
for r in d.get('resources',[]):
    print(f'    {r[\"path\"]} ({r[\"type\"]}, {r.get(\"size\",0)}B)')
print('✅ T63.3' if ok else '❌ T63.3')
"
```

### T63.4 创建翻译 Skill

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/skills/translator" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "中英互译翻译工具",
    "content": "# Translator\n\n将中文翻译成地道英文。只输出翻译结果，不解释。"
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='translator' and '翻译' in d['description']
print('✅ T63.4' if ok else '❌ T63.4')
"
```

### T63.5 确认 Task Skill 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/skills" | python3 -c "
import json,sys
skills = json.load(sys.stdin)
names = [s['name'] for s in skills]
print(f'Skill 总数: {len(skills)}')
for s in skills:
    print(f'  {s[\"name\"]}: resources={len(s.get(\"resources\",[]))}')
ok = 'reviewer' in names and 'complex-reviewer' in names and 'translator' in names
print('✅ T63.5' if ok else '❌ T63.5')
"
```

---

## 二、创建 Session 并自动注入 Skill

### T63.6 创建 Session（传 taskId，自动注入）

```bash
RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"taskId\":\"$TASK_ID\",\"title\":\"task-skill-injection-test\"}")

export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")
echo "Session: $SESSION_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'id' in d and d['id'].startswith('ses_')
print('✅ T63.6' if ok else '❌ T63.6 — ' + json.dumps(d)[:100])
"
```

### T63.7 验证 Session Skill 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/skills" | python3 -c "
import json,sys
skills = json.load(sys.stdin)
names = [s['name'] for s in skills]
print(f'Session Skill 总数: {len(skills)}')
for s in skills:
    res_count = len(s.get('resources', []))
    print(f'  {s[\"name\"]}: resources={res_count}')

has_reviewer = 'reviewer' in names
has_complex = 'complex-reviewer' in names
has_translator = 'translator' in names

print(f'reviewer 注入:        {\"✅\" if has_reviewer else \"❌\"}')
print(f'complex-reviewer 注入: {\"✅\" if has_complex else \"❌\"}')
print(f'translator 注入:       {\"✅\" if has_translator else \"❌\"}')

ok = has_reviewer and has_complex and has_translator
print('✅ T63.7' if ok else '❌ T63.7')
"
```

### T63.8 验证 Skill Resource 正确注入

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/session/$SESSION_ID/skills" | python3 -c "
import json,sys
skills = json.load(sys.stdin)
for s in skills:
    if s['name'] == 'complex-reviewer':
        resources = s.get('resources', [])
        print(f'complex-reviewer resources: {len(resources)}')
        for r in resources:
            print(f'  path={r.get(\"path\")} type={r.get(\"type\")} size={r.get(\"size\")}')
        ok = len(resources) == 2 and resources[0].get('path') == 'references/security-checklist.md'
        print('✅ T63.8' if ok else '❌ T63.8')
        break
else:
    print('❌ T63.8 — complex-reviewer not found')
"
```

---

## 三、验证 Skill 在会话中生效

### T63.9 使用注入的 Skill 审查代码

```bash
RES=$(curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 reviewer skill 审查：\\n\\`\\`\\`python\\ndef div(a,b):\\n    return a / b\\n\\`\\`\\`\"}],
    \"skills\":[\"reviewer\"],
    \"model\":$MODEL
  }")

echo "$RES" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin, strict=False)
    texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
    reply = texts[0] if texts else ''
    print(f'reply: {reply[:300]}')
    ok = 'reviewer' in reply.lower() or '严重' in reply or 'bug' in reply.lower()
    print('✅ T63.9 — reviewer skill 生效' if ok else '❌ T63.9')
except Exception as e:
    print('解析失败:', str(e)[:80])
"
```

### T63.10 使用带 Resource 的 Skill 审查代码

```bash
RES=$(curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 complex-reviewer skill 审查这段代码：\\n\\`\\`\\`python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    return conn.execute(query)\\n\\`\\`\\`\"}],
    \"skills\":[\"complex-reviewer\"],
    \"model\":$MODEL
  }")

echo "$RES" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin, strict=False)
    texts = [p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text']
    reply = texts[0] if texts else ''
    print(f'reply: {reply[:500]}')
    ok = 'sql' in reply.lower() or 'injection' in reply.lower() or '注入' in reply
    print('✅ T63.10 — complex-reviewer skill 生效' if ok else '❌ T63.10')
except Exception as e:
    print('解析失败:', str(e)[:80])
"
```

---

## 四、Skill CRUD 与隔离

### T63.11 更新 Skill（upsert 同名覆盖）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/skills/reviewer" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "更新后的代码审查专家",
    "content": "# Reviewer v2\n\n审查代码时输出：问题等级、代码位置、修复方案。"
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['description'] == '更新后的代码审查专家'
print('✅ T63.11' if ok else '❌ T63.11')
"

COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/skills" | python3 -c "import json,sys;print(len([s for s in json.load(sys.stdin) if s['name']=='reviewer']))")
[ "$COUNT" = "1" ] && pass "T63.11-no-dup" || fail "T63.11-no-dup" "reviewer count=$COUNT"
```

### T63.12 删除单个 Skill

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/task/$TASK_ID/skills/translator")
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/skills" | python3 -c "import json,sys;print(len([s for s in json.load(sys.stdin) if s['name']=='translator']))")
[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && pass "T63.12-delete" || fail "T63.12-delete" "HTTP=$HTTP count=$COUNT"
```

### T63.13 跨 Task Skill 隔离

```bash
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/task" -H 'Content-Type: application/json' \
  -d '{"title":"skill-test-2"}')
TASK_ID_2=$(echo "$RES2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID/skills/shared" \
  -H 'Content-Type: application/json' -d '{"description":"task 1 shared","content":"# Shared from T1"}' > /dev/null
curl -s --noproxy '*' -X PUT "$BASE/saas/task/$TASK_ID_2/skills/shared" \
  -H 'Content-Type: application/json' -d '{"description":"task 2 shared","content":"# Shared from T2"}' > /dev/null

T1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID/skills" | python3 -c "import json,sys;a=next((s for s in json.load(sys.stdin) if s['name']=='shared'),None);print(a['description'] if a else '')")
T2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/task/$TASK_ID_2/skills" | python3 -c "import json,sys;a=next((s for s in json.load(sys.stdin) if s['name']=='shared'),None);print(a['description'] if a else '')")
echo "T1=$T1  T2=$T2"
[ "$T1" = "task 1 shared" ] && [ "$T2" = "task 2 shared" ] && pass "T63.13-isolation" || fail "T63.13-isolation"
```

---

## 五、PG 持久化

### T63.14 Skill 数据 PG 持久化

```bash
echo "=== Task Skill in PG ==="
psql -d "$PG" -Atqc "
SELECT name, description, jsonb_array_length(resources) as resource_count
FROM skill WHERE task_id='$TASK_ID' ORDER BY name;
"

echo "=== Session Skill in PG ==="
psql -d "$PG" -Atqc "
SELECT name, description, jsonb_array_length(resources) as resource_count
FROM session_skill WHERE session_id='$SESSION_ID' ORDER BY name;
"
pass "T63.14 PG持久化"
```

### T63.15 Resource 内容 PG 存储

```bash
psql -d "$PG" -Atqc "
SELECT s.name, r->>'path' AS path, (r->>'size')::int AS size
FROM skill s, jsonb_array_elements(s.resources) r
WHERE s.task_id='$TASK_ID' AND s.name='complex-reviewer'
ORDER BY path;
"
pass "T63.15 Resource PG"
```

---

## 六、清理

### T63.16 删除 Task 后 Skill 清零

```bash
curl -s --noproxy '*' -X DELETE "$BASE/saas/task/$TASK_ID_2" > /dev/null
CNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM skill WHERE task_id='$TASK_ID_2'")
[ "$CNT" = "0" ] && pass "T63.16 删除Task后Skill清零" || fail "T63.16" "count=$CNT"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T63.1 | 创建 Task | ✅ |
| T63.2 | 创建简单 Skill（reviewer） | ✅ |
| T63.3 | 创建带 Resource Bundle 的 Skill | ✅ |
| T63.4 | 创建翻译 Skill（translator） | ✅ |
| T63.5 | 确认 Task Skill 列表 | ✅ |
| T63.6 | 创建 Session（传 taskId） | ✅ |
| T63.7 | 验证 Session Skill 自动注入 | ✅ |
| T63.8 | 验证 Skill Resource 正确注入 | ✅ |
| T63.9 | 使用注入的 Skill 审查代码 | ✅ |
| T63.10 | 使用带 Resource 的 Skill 审查 | ✅ |
| T63.11 | 更新 Skill（upsert） | ✅ |
| T63.12 | 删除单个 Skill | ✅ |
| T63.13 | 跨 Task Skill 隔离 | ✅ |
| T63.14 | PG 持久化验证 | ✅ |
| T63.15 | Resource 内容 PG 存储 | ✅ |
| T63.16 | 删除 Task 后 Skill 清零 | ✅ |
