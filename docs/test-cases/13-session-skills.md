# Session Skills

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十五、Session Skills

本节验证 SaaS API 中 session 维度的 skills：创建、读取、删除、复杂 bundle、resources 注入，以及从 SkillsMP 拉取真实 skill bundle 后执行。所有请求都打容器服务 `BASE=http://localhost:14096`。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

### T15.1 简单 session skill 创建与触发

```bash
SID_SKILL=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-simple-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_SKILL/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"reviewer",
    "description":"代码审查专家，专注发现 bug 和安全问题",
    "content":"# Reviewer\n\n审查代码时输出：严重程度、问题描述、修复建议。必须明确说你正在使用 reviewer skill。"
  }' | python3 -m json.tool

curl -s --max-time 180 -X POST "$BASE/session/$SID_SKILL/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 reviewer skill 审查：\\n\\`\\`\\`python\\ndef div(a,b):\\n    return a / b\\n\\`\\`\\`\"}],
    \"skills\":[\"reviewer\"],
    \"model\":$MODEL
  }" | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:1200])"
```

**期望**：skill 创建返回 `resources: []`；AI 回复中明确提到 `reviewer skill`，并按「严重程度、问题描述、修复建议」格式审查代码。

### T15.2 复杂 session skill bundle 创建、读取与触发

```bash
SID_BUNDLE=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-bundle-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_BUNDLE/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"complex-reviewer",
    "description":"使用 checklist 和模板审查 Python 数据库代码",
    "content":"# Complex Reviewer\n\n你必须根据 resources 中的 checklist 和模板审查代码。回复必须明确引用 resources 的文件路径。",
    "resources":[
      {
        "path":"references/security-checklist.md",
        "type":"doc",
        "content":"Checklist:\n- SQL injection: direct string interpolation into SQL is HIGH severity.\n- Resource leak: DB connection without context manager or close is HIGH severity.\n- Return concrete rows, not raw cursors."
      },
      {
        "path":"templates/safe-query.py",
        "type":"template",
        "content":"query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"
      }
    ]
  }' | python3 -m json.tool

curl -s "$BASE/session/$SID_BUNDLE/skills" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print([(s['name'], [r['path'] for r in s.get('resources',[])]) for s in d])"

curl -s --max-time 180 -X POST "$BASE/session/$SID_BUNDLE/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 complex-reviewer skill 审查这段代码：\\n\\`\\`\\`python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    result = conn.execute(query)\\n    return result\\n\\`\\`\\`\"}],
    \"skills\":[\"complex-reviewer\"],
    \"model\":$MODEL
  }" | python3 -c "import json,sys;d=json.load(sys.stdin);t=''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text');print(t[:1800])"
```

**期望**：`GET /skills` 能读回 `references/security-checklist.md` 和 `templates/safe-query.py`；AI 回复中明确引用这两个资源路径，并识别 SQL 注入、连接泄漏、返回 raw cursor 等问题。

### T15.3 删除与清空 session skills

```bash
SID_DEL=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-delete-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

for name in complex-reviewer reviewer; do
  curl -s -X POST "$BASE/session/$SID_DEL/skills/create" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"description\":\"$name\",\"content\":\"# $name\"}" > /dev/null
done

curl -s "$BASE/session/$SID_DEL/skills" | python3 -c "import json,sys;print([s['name'] for s in json.load(sys.stdin)])"
curl -s -o /dev/null -w "delete_one_status=%{http_code}\n" -X DELETE "$BASE/session/$SID_DEL/skills/complex-reviewer"
curl -s "$BASE/session/$SID_DEL/skills" | python3 -c "import json,sys;print([s['name'] for s in json.load(sys.stdin)])"
curl -s -o /dev/null -w "clear_status=%{http_code}\n" -X DELETE "$BASE/session/$SID_DEL/skills"
curl -s "$BASE/session/$SID_DEL/skills" | python3 -m json.tool
```

**期望**：初始列表含两个 skills；删除单个返回 `204` 后只剩 `reviewer`；清空返回 `204` 后列表为 `[]`。

### T15.4 从目录加载 session skill bundle

`/session/:sessionID/skills/load` 读取的是 opencode 服务容器内路径，不是远端 sandbox 内路径。测试时先在 `opencode-saas-test` 容器内准备 `/workspace/skills`。

```bash
docker exec opencode-saas-test sh -lc 'mkdir -p /workspace/skills/complex-reviewer/references /workspace/skills/complex-reviewer/templates && cat > /workspace/skills/complex-reviewer/SKILL.md <<'"'"'EOF'"'"'
---
name: loaded-reviewer
description: 从目录加载的 Python DB 审查 skill
---

# Loaded Reviewer

你必须使用 resources 中的 checklist 和模板审查代码，并引用资源路径。
EOF
cat > /workspace/skills/complex-reviewer/references/security-checklist.md <<'"'"'EOF'"'"'
Checklist:
- SQL injection from f-string SQL is HIGH severity.
- Connection without with/close is HIGH severity.
EOF
cat > /workspace/skills/complex-reviewer/templates/safe-query.py <<'"'"'EOF'"'"'
query = "SELECT * FROM users WHERE id = ?"
with db.connect() as conn:
    return conn.execute(query, (user_id,)).fetchone()
EOF'

SID_LOAD=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-load-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_LOAD/skills/load" \
  -H 'Content-Type: application/json' \
  -d '{"path":"/workspace/skills"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print([(s['name'], [r['path'] for r in s.get('resources',[])]) for s in d])"

curl -s --max-time 180 -X POST "$BASE/session/$SID_LOAD/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 loaded-reviewer skill 审查：\\n\\`\\`\\`python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    return conn.execute(query)\\n\\`\\`\\`\"}],
    \"skills\":[\"loaded-reviewer\"],
    \"model\":$MODEL
  }" | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:1600])"
```

