# 基础健康与元信息、Session 生命周期

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## ⚠️ V1 路径已失效（2026-09-29）

原文档使用 V1 路径。**V2 无兼容层**，V1 请求会命中 **SPA fallback 返回 HTML 200** —— 判定端点存在必须看 `content-type`。

| V1 | V2 | 差异 |
|---|---|---|
| `GET /global/health` | `GET /api/info` | 返回 `{version, pid, urls, paths}`，**无 `healthy` 字段** |
| `GET /global/config` | `GET /api/config` | 返回**数组**（配置文档列表），V1 返回 dict |
| `GET /path` | `GET /api/location` | 返回 `{directory, project:{id, directory, canonical}}` |
| `POST /session` | `POST /api/session` | 无必填字段；返回 `{data: session}` |
| `GET /session` | `GET /api/session` | 返回 `{data:[...], cursor}`，非裸数组 |
| `PATCH /session/:id` | `PATCH /api/session/:id` | **返回 204 空体**，V1 返回 session 对象 |
| `DELETE /session/:id` | `DELETE /api/session/:id` | 返回 **204 空体**，V1 返回 `delete=true` |
| PG 表 `session` | PG 表 **`session_v2`** | 另有 `session_message`（V1 的 `message`） |

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 调用 API 检查返回值 | 字段值与期望一致 |
| 2. PG 记录 | 查询 `session_v2` 验证持久化 | HTTP 响应字段与 PG 记录逐字段匹配 |

## 公共环境

```bash
export BASE="${BASE:-http://localhost:14096}"
export PG_URL="${PG_URL:-postgresql://local@127.0.0.1:5432/opencode-v2-up}"
export MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
api(){ curl -sS --noproxy '*' "${CURL_AUTH[@]}" "$@"; }
pgval(){ psql "$PG_URL" -t -A -c "$1"; }
```

---

## 一、基础健康与元信息

### T1.1 服务健康检查

V2 的 `/api/info` **没有 `healthy` 字段** —— HTTP 200 即代表服务健康。

```bash
curl -s -o /tmp/h.json -w 'HTTP %{http_code}\n' "$BASE/api/info"
cat /tmp/h.json
```

**期望**：HTTP 200，响应形如

```json
{"version":"local","pid":1,"urls":["http://192.168.215.2:4096"],"paths":{"tmp":"/tmp/opencode"}}
```

### T1.2 全局配置查询

⚠️ V2 返回**数组**（配置文档列表），不是 dict。**响应体含 provider 明文 API key，不要整段打印到日志。**

```bash
curl -s -o /tmp/c.json -w 'HTTP %{http_code}\n' "$BASE/api/config"
python3 -c "
import json
d = json.load(open('/tmp/c.json'))
print('类型:', type(d).__name__, '文档数:', len(d))
print('路径:', [x.get('path') for x in d])"     # 只打印 path，不打印 info
```

**期望**：HTTP 200，非空数组。

> **安全提示**：`/api/config` 会把 `providers.*.settings.apiKey` 以明文返回。该端点受 HTTP Basic Auth 保护，但**任何持有密码的调用方都能读到全部 provider 密钥**。若生产环境有低信任调用方，需评估是否应脱敏。

### T1.3 路径信息

```bash
curl -s "$BASE/api/location" | python3 -m json.tool
```

**期望**：`directory=/workspace`；`project.id` 为 32 位 hash。

```json
{"directory":"/workspace","project":{"id":"bf309ff4...","directory":"/workspace","canonical":"/workspace"}}
```

---

## 二、Session 生命周期

### T2.1 创建空 session

```bash
R=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}')
SID=$(echo "$R" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
echo "$R" | jq -c '.data | {id, directory: .location.directory, projectID}'

pgval "SELECT 'directory='||directory||' project_id='||project_id FROM session_v2 WHERE id='$SID'"
```

**期望**：
- HTTP：`id` 非空，`location.directory=/workspace`
- PG：`session_v2` 记录存在，`directory` 与 `project_id` 与 HTTP **完全一致**

> ⚠️ **V1 期望 `projectID=global`，V2 是 32 位 hash**（如 `bf309ff466f7bcd6b1ca4751d16d42627dbac2ee`）。断言应改为「HTTP 与 PG 匹配」，不要写死 `global`。

### T2.2 创建带 title 的 session

```bash
R2=$(curl -s -X POST "$BASE/api/session" -H 'Content-Type: application/json' \
  -d "{\"title\":\"测试会话-1\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}")
SID2=$(echo "$R2" | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])")
pgval "SELECT title FROM session_v2 WHERE id='$SID2'"
```

**期望**：HTTP 与 PG 的 `title` 均为 `测试会话-1`。

### T2.3 列出 session

```bash
curl -s "$BASE/api/session?limit=200" \
  | jq -c '{n: (.data|length), hasCursor: (.cursor != null)}'
pgval "SELECT count(*) FROM session_v2"
```

