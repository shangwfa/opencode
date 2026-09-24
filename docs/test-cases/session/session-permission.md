# 会话级权限配置（V2）

> 本文按当前 V2 HTTP API 重写。V1 原文（`{permission,pattern,action}`、`/session`、PG `session` 表、PATCH 合并语义）保留在 git 历史。
>
> **环境**：`BASE`、`PG_URL`、`MODEL` 由 `test-env.sh` 提供；服务需 Basic Auth（`-u opencode:$OPENCODE_PASSWORD`）。

## V1 → V2 契约变化

| 维度 | V1 | V2 |
|---|---|---|
| 规则字段 | `{permission, pattern, action}` | **`{action, resource, effect}`** |
| `effect`/action 取值 | `action: allow\|deny\|ask` | `effect: allow\|deny\|ask`；`action` 是**动作**（工具名/`read`/`edit`/`external_directory`/`*`） |
| 创建 | `POST /session` + `permission` | `POST /api/session` + **`permissions`** |
| 更新 | `PATCH /session/:id`，**增量合并** | `PATCH /api/session/:id`，**整体替换**，返回 **204**（无响应体） |
| 空数组 | `[]` **不清除** | `[]` **真清除**（替换语义） |
| PG | `session.permission` | **`session_v2.permission`**（单数列，`text`） |
| shell 工具名 | `bash` | **`shell`**（`packages/core/src/tool/plugin/shell.ts:25`） |
| 会话生命周期 | `keep-alive` 端点 | 无该端点（V2 无 keep-alive） |
| 权限请求 | 无 HTTP API | **新增** `POST/GET /api/session/:id/permission[...]` 与 `POST .../reply` |
| 事件 | — | `session.permissions`（durable）、`permission.asked`、`permission.replied` |

## V2 评估语义（判定标准）

```ts
// packages/core/src/permission.ts
configured = merge(agent.permissions ?? missingAgentPermissions, session.permissions ?? [])
// session 规则后置 → evaluate() 用 findLast → 会话规则覆盖 agent/全局
evaluate(action, resource, ...rulesets)  // findLast(Wildcard.match(action, rule.action) && match(resource, rule.resource))
// 无匹配时默认 { effect: "ask" }
// 无 agent 时 missingAgentPermissions = [{ action:"*", resource:"*", effect:"deny" }]
// deny → Permission.BlockedError → { type: "permission.rejected", message: "Permission denied: ..." }
```

`action` 实际取值（谁调用 `permission.assert`）：

| action | 触发方 | `resource` 形态 |
|---|---|---|
| `read` | `file-access.ts:161` | 相对 location 的路径 |
| `edit` | `write`/`patch`/`edit` | 文件路径 |
| `external_directory` | `file-access.ts:142` | 外部绝对路径（如 `/tmp/*`） |
| `shell` | `shell.ts:140/226`（V1 为 `bash`） | 命令串（如 `curl*`） |
| `glob`/`grep`/`webfetch`/`websearch`/`skill` | 各工具 | 工具相关 |
| `<MCP 工具名>` | `mcp.ts:51` | `*` |
| `*` | 通配（放行/拒绝一切） | `*` |

---

## 四、会话级权限规则 CRUD

### T4.1 创建空 session（permissions 默认为空）

```bash
SID=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"perm-empty","location":{"directory":"/workspace"}}' | jq -r '.data.id')
echo "SID=$SID"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq -c '.data.permissions'
psql "$PG_URL" -XAtc "select coalesce(permission,'<NULL>') from session_v2 where id='$SID'"
```
**期望**：创建成功；GET `permissions=null`；PG `permission` 为 `<NULL>`。

### T4.2 POST 创建时直接传 permissions

```bash
SID=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"perm-create","location":{"directory":"/workspace"},
       "permissions":[{"action":"external_directory","resource":"/data/*","effect":"allow"}]}' | jq -r '.data.id')
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq -c '.data.permissions'
psql "$PG_URL" -XAtc "select permission from session_v2 where id='$SID'"
```
**期望**：GET 与 PG 均为 `[{"action":"external_directory","resource":"/data/*","effect":"allow"}]`。

### T4.3 PATCH 设置 permissions（一次可设多条）

```bash
PERM='[{"action":"external_directory","resource":"/tmp/*","effect":"allow"},
       {"action":"read","resource":"../etc/*","effect":"deny"},
       {"action":"shell","resource":"curl*","effect":"deny"}]'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'PATCH=%{http_code}\n' \
  -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' -d "{\"permissions\":$PERM}"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq '.data.permissions | length'
psql "$PG_URL" -XAtc "select permission from session_v2 where id='$SID'"
```
**期望**：`PATCH=204`（无响应体，V1 是 200 + session 详情）；GET 与 PG 均为 **3 条**。

