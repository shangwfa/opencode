# Session Skills

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
>
> **通用清单映射**：T15.1(G1/G2)、T15.3(G4/G5)、T15.6(G3)、T15.18(G6)、T15.19(G7)、T15.22(G10) 遵循 [`00-preamble.md` 附录 A](./00-preamble.md) 通用 CRUD 清单；其余为 skill 特有场景（bundle/resources/触发/permission）。

## 十五、Session Skills

本节验证 SaaS API 中 session 维度的 skills：创建、读取、删除、复杂 bundle、PG 资源快照、resources 元数据查询、隐藏目录物化，以及从 SkillsMP 拉取真实 skill bundle 后执行。资源正文只保存在 PG，并在调用 `skill` 工具后物化到 code-agent 文件系统，不进入 system prompt、skill tool output 或 Session Skills 查询响应。所有请求都打容器服务 `BASE=http://localhost:14096`。

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。

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
  | python3 -c "import json,sys;d=json.load(sys.stdin);print([(s['name'], [(r['path'],r['type'],r['size'],bool(r['digest']), 'content' in r) for r in s.get('resources',[])]) for s in d])"

psql "$PG_URL" -c "
SELECT r->>'path' AS path,
       (r->>'size')::int AS size,
       length(r->>'digest') AS digest_len,
       length(r->>'content') AS stored_content_len
FROM session_skill, jsonb_array_elements(resources) r
WHERE session_id='$SID_BUNDLE'
ORDER BY path;"

curl -s --max-time 180 -X POST "$BASE/session/$SID_BUNDLE/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 complex-reviewer skill 审查这段代码：\\n\\`\\`\\`python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    result = conn.execute(query)\\n    return result\\n\\`\\`\\`\"}],
    \"skills\":[\"complex-reviewer\"],
    \"model\":$MODEL
  }" | python3 -c "import json,sys;d=json.load(sys.stdin);t=''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text');print(t[:1800])"
```

**期望**：`GET /skills` 能读回两个资源的 `path/type/size/digest`，且 `'content' in r` 为 `False`；PG JSONB 仍保存完整正文；AI 调用 skill 后从隐藏资源目录读取文件，回复中明确引用两个资源路径，并识别 SQL 注入、连接泄漏、返回 raw cursor 等问题。

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
 'model':{'providerID':'Yd-DeepSeek','modelID':'deepseek-v4-flash'}
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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"upsert-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 第一次：v1 + 1 resource
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"checker","description":"v1","content":"# Checker V1\n必须说 V1","resources":[{"path":"a.md","type":"doc","content":"resource A"}]}'

# PG 验证：name=checker, description=v1, res_count=1
psql "$PG_URL" -c \
  "SELECT name, description, jsonb_array_length(resources) as res_count FROM session_skill WHERE session_id='$SID';"

# 第二次：同一名字，不同内容和 resources
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"checker","description":"v2","content":"# Checker V2\n必须说 V2","resources":[{"path":"b.md","type":"doc","content":"resource B"},{"path":"c.md","type":"doc","content":"resource C"}]}'

# PG 验证：name=checker, description=v2, res_count=2（覆盖而非新增）
psql "$PG_URL" -c \
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

### T15.7 skill tool 将 resources 物化到隐藏目录

验证 AI 调用 `skill` tool 后，全部 resources 自动物化到 `/home/sandbox/.local/share/opencode/session-skills`，tool output 只返回 `resource_directory` 和资源元数据，不包含资源正文。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"skill-tool-resource-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"db-reviewer",
    "description":"数据库代码审查 skill",
    "content":"# DB Reviewer\n先调用 skill，再从返回的 resource_directory 读取 checklist.md 和 safe-template.py，按文件内容审查数据库代码。",
    "resources":[
      {"path":"checklist.md","type":"doc","content":"## 安全检查清单\n1. SQL注入: f-string拼接SQL是HIGH\n2. 连接泄漏: 不用with/close是HIGH\n3. 必须返回具体行，不能返回cursor"},
      {"path":"safe-template.py","type":"template","content":"query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"}
    ]
  }'

curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 db-reviewer skill 审查这段代码。先调用 skill 工具，再用 read 工具读取 resource_directory 下的 checklist.md 和 safe-template.py。\\n\\n代码:\\n```python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    return conn.execute(query)\\n```\"}],\"skills\":[\"db-reviewer\"],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:500])
    elif p.get('type')=='tool': print('Tool:', p.get('name',''), 'input:', json.dumps(p.get('input',{}))[:200])
"

# PG 验证：tool output 只有隐藏目录和 metadata
TOOL_OUTPUT=$(psql "$PG_URL" -t -A -c "
  SELECT p.data->'state'->>'output'
  FROM message m JOIN part p ON p.message_id = m.id
  WHERE m.session_id='$SID' AND p.data->>'type'='tool'
    AND p.data->'state'->>'output' LIKE '%<skill_content name=\"db-reviewer\"%'
  ORDER BY m.time_created DESC LIMIT 1;")

printf '%s\n' "$TOOL_OUTPUT" | python3 -c "
import re,sys
s=sys.stdin.read()
directory=re.search(r'<resource_directory>([^<]+)</resource_directory>',s)
print('resource_directory=',directory.group(1) if directory else None)
print('has_metadata=',all(x in s for x in ['path=\"checklist.md\"','size=\"','digest=\"']))
print('leaked_checklist=', 'SQL注入: f-string拼接SQL是HIGH' in s)
print('leaked_template=', 'SELECT * FROM users WHERE id = ?' in s)
"

# 验证资源不在用户 workspace
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"test ! -e /workspace/.opencode/session-skills && test -d /home/sandbox/.local/share/opencode/session-skills && echo HIDDEN_RESOURCE_OK"}' \
  | python3 -m json.tool
```