**期望**：加载结果含 `loaded-reviewer`，resources 包含 `references/security-checklist.md` 和 `templates/safe-query.py`；AI 回复中引用这两个资源路径。

### T15.5 从 SkillsMP 默认排序提取 10 个真实 skill bundle 并执行

SkillsMP API 没有无查询的列表接口，`/api/v1/skills` 返回 404。该用例使用最宽泛的 `q=skill`，不传 `category`，不传 `sortBy`，沿用 SkillsMP 默认排序。若第一页存在 GitHub 目录没有可拉取 `SKILL.md` 的条目，则继续取下一页补满 10 个。

```bash
python3 - <<'PY'
import json, re, urllib.parse, urllib.request

BASE='http://localhost:14096'
UA={'User-Agent':'opencode-skill-bundle-test'}

def get(url, timeout=60):
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()
def get_json(url, timeout=60): return json.loads(get(url, timeout))
def api(method,path,data=None,timeout=300):
    body=json.dumps(data).encode() if data is not None else None
    req=urllib.request.Request(BASE+path,data=body,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=timeout) as r:
        text=r.read().decode(); return json.loads(text) if text else None
def parse_github(url):
    m=re.match(r'https://github.com/([^/]+)/([^/]+)(?:/tree/([^/]+)/(.*))?$', url)
    if not m: raise ValueError(url)
    return m.group(1),m.group(2),m.group(3) or 'main',urllib.parse.unquote(m.group(4) or '')
def fm(text):
    if not text.startswith('---'): return {},text
    m=re.search(r'^---\s*\n(.*?)\n---\s*\n',text,re.S)
    if not m: return {},text
    raw=m.group(1); body=text[m.end():]; meta={}; lines=raw.splitlines(); i=0
    while i<len(lines):
        line=lines[i]
        if ':' not in line: i+=1; continue
        k,v=line.split(':',1); k=k.strip(); v=v.strip().strip('"').strip("'")
        if v in ('|','>'):
            block=[]; i+=1
            while i<len(lines) and (lines[i].startswith(' ') or not lines[i].strip()): block.append(lines[i].strip()); i+=1
            meta[k]=' '.join(x for x in block if x); continue
        meta[k]=v; i+=1
    return meta,body
def kind(p):
    if p.startswith('templates/'): return 'template'
    if p.startswith(('references/','docs/','rules/')): return 'doc'
    ext='.'+p.rsplit('.',1)[-1].lower() if '.' in p else ''
    if ext in ['.md','.mdx','.txt']: return 'doc'
    if ext in ['.sh','.bash','.zsh','.py','.js','.ts','.tsx','.jsx']: return 'script'
    return 'asset'
def extract(item, idx, seen):
    owner,repo,branch,root=parse_github(item['githubUrl'])
    tree=get_json(f'https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1')['tree']
    blobs=[x['path'] for x in tree if x.get('type')=='blob']
    skill_path=(root.rstrip('/')+'/SKILL.md').lstrip('/') if root else 'SKILL.md'
    if skill_path not in blobs:
        c=[p for p in blobs if p.endswith('/SKILL.md') or p=='SKILL.md']
        if not c: raise FileNotFoundError('SKILL.md')
        skill_path=c[0]; root=skill_path[:-len('/SKILL.md')] if skill_path.endswith('/SKILL.md') else ''
    else: root=root.rstrip('/')
    files=[p for p in blobs if p==skill_path or (root and p.startswith(root+'/'))]
    raw=f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/'
    meta,body=fm(get(raw+urllib.parse.quote(skill_path,safe='/')))
    name=meta.get('name') or item['name']
    if name in seen: name=f'{name}-{idx}'
    seen.add(name)
    resources=[]; total=len(body.encode())
    for file in sorted(files):
        if file==skill_path: continue
        rel=file[len(root)+1:] if root else file
        if rel.startswith('.') or rel.endswith(('.png','.jpg','.jpeg','.gif','.webp','.pdf','.zip','.mp3','.mp4')): continue
        content=get(raw+urllib.parse.quote(file,safe='/'))
        size=len(content.encode())
        if size>256*1024 or total+size>900*1024: continue
        resources.append({'path':rel,'type':kind(rel),'content':content}); total+=size
        if len(resources)>=64: break
    desc=meta.get('description') or item.get('description') or name
    return {'name':name,'description':desc[:1200],'content':body,'resources':resources,'githubUrl':item['githubUrl']}

print('health', urllib.request.urlopen(BASE+'/', timeout=20).status)
bundles=[]; seen=set(); page=1
while len(bundles)<10 and page<=3:
    data=get_json(f'https://skillsmp.com/api/v1/skills/search?q=skill&limit=10&page={page}')['data']['skills']
    for item in data:
        if len(bundles)>=10: break
        try:
            b=extract(item, len(bundles)+1, seen)
            bundles.append(b)
            print(f'extracted {len(bundles)} {b["name"]} resources={len(b["resources"])}')
        except Exception as e:
            print('skip', item.get('githubUrl'), type(e).__name__, str(e)[:100])
    page+=1
if len(bundles)<10: raise SystemExit(f'only {len(bundles)}')

s=api('POST','/session',{'title':'skillsmp-default-10-bundle-test'}); sid=s['id']; print('SID',sid)
for b in bundles:
    c=api('POST',f'/session/{sid}/skills/create',{k:b[k] for k in ['name','description','content','resources']})
    print('created',c['name'],'resources=',len(c.get('resources',[])))
listed=api('GET',f'/session/{sid}/skills')
print('listed_count',len(listed)); print('listed_names',', '.join(x['name'] for x in listed))
names=[b['name'] for b in bundles]
msg=api('POST',f'/session/{sid}/message',{
 'parts':[{'type':'text','text':'请验证当前从 SkillsMP 默认排序提取的 10 个 skills 是否可用。要求：按名称列出每个 skill；每个 skill 用一句话说明用途；如果有 resources，列出至少一个资源路径；最后总结这些 skills 覆盖的能力范围。'}],
 'skills':names,
 'model':{'providerID':'zhipuai','modelID':'glm-5.1'}
})
text='\n'.join(p.get('text','') for p in msg.get('parts',[]) if p.get('type')=='text')
print(text[:5000])
print('validation_names_mentioned',sum(1 for n in names if n in text),'/',len(names))
print('validation_resource_path_mentioned',any(r['path'] in text for b in bundles for r in b['resources']))
PY
```