**期望**：
- HTTP 返回 `{data:[...], cursor:{...}}`，**包含刚创建的 session**
- PG 全表 count > 0
- **HTTP 计数 ≤ PG 总数**（list API 按 project/workspace 过滤，PG 是全表）

> `limit` 上限 200（schema 约束）。响应含 `cursor.previous` / `cursor.next` 不透明游标。

### T2.4 获取单个 session

```bash
curl -s "$BASE/api/session/$SID" \
  | jq -c '.data | {id, title, directory: .location.directory, projectID}'
pgval "SELECT coalesce(title,'(null)')||'|'||directory||'|'||project_id FROM session_v2 WHERE id='$SID'"
```

**期望**：HTTP 与 PG 的 `title`/`directory`/`projectID` **逐字段匹配**。

> 注意 title 为 `null` 时 PG 也是 NULL，拼接后为字符串 `(null)`，比较时注意区分。

### T2.5 修改 session title

⚠️ **V2 的 PATCH 返回 204 空响应体**，V1 返回 session 对象。断言要按 204 + 回读来写。

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X PATCH "$BASE/api/session/$SID" \
  -H 'Content-Type: application/json' -d '{"title":"改名后的会话"}'
pgval "SELECT title FROM session_v2 WHERE id='$SID'"
curl -s "$BASE/api/session/$SID" | jq -c '.data | {title}'
```

**期望**：**HTTP 204**（响应体 0 字节）；PG `title` 与回读结果均为 `改名后的会话`。

### T2.6 删除 session

```bash
curl -s -o /dev/null -w 'DELETE HTTP %{http_code}\n' -X DELETE "$BASE/api/session/$SID"
curl -s -o /dev/null -w 'GET HTTP %{http_code}\n' "$BASE/api/session/$SID"
pgval "SELECT count(*) FROM session_v2 WHERE id='$SID'"
pgval "SELECT count(*) FROM session_message WHERE session_id='$SID'"
```

**期望**：
- DELETE 返回 **204 空体**（V1 返回 `delete=true`）
- 随后 GET 返回 **404**
- PG：`session_v2` count=0，**`session_message` 也级联清零**

---

## 2026-09-29 V2 实测记录

环境：SaaS `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG `opencode-v2-up`。**18 条断言 PASS，0 FAIL。**

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T1.1 | ✅ | `/api/info` HTTP 200，`{version:"local", pid:1, urls:[...], paths:{...}}`；**无 healthy 字段** |
| T1.2 | ✅ | `/api/config` HTTP 200，返回**数组**，2 个文档（`/home/opencode/.config/opencode/opencode.jsonc` 等） |
| T1.3 | ✅ | `directory=/workspace`，`projectID=bf309ff466f7bcd6b1ca4751d16d42627dbac2ee` |
| T2.1 | ✅ | `location.directory=/workspace`；HTTP 与 PG 的 directory/projectID **完全一致** |
| T2.2 | ✅ | `title=测试会话-1`，HTTP 与 PG 一致 |
| T2.3 | ✅ | HTTP 返回 200 条含新建 session；`cursor` 存在；PG 全表 600（HTTP ≤ PG，符合过滤语义） |
| T2.4 | ✅ | `title\|directory\|projectID` 三字段 HTTP 与 PG **逐字节相同** |
| T2.5 | ✅ | PATCH **HTTP 204，响应体 0 字节**；PG 与回读 title 均为 `改名后的会话` |
| T2.6 | ✅ | DELETE **204 空体**；GET→404；PG session=0、**message=0（级联）** |

### V1 → V2 四处需要注意的差异

| 项 | V1 | V2 |
|---|---|---|
| 健康检查 | `/global/health` 返回 `healthy:true` | `/api/info` **无 healthy 字段**，靠 HTTP 200 判断 |
| 全局配置 | `/global/config` 返回 **dict** | `/api/config` 返回**数组**（文档列表） |
| `projectID` | 固定字符串 `global` | **32 位 hash**，同一目录恒定 |
| 改 title | PATCH **返回 session 对象** | PATCH 返回 **204 空体**，需回读确认 |
| 删除 | DELETE 返回 `delete=true` | DELETE 返回 **204 空体** |

### 发现：`/api/config` 泄露明文 provider 密钥

`GET /api/config` 响应中包含 `providers.Yd-DeepSeek.settings.apiKey` 等**明文 API key**。该端点受 HTTP Basic Auth 保护，但**任何持有密码的调用方都能读到全部 provider 密钥**。

这不是本次测试要验证的契约（V1 也有同样行为），但既然实测看到了就记录下来：若生产环境存在低信任调用方，建议评估是否应脱敏返回。

**清理**：本轮 2 个会话已删除，直接 `count` 复查为 0。

---

## 历史记录（V1 时期，保留备查）

> 复测记录（2026-09-06，merge upstream/dev v1.18.29 后，镜像 `t0906-merged-1.18.29`）：T1.1/T1.2/T1.3（`GET /path` directory=/workspace）/T2.1-T2.6 全部 ✅。