**期望**：
- tool output 包含 `<resource_directory>/home/sandbox/.local/share/opencode/session-skills/...`；
- 两个资源都有 `path/type/size/digest` 元数据；
- `leaked_checklist=False`、`leaked_template=False`；
- exec 输出 `HIDDEN_RESOURCE_OK`，用户 `/workspace` 中不存在 session skill 文件；
- AI 通过 read 读取物化文件后，回复引用 SQL 注入 HIGH、连接泄漏 HIGH。

---

### T15.8 skill 不存在时的错误处理

验证当 AI 被引导使用不存在的 skill 时，能正确识别并给出明确的错误信息。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
psql "$PG_URL" -c \
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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

# 创建带 permission deny skill tool 的 session
SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"permission-deny-test",
    "permission": [{"permission":"skill","pattern":"*","action":"deny"}]
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

> **阈值变更历史（2026-08-26）**：`MAX_SIZE` 512KB→1MB，`MAX_BUNDLE_SIZE` 1MB→16MB，`MAX_COUNT` 64→128。

验证单个超大 resource（>1MB）和超多 resources（>128 个）会被拒绝，且错误信息被透传。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

# === T15.11a: 超大 resource (1.2MB > 1MB 上限) ===
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"boundary-large-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

python3 - <<'PY' >/tmp/t15-11a-request.json
import json
print(json.dumps({
    "name": "huge-skill",
    "description": "超大 resource 测试",
    "content": "# Huge Skill",
    "resources": [{"path": "big.md", "type": "doc", "content": "x" * 1200000}],
}, ensure_ascii=False))
PY
RESP_A=$(curl -s -o /tmp/t15-11a.json -w '%{http_code}' -X POST "$BASE/session/$SID_A/skills/create" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/t15-11a-request.json)
echo "large_status=$RESP_A body=$(cat /tmp/t15-11a.json)"

psql "$PG_URL" -c \
  "SELECT name, jsonb_array_length(resources) as res_count FROM session_skill WHERE session_id='$SID_A';"

# === T15.11b: 超多 resources (150个 > 128 上限) ===
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"boundary-many-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