**期望**：`listed_count 10`；`validation_names_mentioned 10 / 10`；`validation_resource_path_mentioned True`。实际已验证过的默认排序样例包含 `skill-eval-测评`、`SkillSentry`、`skill-evaluator`、`skill-stocktake`、`skill-architect`、`skills-jk-gha-pr-creation`、`skill-creator`、`skill-soulsaying`、`skill-retrospective`、`skill-optimizer`。

### T15.6 重复创建同名 skill（upsert 覆盖）

验证同一 session 内重复创建同名 skill 时，第二次 upsert 覆盖第一次的内容和 resources。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"upsert-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 第一次：v1 + 1 resource
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"checker","description":"v1","content":"# Checker V1\n必须说 V1","resources":[{"path":"a.md","type":"doc","content":"resource A"}]}'

# PG 验证：name=checker, description=v1, res_count=1
docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, description, jsonb_array_length(resources) as res_count FROM session_skill WHERE session_id='$SID';"

# 第二次：同一名字，不同内容和 resources
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"checker","description":"v2","content":"# Checker V2\n必须说 V2","resources":[{"path":"b.md","type":"doc","content":"resource B"},{"path":"c.md","type":"doc","content":"resource C"}]}'

# PG 验证：name=checker, description=v2, res_count=2（覆盖而非新增）
docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, description, jsonb_array_length(resources) as res_count FROM session_skill WHERE session_id='$SID';"

# API 验证：skills 列表只有 1 个
curl -s "$BASE/session/$SID/skills" | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(f'count={len(d)}, desc={[s[\"description\"] for s in d]}, resources={[[r[\"path\"] for r in s.get(\"resources\",[])] for s in d]}')"

# AI 验证：使用 v2 版本
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"使用 checker skill\"}],\"skills\":[\"checker\"],\"model\":$MODEL}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:400])"
```

**期望**：PG 第二次写入后 `description=v2`、`res_count=2`（resources 被 v2 覆盖）；skills 列表只有 1 个；AI 回复包含"V2"。

---

### T15.7 AI 通过 skill tool 按需加载 resource 内容

验证 AI 在需要时会主动调用 `skill` tool 加载指定 resource 的完整内容，而非仅看 skill 摘要。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"skill-tool-resource-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"db-reviewer",
    "description":"数据库代码审查 skill",
    "content":"# DB Reviewer\n使用 resources 中的 checklist 和模板审查数据库代码。必须先加载 resources 内容再审查。",
    "resources":[
      {"path":"checklist.md","type":"doc","content":"## 安全检查清单\n1. SQL注入: f-string拼接SQL是HIGH\n2. 连接泄漏: 不用with/close是HIGH\n3. 必须返回具体行，不能返回cursor"},
      {"path":"safe-template.py","type":"template","content":"query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"}
    ]
  }'

curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 db-reviewer skill 审查这段代码。注意：你需要先用 skill 工具加载 db-reviewer 的 resources 内容（checklist.md 和 safe-template.py），然后按 checklist 审查。\\n\\n代码:\\n```python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    return conn.execute(query)\\n```\"}],\"skills\":[\"db-reviewer\"],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:500])
    elif p.get('type')=='tool': print('Tool:', p.get('name',''), 'input:', json.dumps(p.get('input',{}))[:200])
"

# PG 验证：tool 调用记录
docker exec ai-nova-postgres psql -U postgres -d opencode -c \"
  SELECT p.data->>'name' as tool_name, substring(p.data->'state'->>'output', 1, 400) as output
  FROM message m JOIN part p ON p.message_id = m.id
  WHERE m.session_id='$SID' AND p.data->>'type'='tool';
\"
```

