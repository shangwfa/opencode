# 基础健康与元信息、Session 生命周期

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 调用 API 检查返回值 | 字段值与期望一致 |
| 2. PG 记录 | 查询数据库验证持久化 | HTTP 响应字段与 PG 记录匹配 |

---

## 一、基础健康与元信息

### T1.1 服务健康检查

```bash
curl -s http://localhost:14096/global/health | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"healthy: {d.get('healthy')}, version: {d.get('version','?')}\")
print('✅ T1.1 PASS' if d.get('healthy') else '❌ T1.1 FAIL')
"
```

**期望**：`healthy: true`

### T1.2 全局配置查询

```bash
curl -s http://localhost:14096/global/config | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"config keys: {list(d.keys())[:5]}...\")
print('✅ T1.2 PASS' if isinstance(d, dict) and len(d) > 0 else '❌ T1.2 FAIL')
"
```

**期望**：返回 config 对象，不报错

### T1.3 路径信息

```bash
curl -s http://localhost:14096/path | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"directory: {d.get('directory')}\")
print('✅ T1.3 PASS' if d.get('directory') == '/workspace' else '❌ T1.3 FAIL')
"
```

**期望**：`directory=/workspace`

---

## 二、Session 生命周期

### 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

### T2.1 创建空 session

```bash
RESP=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}')
SID=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
echo "Response: $(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'directory={d.get(\"directory\")}, projectID={d.get(\"projectID\")}')")"

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT id, directory, project_id FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：`id` 非空，`directory=/workspace`，`projectID=global`
- PG：记录存在，`directory=/workspace`，`project_id=global`

### T2.2 创建带 title 的 session

```bash
RESP=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"测试会话-1"}')
SID2=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "Response: $(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'id={d[\"id\"]}, title={d.get(\"title\")}')")"

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT id, title FROM session WHERE id='$SID2'"
```

**期望**：
- HTTP：`title=测试会话-1`
- PG：`title=测试会话-1`

### T2.3 列出所有 session

```bash
LIST=$(curl -s "$BASE/session")
COUNT=$(echo "$LIST" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
echo "HTTP 返回: $COUNT 条"
echo "$LIST" | python3 -c "
import json,sys
for s in json.load(sys.stdin)[:3]:
    print(f\"  {s.get('id')[:25]}... title={s.get('title','(null)')}\")
"

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT COUNT(*) FROM session"
```

**期望**：
- HTTP：返回数组，包含刚创建的 session
- PG：总数 > 0
- HTTP 计数可能 ≤ PG 总数（list API 按 project/workspace 过滤，PG 全表含其他 project 的 session）

### T2.4 获取单个 session

```bash
curl -s "$BASE/session/$SID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f\"id={d['id']}, title={d.get('title')}, directory={d.get('directory')}\")
"

echo "--- PG 验证 ---"
psql "$PG_URL" -t -c "SELECT id, title, directory, project_id FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：返回 session 详情
- PG：字段与 HTTP 响应匹配

### T2.5 修改 session title

```bash
RESP=$(curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' -d '{"title":"改名后的会话"}')
NEW_TITLE=$(echo "$RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('title',''))")
echo "HTTP title: $NEW_TITLE"

echo "--- PG 验证 (修改后) ---"
psql "$PG_URL" -t -c "SELECT title FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：`title=改名后的会话`
- PG：`title=改名后的会话`

### T2.6 删除 session

```bash
RESP=$(curl -s -X DELETE "$BASE/session/$SID")
echo "Delete response: $RESP"

echo "--- 验证 GET 返回 404 ---"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID")
echo "GET status: $HTTP_CODE"

echo "--- PG 验证 (删除后) ---"
psql "$PG_URL" -t -c "SELECT COUNT(*) FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：`delete=true`，GET 返回 404
- PG：`COUNT=0`

---

## 验收汇总

| 用例 | HTTP 响应 | PG 持久化 | 结果 |
|------|----------|----------|------|
| T1.1 健康检查 | `healthy: true` | — | ✅ |
| T1.2 全局配置 | config 对象 | — | ✅ |
| T1.3 路径信息 | `directory=/workspace` | — | ✅ |
| T2.1 创建空 session | `id, directory, projectID` | PG 字段匹配 | ✅ |
| T2.2 创建带 title | `title=测试会话-1` | PG `title` 匹配 | ✅ |
| T2.3 列出 session | 返回数组 | PG 总数匹配 | ✅ |
| T2.4 获取单个 session | session 详情 | PG 字段匹配 | ✅ |
| T2.5 修改 title | `title=改名后的会话` | PG `title` 更新 | ✅ |
| T2.6 删除 session | `true` + 404 | PG `COUNT=0` | ✅ |

---

