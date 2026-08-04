# SaaS Project Skill 测试用例

> 测试流程：创建 Project → 配置 Skill → 创建 Session（传 projectId 自动注入）→ 验证 Skill 在会话中生效
>
> 前置：已完成 `base/base.md` 中的 Project 创建（T51.4）
>
> 参考用例：[`docs/test-cases/skills/session-skills.md`](../../skills/session-skills.md)
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

## 一、准备：创建 Project 并配置 Skill

### T53.1 创建 Project

```bash
RES=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" \
  -H 'Content-Type: application/json' \
  -d '{"name":"skill-test-project","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","defaultBranch":"main","auth":{"type":"none"}}}')

export PROJECT_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Project ID: $PROJECT_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['id'].startswith('prj_') and d['repository']['connectionStatus'] == 'verified'
print('✅ T53.1' if ok else '❌ T53.1')
"
```

### T53.2 创建简单 Skill

参考 `session-skills.md` T15.1 的 reviewer skill：

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/skills/reviewer" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "代码审查专家，专注发现 bug 和安全问题",
    "content": "# Reviewer\n\n审查代码时输出：严重程度、问题描述、修复建议。必须明确说你正在使用 reviewer skill。"
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='reviewer' and d['description'].startswith('代码审查')
print('✅ T53.2' if ok else '❌ T53.2 — ' + json.dumps(d,ensure_ascii=False)[:120])
"
```

**期望**：

| 字段 | 值 |
|---|---|
| `name` | `reviewer` |
| `description` | `代码审查专家...` |
| `resources` | `[]` |

### T53.3 创建带 Resource Bundle 的 Skill

参考 `session-skills.md` T15.2 的 complex-reviewer skill：

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/skills/complex-reviewer" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "使用 checklist 和模板审查 Python 数据库代码",
    "content": "# Complex Reviewer\n\n你必须根据 resources 中的 checklist 和模板审查代码。回复必须明确引用 resources 的文件路径。",
    "resources": [
      {
        "path": "references/security-checklist.md",
        "type": "doc",
        "content": "Checklist:\n- SQL injection: direct string interpolation into SQL is HIGH severity.\n- Resource leak: DB connection without context manager or close is HIGH severity.\n- Return concrete rows, not raw cursors."
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
    print(f'    {r[\"path\"]} ({r[\"type\"]}, {r[\"size\"]}B)')
print('✅ T53.3' if ok else '❌ T53.3')
"
```

**期望**：

| 字段 | 值 |
|---|---|
| `name` | `complex-reviewer` |
| `resources.length` | 2 |
| `resources[0].path` | `references/security-checklist.md` |
| `resources[1].path` | `templates/safe-query.py` |

### T53.4 创建 Subagent Skill（翻译）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/skills/translator" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "中英互译翻译工具",
    "content": "# Translator\n\n将中文翻译成地道英文，或将英文翻译成自然中文。只输出翻译结果，不解释。"
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['name']=='translator' and '翻译' in d['description']
print('✅ T53.4' if ok else '❌ T53.4')
"
```

### T53.5 确认 Project Skill 列表

```bash
curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/skills" | python3 -c "
import json,sys
skills = json.load(sys.stdin)
names = [s['name'] for s in skills]
print(f'Skill 总数: {len(skills)}')
for s in skills:
    print(f'  {s[\"name\"]}: resources={len(s.get(\"resources\",[]))}')
ok = 'reviewer' in names and 'complex-reviewer' in names and 'translator' in names
print('✅ T53.5' if ok else '❌ T53.5')
"
```

**期望**：列表包含 `reviewer`、`complex-reviewer`、`translator` 三个 skill。

---

## 二、创建 Session 并自动注入 Skill

### T53.6 创建 Session（传 projectId，自动注入 Skill）

> 前置：`Session.CreateInput` 已支持 `projectId` 参数，创建时自动注入 Project 的 Agent。
> Skill 注入逻辑与 Agent 类似：读取 Project Skill → 注册到 Session。

```bash
RES=$(curl -s --noproxy '*' --max-time 15 -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\",\"title\":\"skill-injection-test\"}")