**期望**：PG `part` 表存在 `tool_name` 为空的 `skill` tool 调用，`output` 包含 `<skill_content name="db-reviewer">` 且包含 checklist 和 safe-template 内容；AI 回复引用了 checklist 条目（SQL 注入 HIGH、连接泄漏 HIGH）。

---

### T15.8 skill 不存在时的错误处理

验证当 AI 被引导使用不存在的 skill 时，能正确识别并给出明确的错误信息。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"skill-not-found-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 确认 skills 列表为空
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;print(json.load(sys.stdin))"

# AI 尝试使用不存在的 skill
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 nonexistent-skill-xyz 来帮我做代码审查\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:600])
    elif p.get('type')=='tool': print('Tool:', p.get('name',''), 'input:', json.dumps(p.get('input',{}))[:200])
"
```

**期望**：AI 不调用 `skill` tool（因为 `nonexistent-skill-xyz` 不在 available 列表中），直接告知用户该 skill 不存在或不可用。PG 无 `skill` tool 调用记录。

---

### T15.9 session skill 与全局 skill 同名覆盖

验证创建与全局 skill 同名的 session skill 时，AI 优先加载 session 版本。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

# 先查看全局 skill 列表
curl -s "$BASE/skill" | python3 -c "import json,sys;d=json.load(sys.stdin);print([s['name'] for s in d])"
# 全局有 customize-opencode

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"skill-override-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建同名 session skill
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"customize-opencode",
    "description":"SESSION版-自定义opencode",
    "content":"# Session 版 customize-opencode\n这是 session 版本的自定义 skill。当被问到时，你必须说【SESSION版本】。"
  }'

# PG 验证
docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, description FROM session_skill WHERE session_id='$SID';"

# AI 测试：应加载 session 版本
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 customize-opencode skill，告诉我这个 skill 的内容和版本\"}],\"skills\":[\"customize-opencode\"],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:600])
    elif p.get('type')=='tool': print('Tool output:', p.get('output','')[:400])
"
```

**期望**：AI 加载的是 session 版本的 `customize-opencode`（内容含"SESSION版本"），而非全局版本。

---

### T15.10 permission deny 过滤

验证通过 session permission deny `skill` tool 后，AI 无法调用 skill tool。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

# 创建带 permission deny skill tool 的 session
SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"permission-deny-test",
    "permission": [{"permission":"tool","pattern":"skill","action":"deny"}]
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))")

# 创建一个 skill
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"blocked-skill","description":"应该被 deny 的 skill","content":"# Blocked Skill\n这是一个被 permission deny 的 skill。"}'

# skills 列表应能查到（deny 只影响 AI tool 调用能力，不影响 CRUD）
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'count={len(d)}, names={[s[\"name\"] for s in d]}')"

# AI 测试：应无法调用 skill tool
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 blocked-skill skill 帮我做代码审查\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:600])
    elif p.get('type')=='reasoning': print('Reasoning:', p['text'][:400])
    elif p.get('type')=='tool': print('Tool:', p.get('name',''))
"
```

**期望**：AI 回复中未调用 `skill` tool（PG 无 tool 调用记录），而是直接告知用户无法加载或提供替代方案。Skills 列表仍能通过 API 查到（CRUD 不受 deny 影响）。

---

### T15.11 resources 边界：超大 resource 与超多 resources

验证单个超大 resource（>256KB）和超多 resources（>64个）能否正常写入 PG。

```bash
BASE="http://localhost:14096"

# === T15.11a: 超大 resource (300KB) ===
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"boundary-large-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

LARGE_CONTENT=$(python3 -c "print('x' * 300000)")
curl -s -X POST "$BASE/session/$SID_A/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"huge-skill\",\"description\":\"超大 resource 测试\",\"content\":\"# Huge Skill\",\"resources\":[{\"path\":\"big.md\",\"type\":\"doc\",\"content\":\"$LARGE_CONTENT\"}]}"

docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, jsonb_array_length(resources) as res_count, length(resources->0->>'content') as first_res_size, pg_column_size(resources) as total_jsonb_size FROM session_skill WHERE session_id='$SID_A';"

# === T15.11b: 超多 resources (70个) ===
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"boundary-many-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

RESOURCES=$(python3 -c "
import json
resources = [{'path':f'file_{i}.md','type':'doc','content':f'content of file {i}'} for i in range(70)]
print(json.dumps(resources))
")

curl -s -X POST "$BASE/session/$SID_B/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"many-resources\",\"description\":\"超多 resources 测试\",\"content\":\"# Many Resources\",\"resources\":$RESOURCES}"

docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, jsonb_array_length(resources) as res_count, pg_column_size(resources) as total_jsonb_size FROM session_skill WHERE session_id='$SID_B';"
```

**期望**：
- T15.11a：PG `first_res_size=300000`，无截断无报错
- T15.11b：PG `res_count=70`，无截断无报错

---

### T15.12 全局 skill 列表 (GET /skill)

验证全局 skill 列表端点返回正确的内置 skills。

```bash
BASE="http://localhost:14096"

# 列出全局 skills
curl -s "$BASE/skill" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'Total: {len(d)}')
for s in d:
    print(f'  - {s[\"name\"]}: {s.get(\"description\",\"\")[:80]}')
    print(f'    location: {s.get(\"location\",\"N/A\")}')
    print(f'    resources: {len(s.get(\"resources\",[]))}')