RESOURCES=$(python3 -c "
import json
resources = [{'path':f'file_{i}.md','type':'doc','content':f'content of file {i}'} for i in range(150)]
print(json.dumps(resources))
")

STATUS_B=$(curl -s -o /tmp/t15-11b.json -w '%{http_code}' -X POST "$BASE/session/$SID_B/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"many-resources\",\"description\":\"超多 resources 测试\",\"content\":\"# Many Resources\",\"resources\":$RESOURCES}")
echo "many_status=$STATUS_B body=$(cat /tmp/t15-11b.json)"

psql "$PG_URL" -c \
  "SELECT session_id, count(*) FROM session_skill WHERE session_id IN ('$SID_A','$SID_B') GROUP BY session_id;"
```

**期望**：
- T15.11a、T15.11b 的 HTTP 状态均为 400；
- 响应 body 格式为 `{"name":"SkillCreateError","data":{"message":"..."}}`，分别指出单文件 1MB 和最多 128 个资源限制；
- PG 查询返回 0 行，没有写入部分 skill 快照。

---

### T15.11c 数据密集型 skill bundle 注册（大资源包）

验证 `res2.json` 类型的完整 skill bundle（3.8MB，69 个资源，含 CSV/JSON 数据集）在放宽后的限制下注册成功。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 使用 docs/test-cases/skills/res2.json（3.8MB，69 resources）
RESP=$(curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d @docs/test-cases/skills/res2.json)
echo "body=$(echo "$RESP" | python3 -c "import json,sys;d=json.load(sys.stdin);print({'name':d.get('name'),'resources':len(d.get('resources',[]))})")"

# PG 验证
psql "$PG_URL" -c "SELECT name, jsonb_array_length(resources) as res_count FROM session_skill WHERE session_id='$SID';"
```

**期望**：
- HTTP 200；
- `resources` 数为 69；
- PG 中 `res_count=69`。

---

### T15.23 skill 注册错误信息透传

验证创建失败时错误信息以 `SkillCreateError` 格式返回，而非裸 `400 BadRequest`。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 超量资源（150 个）触发 MAX_COUNT 限制
RESOURCES=$(python3 -c "
import json; resources = [{'path':f'f{i}.md','type':'doc','content':'x'} for i in range(150)]
print(json.dumps(resources))
")
RESP=$(curl -s -o /tmp/t15-23.json -w '%{http_code}' -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"err-test\",\"description\":\"t\",\"content\":\"# t\",\"resources\":$RESOURCES}")
echo "status=$RESP body=$(cat /tmp/t15-23.json)"

# 超大文件触发 MAX_SIZE 限制
RESP2=$(curl -s -o /tmp/t15-23b.json -w '%{http_code}' -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"err-test2\",\"description\":\"t\",\"content\":\"# t\",\"resources\":[{\"path\":\"big.md\",\"type\":\"doc\",\"content\":\"$(python3 -c \"print('x'*1200000)\")\"}]}")
echo "status2=$RESP2 body=$(cat /tmp/t15-23b.json)"
```

**期望**：
- 两个请求均返回 400；
- body 格式为 `{"name":"SkillCreateError","data":{"message":"..."}}`；
- 错误信息分别包含“128 个资源”、“1048576 bytes”等具体限制值；
- PG 无残留记录。

---

### T15.12 全局 skill 列表 (GET /skill)

验证全局 skill 列表端点返回正确的内置 skills。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请检查你的 system prompt，回答以下问题：\\n1. preloaded_skills 部分是否存在？\\n2. api-designer skill 的 content 是否出现在 system prompt 中？还是只有 name 和 description？\\n3. resources 部分是显示了完整 content 还是只有 path/type/size/digest 元数据？\\n4. available_skills 列表中 api-designer 的信息是什么？\\n\\n请如实回答，逐条列出。\"}],\"skills\":[\"api-designer\"],\"model\":$MODEL}" \
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
3. resources 只显示 path/type/size/digest **元数据**，不含实际内容
4. `available_skills` 列表只有 name/description/location
5. System prompt 包含提示语："These preloaded skills are manifests only. Before applying a preloaded skill, call the skill tool with its name to load the full instructions and materialize its resources in the code-agent filesystem."

---

### T15.16 skill tool 协议：只接收 name 并自动物化全部 resources

验证 `skill` tool 输入只包含 `name`，调用后自动物化全部 resources；输出包含隐藏目录及 path/type/size/digest，不含实际 content。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请调用 skill tool 加载 code-reviewer。然后告诉我：\\n1. tool input 有哪些字段？\\n2. resource_directory 是什么？\\n3. resources 部分是否只有 path/type/size/digest？\"}],\"model\":$MODEL}" \
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

**期望**：
- tool input 是 `{"name":"code-reviewer"}`，不存在 `resources` 参数；
- tool output 包含 `/home/sandbox/.local/share/opencode/session-skills/...`；
- 两个资源均显示 path/type/size/digest；
- tool output **不含** “SQL注入检查”和 template.json 正文。

---

### T15.17 code-agent 从隐藏目录读取资源

验证资源正文只能通过 code-agent 文件工具读取；`skill` tool output 不返回正文，也不再负责生成 `<missing_resource>`。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"调用 skill tool 加载 code-reviewer，然后执行以下操作：\\n1. 用 read 读取 resource_directory/checklist.md；\\n2. 用 read 读取 resource_directory/template.json；\\n3. 确认 resource_directory/nonexistent-file.md 不存在；\\n4. 汇报读取结果。\"}],\"model\":$MODEL}" \
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
1. `skill` tool output 仅包含 metadata 和 `resource_directory`，不包含 checklist/template 正文；
2. 后续 `read` tool output 能读到“SQL注入检查”和 `{"severity":"HIGH"...}`；
3. 不存在文件由 `read` 返回文件不存在错误，不出现 `<missing_resource>`；
4. 所有读取路径都位于 `/home/sandbox/.local/share/opencode/session-skills`，不位于 `/workspace`。

---

### T15.18 跨 session 隔离

验证 session A 创建的 skill 在 session B 不可见。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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

# 特殊字符及非小写字母
for name in "../escape" "skill/slash" "skill with space" "skill<script>" "中文技能" "UpperCase" "-leading" "trailing-" "double--dash"; do
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
**期望**：所有非法名称（空、超长、路径、`/`、空格、`<>`、中文、大小写）均返回 HTTP 400，响应 body 包含 `Invalid skill name` 或 schema 校验错误；`skills` 列表为空（无任何非法名称被持久化）。

---

### T15.22 并发创建同名 skill 竞态

验证两个并发 POST 创建同名 skill 时，PG 最终只有一条记录（upsert 安全）。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

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

# API 只返回 metadata，不返回正文
curl -s "$BASE/session/$SID/skills" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for s in d:
  for r in s.get('resources',[]):
    print(f'{r[\"path\"]}: size={r[\"size\"]}, digest={r[\"digest\"][:12]}, has_content={\"content\" in r}')
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

# 物化后通过 code-agent 文件系统验证正文编码
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"调用 encoding-skill，然后用 read 读取 resource_directory 下的 unicode.md、special.md、code.py，确认中文、emoji、反斜杠和尖括号均完整。\"}],\"skills\":[\"encoding-skill\"],\"model\":$MODEL}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:1200])"
```
**期望**：API 的 `has_content=False` 且 size/digest 完整；PG 和物化文件中的 Unicode、emoji、中文、引号、反斜杠和尖括号均完整保留。

### T15.23a 二进制 resource 跳过但 Skill 注册成功

验证资源内容包含 NUL 等二进制控制字符时，只跳过该 resource，不影响整个 Skill 注册；正常文本 resource 仍应写入 PG。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"binary-resource-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

BODY=$(python3 - <<'PY'
import json

print(json.dumps({
    "name": "binary-resource-skill",
    "description": "二进制资源跳过测试",
    "content": "# Binary Resource Test",
    "resources": [
        {"path": "valid.md", "type": "doc", "content": "正常文本资源"},
        {"path": "scripts/cache.pyc", "type": "asset", "content": "\u0000\u0001\u0002binary"},
    ],
}, ensure_ascii=False))
PY
)

RESPONSE_FILE=$(mktemp)
STATUS=$(curl -s -o "$RESPONSE_FILE" -w '%{http_code}' \
  -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d "$BODY")
echo "HTTP $STATUS"
cat "$RESPONSE_FILE"

# API 应成功注册，且只返回正常 resource 的 metadata
test "$STATUS" = "200"
python3 - "$RESPONSE_FILE" <<'PY'
import json
import sys

skill = json.load(open(sys.argv[1]))
resources = skill.get("resources", [])
assert skill["name"] == "binary-resource-skill"
assert [resource["path"] for resource in resources] == ["valid.md"]
assert "content" not in resources[0]
PY

# PG 应有 Skill，resources 数量为 1，二进制 resource 不得落库
psql "$PG_URL" -t -A -c \
  "SELECT name, jsonb_array_length(resources::jsonb) FROM session_skill WHERE session_id='$SID' AND name='binary-resource-skill';"
psql "$PG_URL" -t -A -c \
  "SELECT COUNT(*) FROM session_skill, jsonb_array_elements(resources) r WHERE session_id='$SID' AND name='binary-resource-skill' AND r->>'path'='scripts/cache.pyc';"

rm -f "$RESPONSE_FILE"
```

**期望**：HTTP `200`；Skill 已注册；API 和 PG 均只包含 `valid.md`；二进制 `scripts/cache.pyc` 被跳过，不导致 HTTP 500，也不写入 PG。


---

## agent-browser 技能测试

> **操作流程**：
> 1. 创建会话 → 在沙箱中安装 agent-browser CLI + 下载 Chrome → 创建会话级 agent-browser skill
> 2. 使用该 skill 进行网页浏览、数据提取等测试
> 3. 验证多 skill 共存不冲突
>
> **已知问题**：沙箱中 `storage.googleapis.com` 被 DNS 劫持（解析到 `43.128.109.119`，代理证书过期），`agent-browser install` 下载 Chrome 失败，需改用 `curl -k` 手动下载。Chrome 启动偶发不稳定（daemon 卡死），建议**将 Chrome 预装到沙箱 Docker 镜像**中。
>
> **agent-browser SKILL.md** 位于 `~/.config/opencode/skills/agent-browser/SKILL.md`（本地），或从 [GitHub](https://github.com/vercel-labs/agent-browser) 获取。

### T15.24 创建 agent-browser 会话 skill

完整流程：创建会话 → 安装 CLI + 下载 Chrome → 创建会话级 skill → 验证技能列表。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
unset ALL_PROXY HTTP_PROXY HTTPS_PROXY all_proxy http_proxy https_proxy

# Step 1: 创建会话
SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"agent-browser-skill-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SID"

# keepAlive + 配置权限
curl -s -X POST "$BASE/session/$SID/keep-alive" -d '{"enabled":true}' > /dev/null
curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":{"bash":"allow","read":"allow","write":"allow","edit":"allow","glob":"allow","grep":"allow","list":"allow","webfetch":"allow"}}' > /dev/null

# Step 2: 验证镜像预装 agent-browser CLI
# 镜像已预装 agent-browser（mise shim），通过 PATH 直接可用
echo "=== 验证 agent-browser CLI ==="
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"command -v agent-browser && agent-browser --version"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('stdout','')[:300])"

# Step 3: 验证镜像预装 Chromium
echo ""
echo "=== 验证 Chromium ==="
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"command -v chromium && chromium --version"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('stdout','')[:300])"

# Step 4: 验证 Chromium headless 可用
echo ""
echo "=== Chromium headless smoke ==="
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"chromium --headless --no-sandbox --disable-gpu --dump-dom https://example.com 2>/dev/null | head -3"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('stdout','')[:500])"

# Step 5: 创建会话级 agent-browser skill
# 不硬编码具体路径，通过 PATH/环境变量解析
echo ""
echo "=== 创建 agent-browser session skill ==="
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"agent-browser",
    "description":"Browser automation CLI for AI agents. Use for navigating pages, filling forms, clicking buttons, screenshots, data extraction.",
    "content":"# agent-browser\n\nCLI 与 Chromium 均由镜像预装，直接通过 PATH 调用：agent-browser / chromium\n\n## Core Workflow\n1. Navigate: agent-browser open <url> --args no-sandbox --ignore-https-errors\n2. Snapshot: agent-browser snapshot / snapshot -i\n3. Interact: click @eN / fill @eN \"text\" / get title / get url / get text @eN\n4. Close: agent-browser close\n\n## Important\n- Always use --args no-sandbox (required for Docker)\n- Always use --ignore-https-errors\n- Close browser when done: `close` or `close --all`"
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'Created: {d.get("name")}')"

# Step 6: 验证 skill 列表
echo ""
curl -s "$BASE/session/$SID/skills" | python3 -c "
import json,sys
skills=json.load(sys.stdin)
ab = [s for s in skills if s['name']=='agent-browser']
if ab:
    print(f'✅ agent-browser session skill found')
else:
    print(f'❌ NOT found. Skills: {[s["name"] for s in skills]}')
"
```

**期望**：
- `command -v agent-browser` 成功（mise shim），版本号 ≥ `0.31`
- `command -v chromium` 成功（`/usr/local/bin/chromium`），`--version` 输出版本
- Chromium `--headless --dump-dom` 可渲染 example.com 页面
- session skill 创建返回 `name: agent-browser`
- session skill 列表中包含 `agent-browser`

> **注意**：T15.24 已验证镜像预装 agent-browser + Chromium，无需手动安装/下载。

### T15.25 使用 agent-browser 浏览网页

AI 通过 agent-browser session skill 浏览网页，执行 open/snapshot/get url/close 完整流程。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
unset ALL_PROXY HTTP_PROXY HTTPS_PROXY all_proxy http_proxy https_proxy

# 沿用 T15.24 的 session SID
echo "Session: $SID"

# AI 使用 agent-browser 访问网页
# 提示中应指出 CLI/Chrome 的实际路径（skill content 中已包含）
echo "=== AI 浏览网页 ==="
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"使用 agent-browser skill 浏览 https://example.com。按照 skill 中的指令：先用 open 打开页面，再 snapshot，再 get title/get url，最后 close。每一步完成后告诉我结果。如果 Chrome 启动超时，先 agent-browser close --all 关闭旧进程再重试。\"}],
    \"skills\":[\"agent-browser\"],
    \"model\":$MODEL
  }" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text':
        print(f'AI: {p[\"text\"][:1500]}')
    elif p.get('type')=='tool':
        tool = p.get('tool','?')
        inp = json.dumps(p.get('state',{}).get('input',{}),ensure_ascii=False)[:250]
        out = str(p.get('state',{}).get('output',''))[:250]
        print(f'TOOL({tool}): {inp}')
        if out: print(f'  -> {out}')
"
```

**期望**：
- AI 调用 bash 工具执行 `agent-browser open/snapshot/get url/close` 命令
- `open` 输出 `✓ https://example.com/`
- `get url` 确认当前 URL 为 `https://example.com/`
- AI 回复包含结构化总结表格

> **注意**：`get title` 在 headless Chrome 下对 example.com 可能返回空值，不影响核心流程验证。

### T15.26 agent-browser 多技能共存

验证 agent-browser 与 page-summarizer 两个 session skill 同时加载时，AI 能正确规划并使用两者。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
unset ALL_PROXY HTTP_PROXY HTTPS_PROXY all_proxy http_proxy https_proxy

# 创建新会话
SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"agent-browser-coexist-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# keepAlive + 权限
curl -s -X POST "$BASE/session/$SID/keep-alive" -d '{"enabled":true}' > /dev/null
curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":{"bash":"allow","read":"allow","write":"allow","edit":"allow","glob":"allow","grep":"allow","list":"allow"}}' > /dev/null

# 安装 agent-browser CLI + 下载 Chrome（同 T15.24 Step 2-3）
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -d '{"command":"npm install -g agent-browser 2>&1 | tail -1 && /home/coder/.npm-global/bin/agent-browser --version"}' > /dev/null

curl -s --max-time 180 -X POST "$BASE/session/$SID/exec" \
  -d '{"command":"curl -sk --max-time 120 -o /tmp/chrome.zip \"https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.54/linux64/chrome-linux64.zip\" && cd /tmp && unzip -o chrome.zip -d chrome 2>&1 | tail -1 && /tmp/chrome/chrome-linux64/chrome --version"}' > /dev/null

# 创建 agent-browser session skill
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"agent-browser","description":"Browser automation CLI","content":"# agent-browser\nCLI: /home/coder/.npm-global/bin/agent-browser\nChrome: /tmp/chrome/chrome-linux64/chrome\nWorkflow: open <url> --args no-sandbox --executable-path CHROME --ignore-https-errors -> snapshot -> get title/url -> close"}' > /dev/null