export SESSION_ID=$(echo "$RES" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
echo "Session: $SESSION_ID"

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = 'id' in d and d['id'].startswith('ses_')
print('✅ T53.6' if ok else '❌ T53.6 — ' + json.dumps(d)[:100])
"
```

### T53.7 验证 Session Skill 列表

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

print()
print(f'reviewer 注入:        {\"✅\" if has_reviewer else \"❌\"}')
print(f'complex-reviewer 注入: {\"✅\" if has_complex else \"❌\"}')
print(f'translator 注入:       {\"✅\" if has_translator else \"❌\"}')

ok = has_reviewer and has_complex and has_translator
print('✅ T53.7' if ok else '❌ T53.7')
"
```

**期望**：Session Skill 列表包含 Project 注入的 `reviewer`、`complex-reviewer`、`translator`。

### T53.8 验证 Skill Resource 正确注入

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
        print('✅ T53.8' if ok else '❌ T53.8')
        break
else:
    print('❌ T53.8 — complex-reviewer not found')
"
```

**期望**：`complex-reviewer` 的两个 resource（`security-checklist.md` 和 `safe-query.py`）正确注入。

---

## 三、验证 Skill 在会话中生效

### T53.9 使用注入的 Skill 审查代码

参考 `session-skills.md` T15.1 的审查场景：

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
    print('✅ T53.9 — reviewer skill 生效' if ok else '❌ T53.9')
except Exception as e:
    print('解析失败:', str(e)[:80])
"
```

**期望**：AI 回复中明确提到 `reviewer skill`，并按「严重程度、问题描述、修复建议」格式审查代码。

### T53.10 使用带 Resource 的 Skill 审查代码

参考 `session-skills.md` T15.2 的复杂审查场景：

```bash
RES=$(curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SESSION_ID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 complex-reviewer skill 审查这段代码：\\n\\`\\`\\`python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    result = conn.execute(query)\\n    return result\\n\\`\\`\\`\"}],
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
    print('✅ T53.10 — complex-reviewer skill 生效' if ok else '❌ T53.10')
except Exception as e:
    print('解析失败:', str(e)[:80])
"
```

**期望**：AI 回复中引用 resources 文件路径，识别 SQL 注入、连接泄漏等问题。

---

## 四、Skill CRUD 与隔离

### T53.11 更新 Skill（upsert 同名覆盖）

```bash
RES=$(curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/skills/reviewer" \
  -H 'Content-Type: application/json' \
  -d '{
    "description": "更新后的代码审查专家",
    "content": "# Reviewer v2\n\n审查代码时输出：问题等级、代码位置、修复方案。"
  }')

echo "$RES" | python3 -c "
import json,sys
d = json.load(sys.stdin)
ok = d['description'] == '更新后的代码审查专家'
print('✅ T53.11' if ok else '❌ T53.11')
"

# 验证只有一个 reviewer（无重复）
COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/skills" | python3 -c "import json,sys;print(len([s for s in json.load(sys.stdin) if s['name']=='reviewer']))")
[ "$COUNT" = "1" ] && pass "T53.11-no-dup" || fail "T53.11-no-dup" "reviewer count=$COUNT"
```

### T53.12 删除单个 Skill

```bash
HTTP=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' -X DELETE "$BASE/saas/project/$PROJECT_ID/skills/translator")

COUNT=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/skills" | python3 -c "import json,sys;print(len([s for s in json.load(sys.stdin) if s['name']=='translator']))")

[ "$HTTP" = "200" ] && [ "$COUNT" = "0" ] && pass "T53.12-delete" || fail "T53.12-delete" "HTTP=$HTTP count=$COUNT"
```

### T53.13 跨 Project Skill 隔离

```bash
# 创建第二个 Project
RES2=$(curl -s --noproxy '*' -X POST "$BASE/saas/project" \
  -H 'Content-Type: application/json' \
  -d '{"name":"skill-test-project-2","repository":{"provider":"github","url":"https://github.com/Martian-Engineering/lossless-claw.git","auth":{"type":"none"}}}')
PROJECT_ID_2=$(echo "$RES2" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 两个 Project 创建同名 Skill
curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID/skills/shared" \
  -H 'Content-Type: application/json' \
  -d '{"description":"project 1 shared","content":"# Shared from P1"}' > /dev/null

curl -s --noproxy '*' -X PUT "$BASE/saas/project/$PROJECT_ID_2/skills/shared" \
  -H 'Content-Type: application/json' \
  -d '{"description":"project 2 shared","content":"# Shared from P2"}' > /dev/null

# 验证隔离
P1=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID/skills" | python3 -c "import json,sys;a=next((s for s in json.load(sys.stdin) if s['name']=='shared'),None);print(a['description'] if a else '')")
P2=$(curl -s --noproxy '*' --max-time 10 "$BASE/saas/project/$PROJECT_ID_2/skills" | python3 -c "import json,sys;a=next((s for s in json.load(sys.stdin) if s['name']=='shared'),None);print(a['description'] if a else '')")

echo "P1=$P1  P2=$P2"
[ "$P1" = "project 1 shared" ] && [ "$P2" = "project 2 shared" ] && pass "T53.13-isolation" || fail "T53.13-isolation"
```

---

## 五、PG 持久化验证

### T53.14 Skill 数据 PG 持久化

```bash
echo "=== Project Skill in PG ==="
psql -d "$PG" -Atqc "
SELECT name, description, jsonb_array_length(resources) as resource_count
FROM skill
WHERE project_id='$PROJECT_ID'
ORDER BY name;
"

echo ""
echo "=== Session Skill in PG ==="
psql -d "$PG" -Atqc "
SELECT name, description, jsonb_array_length(resources) as resource_count
FROM session_skill
WHERE session_id='$SESSION_ID'
ORDER BY name;
"
```

**期望**：

- `skill` 表有 Project 级 Skill 记录（reviewer、complex-reviewer、shared）
- `session_skill` 表有 Session 级 Skill 记录（自动注入的 reviewer、complex-reviewer、translator）

### T53.15 Resource 内容 PG 存储

```bash
psql -d "$PG" -Atqc "
SELECT s.name, r->>'path' AS path, (r->>'size')::int AS size
FROM skill s, jsonb_array_elements(s.resources) r
WHERE s.project_id='$PROJECT_ID' AND s.name='complex-reviewer'
ORDER BY path;
"
```

**期望**：

```text
complex-reviewer|references/security-checklist.md|<size>
complex-reviewer|templates/safe-query.py|<size>
```

---

## 六、清理

### T53.16 删除 Project 后 Skill 清理

```bash
# 删除 Project（软归档）
curl -s --noproxy '*' -X DELETE "$BASE/saas/project/$PROJECT_ID_2" > /dev/null

# Skill 数据仍在（归档不删除子资源）
COUNT=$(psql -d "$PG" -Atqc "SELECT count(*) FROM skill WHERE project_id='$PROJECT_ID_2'")
echo "归档后 Project 2 的 Skill 数: $COUNT (期望保留)"
```

---

## 当前实测结果

| 用例 | 场景 | 状态 |
|---|---|---|
| T53.1 | 创建 Project | ✅ |
| T53.2 | 创建简单 Skill（reviewer） | ✅ |
| T53.3 | 创建带 Resource Bundle 的 Skill | ✅ |
| T53.4 | 创建翻译 Skill（translator） | ✅ |
| T53.5 | 确认 Project Skill 列表 | ✅ |
| T53.6 | 创建 Session 传 projectId | ✅ |
| T53.7 | 验证 Session Skill 自动注入 | ⏳ 待 Skill 注入实现 |
| T53.8 | 验证 Skill Resource 正确注入 | ⏳ 待 Skill 注入实现 |
| T53.9 | 使用注入的 Skill 审查代码 | ⏳ 待 Skill 注入实现 |
| T53.10 | 使用带 Resource 的 Skill 审查 | ⏳ 待 Skill 注入实现 |
| T53.11 | 更新 Skill（upsert） | ✅ |
| T53.12 | 删除单个 Skill | ✅ |
| T53.13 | 跨 Project Skill 隔离 | ✅ |
| T53.14 | PG 持久化验证 | ✅ |
| T53.15 | Resource 内容 PG 存储 | ✅ |

> **T53.7-T53.10 说明**：当前 `Session.create` 已支持 `projectId` 自动注入 **Agent**（`session.ts` 的 `injectProjectAgents`），但 **Skill 自动注入**尚未实现。需要在 `injectProjectAgents` 旁加 `injectProjectSkills`，逻辑相同：读取 Project Skill → 调用 `Skill.sessionCreate` 注册到 Session。