"
```

**期望**：至少返回 1 个全局 skill（如 `customize-opencode`），包含 name、description、location 等字段。注意：`GET /skill/{name}` 无独立端点（返回 HTML 页面）。

---

### T15.13 多 skills 主动触发（指定多个 skills 参数）

验证在 `message` 请求中通过 `skills` 参数指定多个 skill 时，AI 能依次加载全部 skill 并综合使用。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"multi-skills-active-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建 3 个不同角色的 skills
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"security-reviewer",
    "description":"代码安全审查专家。检查 SQL注入、XSS、命令注入等安全漏洞。",
    "content":"# Security Reviewer\n你是代码安全审查专家。按以下清单审查代码：\n1. SQL注入：字符串拼接SQL是HIGH风险\n2. XSS：未转义输出是HIGH风险\n3. 命令注入：shell拼接是HIGH风险\n4. 路径遍历：未校验路径是MEDIUM风险\n审查后给出：风险等级(HIGH/MEDIUM/LOW) + 修复建议。"
  }' > /dev/null

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"perf-optimizer",
    "description":"代码性能优化专家。分析时间复杂度、内存使用、N+1查询等性能问题。",
    "content":"# Performance Optimizer\n你是代码性能优化专家。按以下维度分析：\n1. 时间复杂度：是否有O(n²)或更高\n2. 内存：是否有大数组拷贝或不必要的对象创建\n3. N+1查询：循环内是否有数据库查询\n4. 缓存：是否缺少必要的缓存\n分析后给出：性能评分(1-10) + 优化建议。"
  }' > /dev/null

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"style-checker",
    "description":"代码风格和质量审查专家。检查命名规范、函数长度、注释质量等。",
    "content":"# Style Checker\n你是代码风格审查专家。按以下维度检查：\n1. 命名：变量/函数名是否语义清晰\n2. 函数长度：是否超过30行\n3. 重复代码：是否有DRY违反\n4. 错误处理：是否有空catch或未处理异常\n审查后给出：风格评分(A/B/C/D) + 改进建议。"
  }' > /dev/null

# 验证 skills 列表
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'count={len(d)}, names={[s[\"name\"] for s in d]}')"

# PG 验证
docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, description FROM session_skill WHERE session_id='$SID' ORDER BY name;"

# 主动触发：指定使用全部 3 个 skills 审查同一段代码
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请分别用 security-reviewer、perf-optimizer、style-checker 三个 skill 审查以下代码，给出三个维度的完整报告：\\n\\n\`\`\`python\\ndef get_users(role=None):\\n    query = f\\\"SELECT * FROM users WHERE role='{role}'\\\"\\n    results = []\\n    db = connect_db()\\n    rows = db.execute(query)\\n    for row in rows:\\n        user = dict(row)\\n        orders = db.execute(f\\\"SELECT * FROM orders WHERE user_id={user['id']}\\\")\\n        user['orders'] = [dict(o) for o in orders]\\n        results.append(user)\\n    return results\\n\`\`\`\"}],
    \"skills\":[\"security-reviewer\",\"perf-optimizer\",\"style-checker\"],
    \"model\":$MODEL
  }" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:1500])
    elif p.get('type')=='tool': print(f'Tool: {json.dumps(p.get(\"input\",{}),ensure_ascii=False)[:200]}')
"

# PG 验证 tool 调用记录：应有 3 条 skill tool 调用
docker exec ai-nova-postgres psql -U postgres -d opencode -c "
SELECT p.data->>'name' as tool_name, substring(p.data->'state'->>'input', 1, 200) as input
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id='$SID' AND p.data->>'type'='tool'
ORDER BY m.time_created;
"
```

**期望**：AI 依次调用 3 次 `skill` tool，分别加载 `security-reviewer`、`perf-optimizer`、`style-checker`；回复包含三个维度的审查报告（安全风险、性能评分、风格评分）。PG `part` 表有 3 条 tool 调用记录。

---

### T15.14 多 skills 被动触发（不指定 skills，AI 自行判断加载）

验证不传 `skills` 参数时，AI 能根据消息内容自动从可用 skills 中选择并加载合适的 skill。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"multi-skills-passive-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建 2 个不同场景的 skills
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"deploy-helper",
    "description":"部署助手。当用户需要部署、发布、上线、Docker、K8s 相关帮助时使用。",
    "content":"# Deploy Helper\n你是部署专家。当被调用时，必须先说【DEPLOY_HELPER已激活】再回答。"
  }' > /dev/null

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"git-helper",
    "description":"Git 版本控制助手。当用户需要 Git 操作、分支管理、合并冲突、rebase 等帮助时使用。",
    "content":"# Git Helper\n你是 Git 专家。当被调用时，必须先说【GIT_HELPER已激活】再回答。"
  }' > /dev/null

# 验证 skills 列表
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'count={len(d)}, names={[s[\"name\"] for s in d]}')"