### T4.4 PATCH 是替换语义（不是追加）

> ⚠️ **V2 语义变化**：`Session.setPermissions` 直接发布整组规则（`session.ts:76-82`），**不与旧规则合并**。
> V1 期望的"追加成 3/4 条"在 V2 不成立。

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'PATCH=%{http_code}\n' \
  -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' \
  -d '{"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"deny"}]}'
echo -n "count="; curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq '.data.permissions | length'
```
**期望**：`204`，`count=1`（**覆盖**了 T4.3 的 3 条，而非变成 4 条）。

### T4.5 GET 返回 permissions

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" \
  | jq -c '{count:(.data.permissions|length), rules:.data.permissions}'
```
**期望**：返回 T4.3 写入的 3 条规则，字段为 `action/resource/effect`。

### T4.6 空数组清除 permissions

> ⚠️ **V2 语义变化**：替换语义下 `permissions: []` 会**真清除**（V1 文档记录的"空数组不清除"已不适用）。

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'PATCH=%{http_code}\n' \
  -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' -d '{"permissions":[]}'
echo -n "count="; curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq '.data.permissions | length'
psql "$PG_URL" -XAtc "select coalesce(permission,'<NULL>') from session_v2 where id='$SID'"
```
**期望**：`204`；`count=0`；PG 为 `[]`。

### T4.7 跨 session 隔离

```bash
SA=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{"title":"perm-a","location":{"directory":"/workspace"}}' | jq -r '.data.id')
SB=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{"title":"perm-b","location":{"directory":"/workspace"}}' | jq -r '.data.id')
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SA" -H 'Content-Type: application/json' \
  -d '{"permissions":[{"action":"read","resource":"/secret/*","effect":"deny"}]}' >/dev/null
echo -n "A="; curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SA" | jq -c '.data.permissions'
echo -n "B="; curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SB" | jq -c '.data.permissions'
psql "$PG_URL" -XAtc "select coalesce(permission,'<NULL>') from session_v2 where id='$SB'"
```
**期望**：A 有 1 条规则；B 为 `null`、PG `<NULL>`。

### T4.8 非法 effect 返回 400

```bash
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'http=%{http_code}\n' \
  -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' \
  -d '{"permissions":[{"action":"read","resource":"/tmp/*","effect":"invalid"}]}'
```
**期望**：`400`。

### T4.9 PATCH 不存在 session 返回 404

```bash
curl -sS --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'http=%{http_code}\n' \
  -X PATCH "$BASE/api/session/ses_missing_perm" -H 'Content-Type: application/json' \
  -d '{"permissions":[{"action":"read","resource":"*","effect":"allow"}]}'
```
**期望**：`404`。

### T4.10 规则优先级：具体 resource 与通配并存（存储）

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' \
  -d '{"permissions":[
    {"action":"external_directory","resource":"/tmp/*","effect":"deny"},
    {"action":"external_directory","resource":"/tmp/allow-this/*","effect":"allow"}]}' >/dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq '.data.permissions | length'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq -c '.data.permissions'
```
**期望**：2 条规则均存储（`findLast` 保证后写的 `allow` 对 `/tmp/allow-this/*` 生效）。

### T4.11 通配符 `*`

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" -H 'Content-Type: application/json' \
  -d '{"permissions":[{"action":"*","resource":"*","effect":"allow"}]}' >/dev/null
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID" | jq -c '.data.permissions'
psql "$PG_URL" -XAtc "select permission from session_v2 where id='$SID'"
```
**期望**：`[{"action":"*","resource":"*","effect":"allow"}]` 落库；放行一切动作（含 MCP 工具）。

---

## 五、会话权限对工具行为的影响

> 前提：**沙箱可用**。工具执行在权限评估前就需要沙箱启动，沙箱 `Pending` 时会直接报
> `Sandbox.create failed: ... Last state: Pending`，与权限无关（见本轮实测记录）。

通用流程（V2）：

```bash
new_sid() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"$1\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL$2}" | jq -r '.data.id'
}
# $2 形如 ,"permissions":[...]`；无规则时传空字符串
send_prompt() {
  jq -n --arg text "$2" '{text:$text,metadata:{},delivery:"queue"}' \
    | curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$1/prompt" \
        -H 'Content-Type: application/json' --data-binary @- >/dev/null
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/experimental/session/$1/wait" \
    -H 'Content-Type: application/json' -d '{}' --max-time 240 >/dev/null || true
}
tools() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$1/message?order=asc&limit=200" \
    | jq -c '[.data[]|select(.type=="assistant")|.content[]?|select(.type=="tool")
             |{name,status:.state.status,error:(.state.error.type//null)}]'
}
```

**判定标准（V2）**：
- `effect=allow` → 工具 `status=completed` 且无 `error`
- `effect=deny` → 工具 `status=error`、`error.type=permission.rejected`（`permission.rejected` 由 `to-session-error.ts:40` 映射 `BlockedError`）
- `effect=ask` → `GET /api/session/:id/permission` 出现 pending request（`permission.asked` 事件），回复 `POST .../permission/:id/reply {decision}` 后才继续
- 工具 `status=error` 且 `error.type=unknown` 且 message 含 `Sandbox.create failed` → **环境问题，不算权限用例**

### T5.1 会话 allow 外部目录

```bash
SID=$(new_sid perm-t5.1 ',"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"allow"}]')
send_prompt "$SID" "执行 shell 工具跑 echo hi_t51"
tools "$SID"
```
**期望**：`shell` 为 `completed`（沙箱可用时）。

### T5.2 会话 deny 外部目录

```bash
SID=$(new_sid perm-t5.2 ',"permissions":[{"action":"external_directory","resource":"/etc/*","effect":"deny"}]')
send_prompt "$SID" "执行 shell 工具跑 cat /etc/hostname"
tools "$SID"
```
**期望**：工具 `status=error`、`error.type=permission.rejected`。

### T5.3 会话 allow 覆盖 agent 默认

```bash
SID=$(new_sid perm-t5.3 ',"permissions":[{"action":"external_directory","resource":"/etc/*","effect":"allow"}]')
send_prompt "$SID" "执行 shell 工具跑 cat /etc/hostname"
tools "$SID"
```
**期望**：会话 `allow` 后置覆盖 agent/默认规则 → 工具 `completed`、零 `permission.asked`。

### T5.4 会话 deny 覆盖全局

```bash
SID=$(new_sid perm-t5.4 ',"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"deny"}]')
send_prompt "$SID" "执行 shell 工具跑 sh -c 'echo x > /tmp/t54.txt'"
tools "$SID"
```
**期望**：`error.type=permission.rejected`。

### T5.5 清除后回退到 agent/全局规则

```bash
SID=$(new_sid perm-t5.5 ',"permissions":[{"action":"external_directory","resource":"/tmp/*","effect":"allow"}]')
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X PATCH "$BASE/api/session/$SID" \
  -H 'Content-Type: application/json' -d '{"permissions":[]}' >/dev/null
send_prompt "$SID" "执行 shell 工具跑 echo hi_t55"
tools "$SID"
```
**期望**：`[]` 真清除（V2）→ 回退到 agent 规则（默认 `ask` 时出现 pending request）。

### T5.6 会话 permission 为 ask 时仍弹窗

```bash
SID=$(new_sid perm-t5.6 ',"permissions":[{"action":"shell","resource":"echo_perm_ask*","effect":"ask"}]')
send_prompt "$SID" "执行 shell 工具跑 echo_perm_ask_hello"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/permission" | jq -c '.data'
# 授权后继续
RID=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/permission" | jq -r '.data[0].id')
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w 'reply=%{http_code}\n' \
  -X POST "$BASE/api/session/$SID/permission/$RID/reply" -H 'Content-Type: application/json' -d '{"decision":"once"}'
tools "$SID"
```
**期望**：`GET .../permission` 返回 1 条 pending（`action=shell`、`resources=[echo_perm_ask_hello]`）；回复 `once` 后工具 `completed`。

### T5.7 read 权限

> ⚠️ **V2 行为差异**：`read` 会先做路径边界检查——越界路径直接报 `Path escapes the location: ...`（`type=unknown`），
> **走不到权限评估**。V1 文档的 `../etc/*` 相对路径用法在 V2 会先被边界检查拒绝。因此本用例改为
> 在 workspace 内用 `read` 的 `deny` 规则验证。

```bash
SID=$(new_sid perm-t5.7 ',"permissions":[{"action":"read","resource":"*","effect":"deny"}]')
send_prompt "$SID" "使用 read 工具读取 /workspace 下任意一个已存在的文件"
tools "$SID"
```
**期望**：`read` 工具 `error.type=permission.rejected`（`deny` 在路径检查之后、执行之前生效）。

### T5.8 会话 shell 权限（V2 工具名为 `shell`）

```bash
SID=$(new_sid perm-t5.8 ',"permissions":[{"action":"shell","resource":"curl*","effect":"deny"}]')
send_prompt "$SID" "执行 shell 工具跑 curl http://example.com"
tools "$SID"
# 对照：不匹配的命令不受影响
send_prompt "$SID" "执行 shell 工具跑 echo still_allowed"
tools "$SID"
```
**期望**：`curl*` 被拒（`permission.rejected`）；`echo` 仍 `completed`。
> 注意：V1 的 `{"permission":"bash",...}` 在 V2 必须写 `{"action":"shell",...}`。

### T5.9 规则优先级：具体 resource 胜出

```bash
SID=$(new_sid perm-t5.9 ',"permissions":[
  {"action":"external_directory","resource":"/tmp/*","effect":"deny"},
  {"action":"external_directory","resource":"/tmp/allow-this/*","effect":"allow"}]')
send_prompt "$SID" "执行 shell 工具跑 sh -c 'mkdir -p /tmp/allow-this && echo ok > /tmp/allow-this/t.txt && cat /tmp/allow-this/t.txt'"
tools "$SID"
```
**期望**：`/tmp/allow-this/*` 命中具体 `allow`（`findLast`）→ `completed`。

### T5.10 `action:"*"` 通配放行一切

```bash
SID=$(new_sid perm-t5.10 ',"permissions":[{"action":"*","resource":"*","effect":"allow"}]')
send_prompt "$SID" "执行 shell 工具跑 cat /etc/hostname"
tools "$SID"
psql "$PG_URL" -XAtc "select permission from session_v2 where id='$SID'"
```
**期望**：工具免授权直接执行；PG 为 `[{action:*, resource:*, effect:allow}]`。
**MCP 部分**：若测试环境无已注册 MCP 服务则 SKIP（V1 复测同样 SKIP）。

---

## 测试结果（V2）

> 2026-09-24 实测：镜像 `opencode-saas-e2e:session-fs-fix3`（权限为镜像自带功能，未改代码）、
> 本地 PG `opencode-v2-up`、远端 OpenSandbox、真实 LLM `Yd-DeepSeek/deepseek-v4-flash`。

### T4 系列（HTTP + PG）：11/11 通过

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T4.1 | ✅ | GET `permissions=null`、PG `<NULL>` |
| T4.2 | ✅ | 创建带规则，GET 与 PG 均为 `{action,resource,effect}` |
| T4.3 | ✅ | 一次 PATCH 3 条 → `204`、GET 3 条、PG 3 条 |
| T4.4 | ✅ | `204`、`count=1` —— **替换语义**（V1 期望的 3→4 条不成立，语义已变） |
| T4.5 | ✅ | GET 返回 3 条，字段为 `action/resource/effect` |
| T4.6 | ✅ | `204`、`count=0`、PG `[]` —— **`[]` 真清除**（V1 说不清除，已反） |
| T4.7 | ✅ | A 有规则；B `null`、PG `<NULL>`，跨会话隔离 |
| T4.8 | ✅ | 非法 `effect` → `400` |
| T4.9 | ✅ | 不存在 session → `404` |
| T4.10 | ✅ | 2 条规则（通配 + 具体）均存储 |
| T4.11 | ✅ | `{action:"*",resource:"*",effect:"allow"}` 落库 |

### T5 系列（工具行为）：**环境阻塞，未完成**

| 用例 | 结果 | 说明 |
|---|---|---|
| T5.1 allow | ⚠️ 部分 | 曾观测到 `shell` `status=completed`、`content=[hi_t5a]`（沙箱可用时 allow 生效）；多轮重试被沙箱超时打断 |
| T5.2–T5.10 | ⚠️ 未完成 | 工具在**权限评估前**即失败：`error.type=unknown`、message `Sandbox.create failed: Timeout waiting for sandbox ... Elapsed: 60.1s, Last state: Pending` |

**阻塞根因（非代码缺陷）**：远端沙箱间歇性 `Pending`（60s 创建超时），同一 prompt 的两次重试都停在 `Pending`；
因此 deny/ask 路径拿不到 `permission.rejected` / pending request 结果，无法判定 T5 结论。沙箱恢复稳定后需补跑。

**环境附带发现**：`read` 对越界路径先做边界检查，直接返回 `Path escapes the location: /etc/hostname`（`type=unknown`），
早于权限评估 —— T5.7 若按 V1 用 `../etc/*` 无法验证 read 权限，需改用 workspace 内 `deny` 规则（见 T5.7 修正）。

---

## 需要讨论的差异 / 待办

1. **PATCH 替换 vs V1 合并**：V2 `setPermissions` 是整体替换。若产品需要"增量追加规则"，需另加端点或查询参数；否则客户端必须每次读出-改-写回。
2. **`read` 越界不进权限评估**：`Path escapes the location` 先于 `permission.assert`，使"read 外部目录"类权限用例无法覆盖。需确认这是有意（路径边界优先）还是应先评估 `external_directory` 权限。
3. **沙箱不稳定**：`Sandbox.create ... Pending` 60s 超时，导致 T5 全系列不可判定。需沙箱侧排查/稳定后再补跑 T5。
4. **MCP 权限用例**：当前测试环境无已注册 MCP 服务，T5.10 的 MCP 部分 SKIP（与 V1 复测一致）。