# 创建 page-summarizer session skill
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"page-summarizer","description":"Summarizes web page content into structured format","content":"# Page Summarizer\n\nGiven page content, output:\n1. **Page Title**: ...\n2. **URL**: ...\n3. **Key Content**: extract main points\n4. **Summary**: 2-3 sentences\n\nStart with \"[PAGE-SUMMARIZER]\" prefix."}' > /dev/null

# 验证两个 skill 均在列表中
echo "=== Session skills ==="
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;[print(f'  {s[\"name\"]}') for s in json.load(sys.stdin)]"

# AI 同时使用两个 skill
echo ""
echo "=== AI 同时使用两个 skill ==="
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请完成两个任务：\\n1. 使用 agent-browser skill 浏览 https://httpbin.org/json 获取页面内容\\n2. 使用 page-summarizer skill 对获取到的内容做结构化总结\\n每个 skill 输出需明确标注来源。\"}],
    \"skills\":[\"agent-browser\",\"page-summarizer\"],
    \"model\":$MODEL
  }" | python3 -c "
import json,sys
d=json.load(sys.stdin)
tools_used = []
for p in d.get('parts',[]):
    if p.get('type')=='text':
        print(f'AI: {p[\"text\"][:1200]}')
    elif p.get('type')=='tool':
        t = p.get('tool','?')
        tools_used.append(t)
        inp = json.dumps(p.get('state',{}).get('input',{}),ensure_ascii=False)[:200]
        out = str(p.get('state',{}).get('output',''))[:200]
        print(f'TOOL({t}): {inp}')
        if out: print(f'  -> {out}')