# 被动触发：问 git 合并冲突问题（不传 skills 参数）
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"我遇到了一个 git 合并冲突，帮我解决。冲突内容如下：\\n\\n\`\`\`\\n<<<<<<< HEAD\\nconst port = process.env.PORT || 3000;\\napp.listen(port);\\n=======\\nconst port = process.env.PORT || 8080;\\nserver.listen(port, () => console.log('running'));\\n>>>>>>> feature/new-port\\n\`\`\`\\n\\n请使用合适的 skill 来指导我解决\"}],
    \"model\":$MODEL
  }" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:800])
    elif p.get('type')=='tool': print(f'Tool: {json.dumps(p.get(\"input\",{}),ensure_ascii=False)[:200]}')
"

# PG 验证：应有 1 条 skill tool 调用，加载的是 git-helper（而非 deploy-helper）
docker exec ai-nova-postgres psql -U postgres -d opencode -c "
SELECT substring(p.data->'state'->>'input', 1, 100) as input,
  substring(p.data->'state'->>'output', 1, 100) as output_preview
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id='$SID' AND p.data->>'type'='tool'
  AND p.data->'state'->>'input' LIKE '%git-helper%'
ORDER BY m.time_created;
"
```

**期望**：AI 识别到 git 合并冲突场景，主动调用 `skill` tool 加载 `git-helper`（而非 `deploy-helper`）；回复包含 `【GIT_HELPER已激活】`。PG `part` 表有对应的 tool 调用记录，且加载的是 `git-helper`。

> **注意**：被动触发依赖 AI 自主判断。对于 AI 自身已具备足够知识的问题（如简单 Dockerfile），AI 可能不加载 skill 而直接回答，这是合理行为。测试时应选择需要特定 skill 指导的场景（如本例的合并冲突）。

---

### T15.15 渐进式披露：preloaded_skills manifest 验证

验证当消息带 `skills` 参数时，system prompt 中注入的 `<preloaded_skills>` 只包含 manifest（name/description/location + resource 元数据），不含 skill 完整 content。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"progressive-disclosure-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"api-designer",
    "description":"REST API 设计专家",
    "content":"# API Designer\n你是 REST API 设计专家。遵循 OpenAPI 3.0 规范。提供端点设计、请求/响应 schema、错误码设计等指导。",
    "resources":[
      {"path":"openapi-template.yaml","type":"template","content":"openapi: 3.0.0\ninfo:\n  title: API\n  version: 1.0.0\npaths: {}\n"},
      {"path":"error-codes.md","type":"doc","content":"## 标准错误码\n- 400: 请求参数错误\n- 401: 未认证\n- 403: 无权限\n- 404: 资源不存在\n- 500: 服务器内部错误"}
    ]
  }' > /dev/null

# 让 AI 检查自己的 system prompt 内容
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请检查你的 system prompt，回答以下问题：\\n1. preloaded_skills 部分是否存在？\\n2. api-designer skill 的 content 是否出现在 system prompt 中？还是只有 name 和 description？\\n3. resources 部分是显示了完整 content 还是只有 path/size 元数据？\\n4. available_skills 列表中 api-designer 的信息是什么？\\n\\n请如实回答，逐条列出。\"}],\"skills\":[\"api-designer\"],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print(p['text'])
"
```

**期望**：
1. `preloaded_skills` 存在
2. api-designer 的 **完整 content 不在** system prompt 中，只有 name/description/location
3. resources 只显示 path/type/size **元数据**，不含实际内容
4. `available_skills` 列表只有 name/description/location
5. System prompt 包含提示语："These preloaded skills are manifests only. Before applying a preloaded skill, call the skill tool with its name to load the full instructions."

---

### T15.16 渐进式披露：skill tool 不指定 resources 时只返回 manifest

验证 AI 调用 `skill` tool 不指定 `resources` 参数时，返回的 resources 部分只有 path/type/size 元数据，不含实际 content。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"resource-manifest-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"code-reviewer",
    "description":"代码审查专家",
    "content":"# Code Reviewer\n你是代码审查专家。按 security/performance/style 三维度审查。",
    "resources":[
      {"path":"checklist.md","type":"doc","content":"## 审查清单\n1. SQL注入检查\n2. 内存泄漏检查\n3. 命名规范检查"},
      {"path":"template.json","type":"template","content":"{\"severity\":\"HIGH\",\"category\":\"security\"}"}
    ]
  }' > /dev/null

curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请调用 skill tool 加载 code-reviewer，但不要指定 resources 参数。然后告诉我：\\n1. resources 部分显示的是什么？是完整内容还是只有 path/size 元数据？\\n2. 逐字列出 resources 部分的内容。\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:800])
    elif p.get('type')=='tool': print(f'TOOL input: {json.dumps(p.get(\"input\",{}),ensure_ascii=False)}')
"

