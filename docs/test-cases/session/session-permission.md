# 会话级权限配置

> 公共测试环境和配置请参考 [`00-preamble.md`](../00-preamble.md)。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 调用 API 检查返回值 | 字段值与期望一致 |
| 2. PG 记录 | 查询 `session` 表 `permission` 列 | 权限规则正确存储 |
| 3. 工具行为 | 通过 AI 发送触发权限的指令，观察工具调用结果 | 按会话配置的规则执行 |

## 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](../00-preamble.md)）。用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。

---

## 四、会话级权限规则 CRUD

### T4.1 创建空 session（permission 默认空）

```bash
source test-lib.sh

SID=$(new_sid -k)
echo "SID: $SID"

echo "--- PG 验证 (permission 为空) ---"
pgval "SELECT permission FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：session 创建成功
- PG：`permission IS NULL`（未设置时为空）

### T4.2 POST 创建时直接传 permission

```bash
RESP=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"perm-test","permission":[{"permission":"external_directory","pattern":"/data/*","action":"allow"}]}')
SID_CREATE=$(echo "$RESP" | jexec "d.get('id')")
echo "SID: $SID_CREATE"

echo "--- PG 验证 ---"
pgval "SELECT permission FROM session WHERE id='$SID_CREATE'"
```

**期望**：
- HTTP：200，`permission` 字段包含传入的规则
- PG：`permission` 列包含 `external_directory:/data/*:allow`

### T4.3 PATCH 设置 permission（替换语义）

```bash
PERM='[{"permission":"external_directory","pattern":"/tmp/*","action":"allow"},{"permission":"read","pattern":"/etc/*","action":"deny"}]'

RESP=$(curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d "{\"permission\":$PERM}")
echo "PATCH response: $(echo "$RESP" | jexec 'd.keys()')"

echo "--- PG 验证 ---"
pgval "SELECT permission FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：200，返回 session 详情
- PG：`permission` 包含 `external_directory:/tmp/*:allow` 和 `read:/etc/*:deny`

### T4.4 PATCH 合并 permission（追加新规则）

```bash
PERM2='[{"permission":"bash","pattern":"curl*","action":"deny"}]'

RESP=$(curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d "{\"permission\":$PERM2}")
echo "PATCH response: $(echo "$RESP" | jexec 'd.keys()')"

echo "--- PG 验证 (合并后应有3条规则) ---"
pgval "SELECT json_array_length(permission) FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：200
- PG：`json_array_length=3`（追加而非替换）

### T4.5 GET 返回 permission

```bash
curl -s "$BASE/session/$SID" | python3 -c "
import json, sys
d = json.load(sys.stdin, strict=False)
perm = d.get('permission', [])
print(f'permission 规则数: {len(perm)}')
for r in perm:
    print(f'  {r[\"permission\"]} / {r[\"pattern\"]} \u2192 {r[\"action\"]}')
print('PASS' if len(perm) == 3 else 'FAIL')
"
```

**期望**：返回 3 条规则，字段与设置一致

### T4.6 PATCH 覆盖 permission（追加 deny 规则使旧 allow 失效）

> PATCH 是增量合并语义（`merge(current, new)`），空数组 `[]` 不会清除已有规则。
> 要让某条 allow 失效，追加一条相同 pattern 的 deny 规则即可（后者优先级更高）。

```bash
# 已有3条规则，其中 external_directory:/tmp/* → allow
# 追加一条 deny 使其失效
RESP=$(curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/tmp/*","action":"deny"}]}')
echo "PATCH response: $(echo "$RESP" | jexec 'd.keys()')"

echo "--- PG 验证 (合并后应有4条规则) ---"
pgval "SELECT jsonb_array_length(permission) FROM session WHERE id='$SID'"
```

**期望**：
- HTTP：200
- PG：`jsonb_array_length=4`（追加而非替换）
- 评估时 `/tmp/*` 匹配最后一条 deny（findLast 语义）

### T4.7 跨 session 隔离

```bash
SID_A=$(new_sid -k)
SID_B=$(new_sid -k)

curl -s -X PATCH "$BASE/session/$SID_A" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"read","pattern":"/secret/*","action":"deny"}]}' > /dev/null

echo "--- Session A permission ---"
pgval "SELECT permission FROM session WHERE id='$SID_A'"

echo "--- Session B permission (应为空) ---"
pgval "SELECT permission FROM session WHERE id='$SID_B'"
```

**期望**：
- Session A：`permission` 非空
- Session B：`permission IS NULL`
- 两 session 互不影响

### T4.8 非法 permission 格式返回 400

```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"read","pattern":"/tmp/*","action":"invalid_action"}]}')

if [ "$HTTP_CODE" = "400" ]; then echo "PASS"; else echo "FAIL (status=$HTTP_CODE)"; fi
```

**期望**：400 Bad Request

### T4.9 PATCH 不存在 session 返回 404

```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/session/ses_nonexistent" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"read","pattern":"*","action":"allow"}]}')

if [ "$HTTP_CODE" = "404" ]; then echo "PASS"; else echo "FAIL (status=$HTTP_CODE)"; fi
```

**期望**：404 Not Found

### T4.10 规则优先级：具体 pattern 优先于通配符

```bash
SID_PRIO=$(new_sid -k)

# 设置两条规则：通配符 deny + 具体路径 allow
curl -s -X PATCH "$BASE/session/$SID_PRIO" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[
    {"permission":"external_directory","pattern":"/tmp/*","action":"deny"},
    {"permission":"external_directory","pattern":"/tmp/allow-this/*","action":"allow"}
  ]}' > /dev/null

echo "--- PG 验证 ---"
pgval "SELECT permission FROM session WHERE id='$SID_PRIO'"
```

**期望**：
- PG：两条规则均存储
- 评估时 `/tmp/allow-this/foo` 匹配 `allow`（具体 pattern 优先）
- `/tmp/other/bar` 匹配 `deny`（通配符兜底）

### T4.11 通配符 pattern 匹配所有路径

```bash
SID_WILD=$(new_sid -k)

curl -s -X PATCH "$BASE/session/$SID_WILD" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"*","action":"allow"}]}' > /dev/null

echo "--- PG 验证 ---"
pgval "SELECT permission FROM session WHERE id='$SID_WILD'"
```

**期望**：
- PG：`pattern: *` 正确存储
- 任何外部目录路径均匹配该规则

---

## 五、会话权限对工具行为的影响

> 以下用例通过 AI 实际调用工具来验证会话权限规则生效。需要 `$MODEL` 可用。

### T5.1 会话 allow 外部目录

```bash
source test-lib.sh

SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/tmp/*","action":"allow"}]}' > /dev/null

send_and_verify "$SID" "读取 /tmp 目录下的文件列表（用 ls /tmp/）" "T5.1 /tmp 读取"
```

**期望**：
- 工具调用成功，`ls /tmp/` 正常执行
- 无权限弹窗阻塞

### T5.2 会话 deny 外部目录

```bash
SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/etc/*","action":"deny"}]}' > /dev/null

send_and_verify "$SID" "读取 /etc/passwd 文件内容" "T5.2 /etc 读取被拒绝"
```

**期望**：
- 工具调用被拒绝
- AI 回复中提示无权限

### T5.3 会话 allow 覆盖全局 deny

```bash
SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/etc/*","action":"allow"}]}' > /dev/null

send_and_verify "$SID" "读取 /etc/hostname 文件内容" "T5.3 会话允许覆盖全局拒绝"
```

**期望**：
- 即使全局配置拒绝 `/etc/*`，会话级别 `allow` 生效
- 工具调用成功

### T5.4 会话 deny 覆盖全局 allow

```bash
SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/tmp/*","action":"deny"}]}' > /dev/null

send_and_verify "$SID" "读取 /tmp 目录下的文件列表（用 ls /tmp/）" "T5.4 会话拒绝覆盖全局允许"
```

**期望**：
- 即使全局配置允许 `/tmp/*`，会话级别 `deny` 生效
- 工具调用被拒绝

### T5.5 清除后回退到全局规则

```bash
SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/tmp/*","action":"allow"}]}' > /dev/null

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[]}' > /dev/null

send_and_verify "$SID" "读取 /tmp 目录下的文件列表（用 ls /tmp/）" "T5.5 清除后回退"
```

**期望**：
- 清除后，权限行为回退到全局/agent 规则
- 如果全局规则是 `ask`，需要用户确认

### T5.6 会话 permission 设为 ask 仍弹窗

```bash
SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/tmp/*","action":"ask"}]}' > /dev/null

send_and_verify "$SID" "读取 /tmp 目录下的文件列表（用 ls /tmp/）" "T5.6 ask 仍弹窗"
```

**期望**：
- 会话规则设为 `ask` 时，仍需用户确认
- 等待用户响应后工具才执行

### T5.7 会话 permission 影响其他工具操作（read）

```bash
SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"read","pattern":"/etc/*","action":"deny"}]}' > /dev/null

send_and_verify "$SID" "读取 /etc/hostname 文件内容" "T5.7 read 拒绝"
```

**期望**：
- session 配置 `read` 为 `deny` 时，read 工具调用被拒绝
- 权限弹窗不出现，直接返回拒绝

### T5.8 会话 permission 影响 shell 工具（bash）

```bash
SID=$(new_sid -kb)

curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"bash","pattern":"curl*","action":"deny"}]}' > /dev/null

send_and_verify "$SID" "执行 curl http://example.com" "T5.8 bash 拒绝"
```

**期望**：
- session 配置 `bash` 为 `deny` 时，匹配 `curl*` 的 bash 命令被拒绝
- 不匹配的命令不受影响

### T5.9 规则优先级：具体 pattern 优先于通配符

```bash
SID=$(new_sid -kb)

# 通配符 deny + 具体路径 allow
curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[
    {"permission":"external_directory","pattern":"/tmp/*","action":"deny"},
    {"permission":"external_directory","pattern":"/tmp/allow-this/*","action":"allow"}
  ]}' > /dev/null

send_and_verify "$SID" "读取 /tmp/allow-this/test.txt 文件内容（如果文件不存在，先创建它）" "T5.9 具体路径允许"
```

**期望**：
- `/tmp/allow-this/` 下的路径匹配具体 `allow` 规则，工具执行成功
- 其他 `/tmp/` 路径匹配通配符 `deny` 规则，工具被拒绝

### T5.10 会话 `permission: "*"` 通配放行一切（含 MCP 工具）

**场景**：MCP 工具（如 `codegraph_codegraph_explore`）的权限询问 `permission` 类型是工具名本身（`session/tools.ts:530`），`external_directory: *` 这类规则**不匹配**它。验证 `{"permission":"*","pattern":"*","action":"allow"}` 通配规则能跨类型放行，MCP 工具调用不再挂起等人工授权（2026-08-19 `ses_fe76d6edaffeqduKwo76qF2rBM` 事故场景）。

```bash
source test-lib.sh

SID=$(new_sid -kb)

# 通配规则：放行任何 permission 类型、任何 pattern
curl -s -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"*","pattern":"*","action":"allow"}]}' > /dev/null

# 诱导调用 codegraph MCP 工具（该工具每次执行前必发 ctx.ask({permission:"codegraph_codegraph_explore", patterns:["*"]})）
send_and_verify "$SID" "使用 codegraph_codegraph_explore 工具在 /workspace 中查询任意符号" "T5.10 MCP 工具免授权"

# 对比组：不设该规则的会话调 codegraph 会挂起等授权（permission.asked 事件 + 无响应）
```

**期望**：
- codegraph 工具调用**直接执行**（status=completed 或业务 error），**无** `permission.asked` 挂起、无「需要权限」人工干预
- 对照组（仅设 `external_directory: * allow`）：codegraph 调用挂起等授权，300s 后被 stall 保护误杀（`Tool execution aborted` / `interrupted: true`）
- PG 验证：`session.permission` 存为 `[{permission:"*",pattern:"*",action:"allow"}]`

**注意事项**：
- `permission: "*"` 是「本会话放弃一切权限防护」——bash 命令、read、任何 MCP 工具全免授权。生产环境建议收敛为精确规则：`{"permission":"codegraph_codegraph_explore","pattern":"*","action":"allow"}`
- 若测试环境无 codegraph MCP 服务，可用任意已注册的 MCP 工具替代

---

## 验收汇总

| 用例 | HTTP 响应 | PG 持久化 | 工具行为 | 结果 |
|------|----------|----------|---------|------|
| T4.1 创建空 session | 200，id 非空 | `permission IS NULL` | — | |
| T4.2 POST 创建传 permission | 200，含 permission 字段 | `permission` 含规则 | — | |
| T4.3 PATCH 设置 permission | 200 | `permission` 含规则 | — | |
| T4.4 PATCH 合并 permission | 200 | `json_array_length=3` | — | |
| T4.5 GET 返回 permission | 3 条规则 | — | — | |
| T4.6 PATCH 覆盖 permission | 200 | `jsonb_array_length=4` | — | |
| T4.7 跨 session 隔离 | — | A 有 B 无 | — | |
| T4.8 非法格式 | 400 | — | — | |
| T4.9 PATCH 不存在 session | 404 | — | — | |
| T4.10 规则优先级 | — | 两条规则均存储 | 见 T5.9 | |
| T4.11 通配符 pattern | 200 | `pattern: *` 存储 | — | |
| T5.1 会话 allow 外部目录 | — | — | 工具执行成功 | |
| T5.2 会话 deny 外部目录 | — | — | 工具被拒绝 | |
| T5.3 会话 allow 覆盖全局 deny | — | — | 工具执行成功 | |
| T5.4 会话 deny 覆盖全局 allow | — | — | 工具被拒绝 | |
| T5.5 清除后回退全局 | — | — | 按全局规则 | |
| T5.6 ask 仍弹窗 | — | — | 等待用户确认 | |
| T5.7 read 拒绝 | — | — | read 被拒绝 | |
| T5.8 bash 拒绝 | — | — | bash 被拒绝 | |
| T5.9 规则优先级 | — | — | 具体 allow > 通配 deny | |
| T5.10 `permission:"*"` 通配放行一切（含 MCP 工具） | — | — | MCP 工具免授权直接执行 | |

---