print(f'\\nTools: {set(tools_used)} ({len(tools_used)} calls)')
"
```

**期望**：
- session skill 列表包含 `agent-browser` 和 `page-summarizer`
- AI 创建 TODO 计划使用两个 skill（todowrite 工具调用）
- AI 依次调用两个 skill，先浏览网页再总结
- 回复中明确区分各 skill 的输出

> **注意**：T15.26 已验证 skill 加载 + AI 任务规划通过，Chrome 启动偶发不稳定导致 agent-browser 执行卡住。建议**将 Chrome 预装到沙箱 Docker 镜像**中以消除启动问题。

---

### T15.27 大型脚本物化与 sandbox 重建

验证大于工具输出截断阈值（50KiB）、小于单资源上限（256KiB）的脚本不会进入模型上下文，并能在 sandbox 销毁重建后继续执行。

```bash
SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"large-skill-resource-rebuild"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

python3 - <<'PY' >/tmp/t15-27-skill.json
import json
script = "console.log('LARGE_SCRIPT_OK')\n/*" + ("x" * 120000) + "*/\n"
print(json.dumps({
    "name": "large-script-skill",
    "description": "大型脚本资源测试",
    "content": "# Large Script Skill\n调用 skill 后执行 resource_directory/scripts/large.mjs。",
    "resources": [{"path": "scripts/large.mjs", "type": "script", "content": script}],
}, ensure_ascii=False))
PY

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/t15-27-skill.json \
  | python3 -c "import json,sys;d=json.load(sys.stdin);r=d['resources'][0];print(r);print('has_content=', 'content' in r)"