# PG 验证 tool output
docker exec ai-nova-postgres psql -U postgres -d opencode -c "
SELECT substring(p.data->'state'->>'output', 1, 800) as output
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id='$SID' AND p.data->>'type'='tool'
ORDER BY m.time_created;
"
```

**期望**：PG tool output 中 resources 显示 `<resource path="checklist.md" type="doc" size="78" />`（只有元数据），**不含** "SQL注入检查" 等实际内容。

---

### T15.17 渐进式披露：指定 resources 获取内容 + 不存在 resource → missing_resource

验证 AI 调用 `skill` tool 指定 `resources` 参数时：
1. 存在的 resource 返回完整 content
2. 不存在的 resource 标记为 `<missing_resource>`，不报错

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"resource-content-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"code-reviewer",
    "description":"代码审查专家",
    "content":"# Code Reviewer\n你是代码审查专家。按 security/performance/style 三维度审查。",
    "resources":[
      {"path":"checklist.md","type":"doc","content":"## 审查清单\n1. SQL注入检查\n2. 内存泄漏检查\n3. 命名规范检查"},
      {"path":"template.json","type":"template","content":"{\"severity\":\"HIGH\",\"category\":\"security\"}"}
    ]
  }' > /dev/null

curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"调用 skill tool 加载 code-reviewer，指定 resources 为 [\\\"checklist.md\\\", \\\"nonexistent-file.md\\\"]。然后告诉我：\\n1. checklist.md 的完整内容是什么？\\n2. nonexistent-file.md 出现了什么？\\n3. 逐字列出 resources 部分的全部内容。\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:1000])
    elif p.get('type')=='tool': print(f'TOOL input: {json.dumps(p.get(\"input\",{}),ensure_ascii=False)}')
"

# PG 验证 tool output
docker exec ai-nova-postgres psql -U postgres -d opencode -c "
SELECT substring(p.data->'state'->>'output', 1, 1200) as output
FROM message m JOIN part p ON p.message_id = m.id
WHERE m.session_id='$SID' AND p.data->>'type'='tool'
ORDER BY m.time_created;
"
```

**期望**：
1. `checklist.md` 返回完整内容：`<resource path="checklist.md" type="doc">## 审查清单\n1. SQL注入检查...</resource>`
2. `nonexistent-file.md` 返回：`<missing_resource path="nonexistent-file.md" />`
3. PG tool output 包含两者

---

### T15.18 跨 session 隔离

验证 session A 创建的 skill 在 session B 不可见。

```bash
BASE="http://localhost:14096"

SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"isolation-A"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"isolation-B"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# A 创建 skill
curl -s -X POST "$BASE/session/$SID_A/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"private-skill","description":"A 的私有 skill","content":"# Private\n仅 A 可见"}' > /dev/null

# A 能看到
curl -s "$BASE/session/$SID_A/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'A skills: {[s[\"name\"] for s in d]}')"

# B 看不到
curl -s "$BASE/session/$SID_B/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'B skills: {[s[\"name\"] for s in d]}')"

# PG 验证
docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c \
  "SELECT session_id, name FROM session_skill WHERE name='private-skill';"
```
**期望**：A 返回 `['private-skill']`；B 返回 `[]`；PG 只有 A 的 session_id 关联该 skill

---

### T15.19 session 删除后 skill 级联清理

验证 DELETE session 后，PG 中 session_skill 记录被级联删除。

```bash
BASE="http://localhost:14096"

SID_DEL=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"cascade-delete-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建 2 个 skills
curl -s -X POST "$BASE/session/$SID_DEL/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"skill-a","description":"a","content":"# A"}' > /dev/null
curl -s -X POST "$BASE/session/$SID_DEL/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"skill-b","description":"b","content":"# B","resources":[{"path":"r.md","type":"doc","content":"resource"}]}' > /dev/null

# PG 验证：删除前
docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c \
  "SELECT COUNT(*) FROM session_skill WHERE session_id='$SID_DEL';"

# 删除 session
curl -s -X DELETE "$BASE/session/$SID_DEL" -o /dev/null -w "delete: %{http_code}\n"

# PG 验证：删除后
docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c \
  "SELECT COUNT(*) FROM session_skill WHERE session_id='$SID_DEL';"
```
**期望**：删除前 `COUNT=2`；删除后 `COUNT=0`

---

### T15.20 skills[] 传不存在的名称

验证 message 请求中 `skills` 数组包含不存在的 skill 名称时的行为。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"bad-skills-array-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建一个真实 skill
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"real-skill","description":"真实 skill","content":"# Real\n回复时必须说【REAL_SKILL】"}' > /dev/null

# skills[] 混入不存在的名称
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 real-skill 和 ghost-skill 帮我审查代码\"}],\"skills\":[\"real-skill\",\"ghost-skill\"],\"model\":$MODEL}" \
  -w "\nHTTP: %{http_code}" \
  | python3 -c "
import json,sys
lines=sys.stdin.read().strip().split('\n')
http=lines[-1] if lines[-1].startswith('HTTP:') else ''
body='\n'.join(lines[:-1]) if http else '\n'.join(lines)
try:
  d=json.loads(body)
  for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:400])
except: print('raw:', body[:400])
print(http)
"
```
**期望**：请求不报错（HTTP 200）；AI 能加载 `real-skill`（回复含 `REAL_SKILL`）；`ghost-skill` 被忽略或 AI 说明不可用

---

### T15.21 skill name 边界

验证空名称、超长名称、特殊字符名称的创建行为。

```bash
BASE="http://localhost:14096"

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"name-boundary-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 空名称
echo "--- 空名称 ---"
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"","description":"empty name","content":"# Empty"}' \
  -w "\nHTTP: %{http_code}" | tail -1

# 超长名称（300 字符）
LONG_NAME=$(python3 -c "print('a'*300)")
echo "--- 超长名称 (300) ---"
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"$LONG_NAME\",\"description\":\"long name\",\"content\":\"# Long\"}" \
  -w "\nHTTP: %{http_code}" | tail -1

# 特殊字符
for name in "../escape" "skill/slash" "skill with space" "skill<script>" "中文技能"; do
  echo "--- name='$name' ---"
  RESP=$(curl -s -X POST "$BASE/session/$SID/skills/create" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"description\":\"special\",\"content\":\"# Special\"}" \
    -w "\nHTTP: %{http_code}")
  HTTP=$(echo "$RESP" | tail -1)
  echo "  $HTTP"
done

# 列出创建成功的 skills
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print('created:', [s['name'] for s in d])"
```
**期望**：空名称应返回 400 或被拒绝；超长名称视实现返回 400 或截断；特殊字符（`../`、`/`、`<>`）应被拒绝或转义；中文名可接受

---

### T15.22 并发创建同名 skill 竞态

验证两个并发 POST 创建同名 skill 时，PG 最终只有一条记录（upsert 安全）。

```bash
BASE="http://localhost:14096"

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"concurrent-upsert-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 并发 5 个 POST 同名 skill，不同 content
for i in 1 2 3 4 5; do
  curl -s -X POST "$BASE/session/$SID/skills/create" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"race-skill\",\"description\":\"v$i\",\"content\":\"# V$i\"}" &
done
wait

sleep 1

# PG 验证：应只有 1 条
docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c \
  "SELECT COUNT(*) FROM session_skill WHERE session_id='$SID' AND name='race-skill';"

# API 验证
curl -s "$BASE/session/$SID/skills" | python3 -c "
import json,sys;d=json.load(sys.stdin)
print(f'count={len(d)}')
for s in d: print(f'  {s[\"name\"]}: {s[\"description\"]}')
"
```
**期望**：PG `COUNT=1`；API 返回 1 个 `race-skill`；description 是 5 个版本之一（最后写入的赢）

---

### T15.23 resource content 编码

验证 resource content 中 Unicode、特殊字符、JSON 特殊字符的保真性。

```bash
BASE="http://localhost:14096"

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"encoding-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 包含各种特殊字符的 resources
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"encoding-skill",
    "description":"编码测试",
    "content":"# Encoding Test",
    "resources":[
      {"path":"unicode.md","type":"doc","content":"中文内容 🎉 日本語 한국어 émojis: 🚀💻🔥"},
      {"path":"special.md","type":"doc","content":"引号\"双引号\" 反斜杠\\\\ 换行\\n制表符\\t 尖括号<tag>内容</tag>"},
      {"path":"code.py","type":"script","content":"# -*- coding: utf-8 -*-\ndef greet(name):\n    return f\"你好 {name}! 🎉\"\n\nprint(greet(\"世界\"))"}
    ]
  }'

# API 读回验证
curl -s "$BASE/session/$SID/skills" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for s in d:
  for r in s.get('resources',[]):
    c=r['content']
    print(f'{r[\"path\"]}: len={len(c)}, has_emoji={\"🎉\" in c}, has_chinese={\"中文\" in c}')
    print(f'  first 80: {c[:80]}')
"

# PG 验证
docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c \
  "SELECT
    r->>'path' as path,
    length(r->>'content') as len,
    (r->>'content') LIKE '%🎉%' as has_emoji,
    (r->>'content') LIKE '%中文%' as has_chinese
  FROM session_skill, jsonb_array_elements(resources) r
  WHERE session_id='$SID';"
```
**期望**：API 和 PG 中 Unicode（中文、emoji）完整保留；特殊字符（引号、反斜杠、尖括号）不被截断或转义破坏

---


## 结果汇总

| 用例 | 状态 | 说明 |
|------|------|------|
| T15.1 | 🧪 | 简单 skill 创建+触发 |
| T15.2 | 🧪 | 复杂 bundle（含 resources）创建+读取+触发 |
| T15.3 | 🧪 | 删除单个+清空全部 |
| T15.4 | 🧪 | 从目录加载 skill bundle |
| T15.5 | 🧪 | SkillsMP 拉取 10 个真实 skill 并执行 |
| T15.6 | 🧪 | 重复创建同名 skill（upsert 覆盖） |
| T15.7 | 🧪 | AI 通过 skill tool 按需加载 resource |
| T15.8 | 🧪 | skill 不存在时的错误处理 |
| T15.9 | 🧪 | session skill 与全局 skill 同名覆盖 |
| T15.10 | 🧪 | permission deny 过滤 skill tool |
| T15.11 | 🧪 | 超大 resource + 超多 resources |
| T15.12 | 🧪 | 全局 skill 列表 |
| T15.13 | 🧪 | 多 skills 主动触发 |
| T15.14 | 🧪 | 多 skills 被动触发 |
| T15.15 | 🧪 | preloaded_skills manifest 验证 |
| T15.16 | 🧪 | skill tool 不指定 resources → manifest |
| T15.17 | 🧪 | 指定 resources + missing_resource |
| T15.18 | ✅ | A=['private-skill'], B=[], PG 只有 A |
| T15.19 | ✅ | 删除前 COUNT=2, 删除后 COUNT=0 |
| T15.20 | ✅ | HTTP 200, 不存在的 skill 名称不导致请求失败 |
| T15.21 | ⚠️ | 空名称/`../`/`/` 均被接受（缺少输入校验） |
| T15.22 | ✅ | 5 并发 PG COUNT=1, upsert 安全 |
| T15.23 | ✅ | Unicode/emoji/中文 API+PG 完整保留 |