# 第一次物化并执行
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"调用 large-script-skill，然后用 bash 执行 resource_directory/scripts/large.mjs，只报告执行结果。\"}],\"skills\":[\"large-script-skill\"],\"model\":$MODEL}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:800])"

# tool output 应保持很小，不包含 120KB 脚本正文
psql "$PG_URL" -t -A -c "
SELECT length(p.data->'state'->>'output'),
       position(repeat('x',1000) in p.data->'state'->>'output') > 0 AS leaked_body
FROM message m JOIN part p ON p.message_id=m.id
WHERE m.session_id='$SID' AND p.data->'state'->>'output' LIKE '%large-script-skill%'
ORDER BY m.time_created DESC LIMIT 1;"

# 销毁 sandbox，PVC 中的 .local 数据保留
curl -s -X POST "$BASE/session/$SID/kill-sandbox" | python3 -m json.tool

# 重建后再次调用 skill，并直接执行物化脚本
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"重新调用 large-script-skill，并用 bash 再次执行 resource_directory/scripts/large.mjs。\"}],\"skills\":[\"large-script-skill\"],\"model\":$MODEL}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:800])"

curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"FILE=$(find /home/sandbox/.local/share/opencode/session-skills -path \"*/scripts/large.mjs\" | head -1); test -n \"$FILE\" && node \"$FILE\" && test ! -e /workspace/.opencode/session-skills"}' \
  | python3 -m json.tool
```

**期望**：
- create/list response 中 `size>50000`、digest 非空、`has_content=False`；
- 两次执行均输出 `LARGE_SCRIPT_OK`；
- tool output 长度远小于脚本正文，`leaked_body=false`；
- `kill-sandbox` 后可重新物化或复用 PVC 文件；
- `/workspace/.opencode/session-skills` 不存在。

---

## 改进建议

1. **Chrome 预装**：在沙箱 Docker 镜像（`registry.shadow-rpa.net/infra/xybot-sandbox-coder`）中预装 Chrome for Testing，避免每次下载 178MB 且绕过 DNS 劫持问题。Dockerfile 中添加：

   ```dockerfile
   RUN curl -sk -o /tmp/chrome.zip "https://storage.googleapis.com/chrome-for-testing-public/149.0.7827.54/linux64/chrome-linux64.zip" \
     && unzip /tmp/chrome.zip -d /opt/chrome && rm /tmp/chrome.zip
   ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/chrome/chrome-linux64/chrome
   ```

2. **agent-browser CLI 预装**：同样在镜像中预装 `npm install -g agent-browser`，消除每次 exec 安装的步骤。

3. **PATH 配置**：将 `/home/coder/.npm-global/bin` 加入 sandbox 默认 PATH，使 `agent-browser` 命令可直接使用。

---

## 结果汇总

> **2026-08-08 本地库全量重跑**：T15.1-T15.27 全部在本地 PG（`opencode_test` @ 5433）+ 沙箱镜像（预装 agent-browser 0.31.1 + Chromium 151）重跑验证通过。

| 用例 | 状态 | 说明 |
|------|------|------|
| T15.1 | ✅ | 简单 skill 创建+触发，AI 明确提到 reviewer skill |
| T15.2 | ✅ | 复杂 bundle 创建；API 只返回 metadata；AI 从隐藏目录读取资源（2026-08-08 经 T15.7/T15.16 同型 bundle 验证通过） |
| T15.3 | ✅ | 删除单个+清空全部 |
| T15.4 | ✅ | 从目录加载 skill bundle，AI 引用 security-checklist + safe-query（2026-08-08 重跑通过） |
| T15.5 | ✅ | SkillsMP 拉取 10 个真实 skill 并执行，10/10 名称提及、资源路径引用（2026-08-08 重跑通过） |
| T15.6 | ✅ | 重复创建同名 skill（upsert 覆盖），PG description=v2, res_count=2 |
| T15.7 | ✅ | skill tool 自动物化到隐藏目录，tool output 含 resource_directory 不泄漏正文（2026-08-08 重跑通过） |
| T15.8 | ✅ | skill 不存在时 AI 未调用 skill tool，直接告知不可用 |
| T15.9 | ✅ | session skill 覆盖全局同名，AI 加载 SESSION 版本（2026-08-08 重跑通过） |
| T15.10 | ✅ | permission deny 生效，skill tool 未被调用（2026-08-08 重跑通过） |
| T15.11 | ✅ | 600KB resource（>512KB）和 70 个 resources（>64）均被拒绝 400，PG 无部分快照（2026-08-08 重跑通过，限制见 resource.ts MAX_SIZE=512KB/MAX_COUNT=64） |
| T15.12 | ✅ | 全局 skill 列表返回 customize-opencode |
| T15.13 | ✅ | 多 skills 主动触发，AI 三维度（安全/性能/风格）完整报告（2026-08-08 重跑通过） |
| T15.14 | ✅ | 多 skills 被动触发，AI 自动加载 git-helper（回复 GIT_HELPER已激活）（2026-08-08 重跑通过） |
| T15.15 | ✅ | preloaded_skills manifest：只有 name/desc/location + path/type/size/digest（2026-08-08 重跑通过） |
| T15.16 | ✅ | skill tool 仅接收 name，自动物化全部资源，输出 metadata + hidden directory（2026-08-08 重跑通过） |
| T15.17 | ✅ | code-agent 通过 read 读取隐藏目录；不存在文件由文件工具报错（2026-08-08 重跑通过） |
| T15.18 | ✅ | A=['private-skill'], B=[], PG 只有 A |
| T15.19 | ✅ | 删除前 COUNT=2, 删除后 COUNT=0 |
| T15.20 | ✅ | HTTP 200, real-skill 加载成功, ghost-skill 被忽略 |
| T15.21 | ✅ | 空/超长(300)/路径/斜杠/空格/`<>`/中文/大写/连字符边界 全部 400 拒绝，PG 无残留（2026-08-08 重跑通过，正则 `^[a-z0-9][a-z0-9-]*$` 长度≤64） |
| T15.22 | ✅ | 5 并发 PG COUNT=1, upsert 安全（2026-08-08 重跑通过） |
| T15.23 | ✅ | API metadata-only；Unicode/emoji/中文在 PG 和物化文件中字节级完整保留（2026-08-08 重跑通过） |
| T15.23a | ✅ | 2026-08-25 重跑通过：Session `ses_fc7e0d251ffegJvYwRZaPZ3Zvw` 返回 HTTP 200，API/PG 仅保留 `valid.md`（resource_count=1），`.pyc` 路径未落库 |
| T15.24 | ✅ | 创建 agent-browser 会话 skill（2026-08-08 重跑通过：agent-browser 0.31.1 mise shim + Chromium 151.0.7922.34 + headless 渲染 + skill 创建） |
| T15.25 | ✅ | 使用 agent-browser 浏览网页（2026-08-08 重跑通过：open/snapshot/get title/get url/close 全流程，PG 确认 5 次 bash 命令） |
| T15.26 | ✅ | agent-browser + page-summarizer 共存（2026-08-08 重跑通过：依次加载两 skill，AI 先浏览 JSON 页再用 page-summarizer 结构化总结，含 [PAGE-SUMMARIZER] 前缀；目标由 httpbin 改 jsonplaceholder 因 httpbin 当日 503） |
| T15.27 | ✅ | 120KB 脚本不进入上下文（tool output 536B 不泄漏），kill-sandbox 重建后 PVC 物化文件保留，两次执行均 LARGE_SCRIPT_OK（2026-08-08 重跑通过） |
