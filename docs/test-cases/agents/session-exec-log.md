# Session Exec Log（会话操作审计日志）

> 本文档测试会话操作接口的 exec_log 审计日志记录。所有会话级的变更操作（create/update/delete/clear）应自动记录到 `exec_log` 表，方便后续排查问题。
>
> **前置条件**：SaaS 服务已启动（`docs/local-test-env.md`），组合 1/2（远端 PG）下生效。
>
> **通用清单映射**：T17.1-T17.24 覆盖所有会话操作接口的 exec_log 记录。

## 十七、Session Exec Log（会话操作审计日志）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），仅 PG 模式（SaaS）下生效。
>
> 运行前先加载环境：`source test-env.sh [1|2] && source test-lib.sh`。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

### 辅助函数

```bash
# 查询 session 的 exec_log 记录（按时间倒序）
exec_logs() {
  local sid=$1
  local limit=${2:-50}
  PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode \
    -t -A -F'|' \
    -c "SELECT source, substring(command, 1, 80) as cmd, status FROM exec_log WHERE session_id='$sid' ORDER BY time_created DESC LIMIT $limit"
}

# 查询 session 的特定 source 的 exec_log 条数
exec_log_count() {
  local sid=$1
  local source=$2
  PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode \
    -t -A \
    -c "SELECT COUNT(*) FROM exec_log WHERE session_id='$sid' AND source='$source'"
}
```

---

### T17.1 创建 session 记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{"title":"exec-log-create"}' | jexec "d['id']")
echo "SID: $SID"

COUNT=$(exec_log_count "$SID" "session-create")
echo "session-create count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.1" || fail "T17.1" "session-create not found in exec_log"
```

**期望**：`session-create` 存在至少 1 条 exec_log 记录

### T17.2 更新 session（PATCH）记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{"title":"exec-log-patch"}' | jexec "d['id']")

curl -s --noproxy '*' -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' -d '{"title":"updated-title"}'

COUNT=$(exec_log_count "$SID" "patch")
echo "patch count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.2" || fail "T17.2" "patch not found in exec_log"
```

**期望**：`patch` 存在至少 1 条 exec_log 记录

### T17.3 删除 session — exec_log 级联清理

> ⚠️ `session-delete` 操作本身不记录到 `exec_log`。因为 `exec_log` 表的外键约束是 `ON DELETE CASCADE`，删除 session 时所有关联的 exec_log 记录会被数据库自动级联删除。如果先写日志再删 session，日志也会被级联删除。因此 session 删除的审计通过 T17.18 的级联清理间接验证。

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{"title":"exec-log-cascade"}' | jexec "d['id']")

# 创建一条 exec_log 记录（如创建 agent）
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"cascade-test","description":"cascade","mode":"primary","prompt":"test"}'

# 删除 session
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID"

# 验证 exec_log 被级联清理
COUNT=$(pgval "SELECT COUNT(*) FROM exec_log WHERE session_id='$SID'")
echo "exec_log after session delete: $COUNT"
[ "$COUNT" = "0" ] && pass "T17.3" || fail "T17.3" "exec_log not cascaded (expected 0, got $COUNT)"
```

**期望**：`session-delete` 存在至少 1 条 exec_log 记录

### T17.4 中止 session 记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{"title":"exec-log-abort"}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/abort" 2>/dev/null || true

COUNT=$(exec_log_count "$SID" "session-abort")
echo "session-abort count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.4" || fail "T17.4" "session-abort not found in exec_log"
```

**期望**：`session-abort` 存在至少 1 条 exec_log 记录

### T17.5 分享/取消分享 session 记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{"title":"exec-log-share"}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/share" 2>/dev/null || true
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/share" 2>/dev/null || true

SHR=$(exec_log_count "$SID" "session-share")
UNS=$(exec_log_count "$SID" "session-unshare")
echo "share=$SHR unshare=$UNS"
[ "$SHR" -ge 1 ] && [ "$UNS" -ge 1 ] && pass "T17.5" || fail "T17.5" "share/unshare not found in exec_log"
```

**期望**：`session-share` 和 `session-unshare` 各存在至少 1 条 exec_log 记录

### T17.6 创建 agent 记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-agent","description":"test","mode":"primary","prompt":"You are a test agent."}'

COUNT=$(exec_log_count "$SID" "agent-create")
echo "agent-create count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.6" || fail "T17.6" "agent-create not found in exec_log"
```

**期望**：`agent-create` 存在至少 1 条 exec_log 记录

### T17.7 删除 agent 记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"del-agent","description":"delete test","mode":"primary","prompt":"test"}'
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/agents/del-agent"

COUNT=$(exec_log_count "$SID" "agent-delete")
echo "agent-delete count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.7" || fail "T17.7" "agent-delete not found in exec_log"
```

**期望**：`agent-delete` 存在至少 1 条 exec_log 记录

### T17.8 清空 agents 记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"a1","description":"t1","mode":"primary","prompt":"test"}'
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/agents"

COUNT=$(exec_log_count "$SID" "agent-clear")
echo "agent-clear count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.8" || fail "T17.8" "agent-clear not found in exec_log"
```

**期望**：`agent-clear` 存在至少 1 条 exec_log 记录

### T17.9 创建命令记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/commands/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-cmd","template":"echo hello","description":"test"}'

COUNT=$(exec_log_count "$SID" "command-create")
echo "command-create count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.9" || fail "T17.9" "command-create not found in exec_log"
```

**期望**：`command-create` 存在至少 1 条 exec_log 记录

### T17.10 删除命令记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/commands/create" \
  -H 'Content-Type: application/json' -d '{"name":"del-cmd","template":"echo bye","description":"delete test"}'
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/commands/del-cmd"

COUNT=$(exec_log_count "$SID" "command-delete")
echo "command-delete count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.10" || fail "T17.10" "command-delete not found in exec_log"
```

**期望**：`command-delete` 存在至少 1 条 exec_log 记录

### T17.11 清空命令记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/commands/create" \
  -H 'Content-Type: application/json' -d '{"name":"c1","template":"echo 1"}'
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/commands"

COUNT=$(exec_log_count "$SID" "command-clear")
echo "command-clear count: $COUNT"
[ "$COUNT" -ge 1 ] && pass "T17.11" || fail "T17.11" "command-clear not found in exec_log"
```

**期望**：`command-clear` 存在至少 1 条 exec_log 记录

### T17.12 Agents-md 创建/清空记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents-md/create" \
  -H 'Content-Type: application/json' -d '{"content":"# Agents"}'
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/agents-md"

CRT=$(exec_log_count "$SID" "agentsmd-create")
CLR=$(exec_log_count "$SID" "agentsmd-clear")
echo "create=$CRT clear=$CLR"
[ "$CRT" -ge 1 ] && [ "$CLR" -ge 1 ] && pass "T17.12" || fail "T17.12" "agentsmd-create/clear not found in exec_log"
```

**期望**：`agentsmd-create` 和 `agentsmd-clear` 各存在至少 1 条 exec_log 记录

### T17.13 插件创建/删除/清空记录 exec_log

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' -d '{"name":"test-plugin","code":"export default {}"}'
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/plugins/test-plugin"
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/plugins"

CRT=$(exec_log_count "$SID" "plugin-create")
DEL=$(exec_log_count "$SID" "plugin-delete")
CLR=$(exec_log_count "$SID" "plugin-clear")
echo "create=$CRT delete=$DEL clear=$CLR"
[ "$CRT" -ge 1 ] && [ "$DEL" -ge 1 ] && [ "$CLR" -ge 1 ] && pass "T17.13" || fail "T17.13" "plugin create/delete/clear not found in exec_log"
```

**期望**：`plugin-create`、`plugin-delete`、`plugin-clear` 各存在至少 1 条 exec_log 记录

### T17.14 exec_log 命令字段捕获 payload

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"payload-agent","description":"payload test","mode":"primary","prompt":"test"}'

# 验证 command 字段包含 payload 内容
CMD=$(PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode \
  -t -A \
  -c "SELECT command FROM exec_log WHERE session_id='$SID' AND source='agent-create' ORDER BY time_created DESC LIMIT 1")
echo "command: $CMD"
[[ "$CMD" == *"payload-agent"* ]] && [[ "$CMD" == *"payload test"* ]] && pass "T17.14" || fail "T17.14" "command field missing payload"
```

**期望**：exec_log 的 `command` 字段包含请求 payload 中的 `name` 和 `description`

### T17.15 不同 session 的 exec_log 互相隔离

```bash
SID_A=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"iso-A"}' | jexec "d['id']")
SID_B=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"iso-B"}' | jexec "d['id']")

curl -s --noproxy '*' -X POST "$BASE/session/$SID_A/agents/create" \
  -H 'Content-Type: application/json' -d '{"name":"a1","description":"A","mode":"primary","prompt":"A"}'
curl -s --noproxy '*' -X POST "$BASE/session/$SID_B/agents/create" \
  -H 'Content-Type: application/json' -d '{"name":"b1","description":"B","mode":"primary","prompt":"B"}'

# 验证 A 的日志不含 B 的内容
CMD_A=$(PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode \
  -t -A -c "SELECT COUNT(*) FROM exec_log WHERE session_id='$SID_A' AND command LIKE '%B%'")
CMD_B=$(PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode \
  -t -A -c "SELECT COUNT(*) FROM exec_log WHERE session_id='$SID_B' AND command LIKE '%A%'")
echo "A contains B: $CMD_A, B contains A: $CMD_B"
[ "$CMD_A" = "0" ] && [ "$CMD_B" = "0" ] && pass "T17.15" || fail "T17.15" "exec_log not isolated between sessions"
```

**期望**：session A 的 exec_log 不包含 session B 的内容，反之亦然

### T17.16 不存在的 session 创建 agent 返回 404

```bash
RES=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" -X POST "$BASE/session/ses_nonexistent/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ghost","description":"ghost","mode":"primary","prompt":"ghost"}')
echo "status: $RES"
[ "$RES" = "404" ] && pass "T17.16" || fail "T17.16" "expected 404, got $RES"
```

**期望**：HTTP 404

### T17.17 保留 agent 名被拒绝

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

ALL_OK=true
for NAME in compaction title summary build plan general explore; do
  CODE=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/agents/create" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$NAME\",\"description\":\"override\",\"mode\":\"primary\",\"prompt\":\"override\"}")
  echo "  $NAME: $CODE"
  [ "$CODE" -ge 400 ] || ALL_OK=false
done

$ALL_OK && pass "T17.17" || fail "T17.17" "some reserved names were not rejected"
```

**期望**：`compaction`、`title`、`summary`、`build`、`plan`、`general`、`explore` 均返回 400+

### T17.18 agent 创建带 permission 对象格式验证

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

# 创建带 permission 对象格式的 agent
RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "perm-agent",
    "description": "permission format test",
    "mode": "primary",
    "prompt": "You are a permission test agent.",
    "permission": {
      "read": "allow",
      "bash": {"*": "allow", "*mkdir -p /tmp/opencode*": "allow"},
      "grep": "allow",
      "edit": "deny",
      "write": "deny",
      "task": "allow",
      "external_directory": {
        "/tmp/opencode/**": "allow",
        "/*": "allow"
      }
    }
  }')

PERM_COUNT=$(echo "$RES" | jexec "len(d.get('permission',[]))")
echo "permission count: $PERM_COUNT"
[ "$PERM_COUNT" -ge 6 ] && pass "T17.18" || fail "T17.18" "permission object format not parsed correctly (got $PERM_COUNT)"
```

**期望**：permission 对象格式被正确转换为数组，条数 >= 6

### T17.19 agent 创建带 model 和 color 字段

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "full-agent",
    "description": "full field test",
    "mode": "primary",
    "prompt": "You are a test agent.",
    "temperature": 0.5,
    "color": "#ff0000",
    "model": {"providerID": "Yd-DeepSeek", "modelID": "deepseek-v4-flash"}
  }')

COLOR=$(echo "$RES" | jexec "d.get('color','')")
MODEL=$(echo "$RES" | jexec "d.get('model',{}).get('modelID','')")
TEMP=$(echo "$RES" | jexec "d.get('temperature','')")
echo "color=$COLOR model=$MODEL temperature=$TEMP"
[ "$COLOR" = "#ff0000" ] && [ "$MODEL" = "deepseek-v4-flash" ] && [ "$TEMP" = "0.5" ] && pass "T17.19" || fail "T17.19" "full field agent not persisted correctly"
```

**期望**：`color=#ff0000`、`model.modelID=deepseek-v4-flash`、`temperature=0.5`

### T17.20 空字符串 name 被拒绝

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

CODE=$(curl -s --noproxy '*' -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"","description":"empty name","mode":"primary","prompt":"test"}')
echo "empty name status: $CODE"
[ "$CODE" = "400" ] && pass "T17.20" || fail "T17.20" "expected 400 for empty name, got $CODE"
```

**期望**：空字符串 `name` 返回 400（`Schema.NonEmptyString` 校验）

### T17.21 agent 创建/更新 exec_log 记录命令字段

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

# 创建 agent
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"update-test","description":"v1","mode":"primary","prompt":"version 1"}'

# 更新 agent（同名）
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"update-test","description":"v2","mode":"primary","prompt":"version 2"}'

# 验证 exec_log 有 2 条 agent-create 记录
COUNT=$(exec_log_count "$SID" "agent-create")
echo "agent-create count: $COUNT (expect 2)"
[ "$COUNT" = "2" ] && pass "T17.21" || fail "T17.21" "expected 2 agent-create logs, got $COUNT"
```

**期望**：创建 + 更新（同名 upsert）共产生 2 条 `agent-create` 记录

### T17.22 异常操作不记录 exec_log（权限响应失败）

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

# 尝试对不存在的 permission 请求进行响应 → 应失败
curl -s --noproxy '*' -X POST "$BASE/session/$SID/permission/perm_nonexistent" \
  -H 'Content-Type: application/json' \
  -d '{"response":{"action":"allow"}}' 2>/dev/null || true

COUNT=$(exec_log_count "$SID" "permission-respond")
echo "permission-respond count: $COUNT (expect 0)"
[ "$COUNT" = "0" ] && pass "T17.22" || fail "T17.22" "expected 0 permission-respond logs for failed operation, got $COUNT"
```

**期望**：失败的操作不记录 exec_log（`permission-respond` 条数为 0）

### T17.23 多种操作混合 exec_log 完整性

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{"title":"exec-log-mixed"}' | jexec "d['id']")

# 执行一系列操作
curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' -d '{"name":"mix1","description":"mixed","mode":"primary","prompt":"test"}'
curl -s --noproxy '*' -X POST "$BASE/session/$SID/commands/create" \
  -H 'Content-Type: application/json' -d '{"name":"mix-cmd","template":"echo ok","description":"mixed cmd"}'
curl -s --noproxy '*' -X PATCH "$BASE/session/$SID" \
  -H 'Content-Type: application/json' -d '{"title":"updated-mixed"}'

# 验证所有操作都有记录
AG=$(exec_log_count "$SID" "agent-create")
CM=$(exec_log_count "$SID" "command-create")
PT=$(exec_log_count "$SID" "patch")
echo "agent-create=$AG command-create=$CM patch=$PT"
[ "$AG" -ge 1 ] && [ "$CM" -ge 1 ] && [ "$PT" -ge 1 ] && pass "T17.23" || fail "T17.23" "mixed operations not all logged"
```

**期望**：agent-create、command-create、patch 各存在至少 1 条 exec_log 记录

### T17.24 自定义 model 覆盖验证

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")

RES=$(curl -s --noproxy '*' -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "custom-model-agent",
    "description": "custom model test",
    "mode": "primary",
    "prompt": "You are a test agent.",
    "model": {"providerID": "moonshotai-cn", "modelID": "kimi-k2.7-code"},
    "temperature": 0.9
  }')

MODEL_ID=$(echo "$RES" | jexec "d.get('model',{}).get('modelID','')")
PROV_ID=$(echo "$RES" | jexec "d.get('model',{}).get('providerID','')")
TEMP=$(echo "$RES" | jexec "d.get('temperature','')")
echo "model=$MODEL_ID provider=$PROV_ID temperature=$TEMP"
[ "$MODEL_ID" = "kimi-k2.7-code" ] && [ "$PROV_ID" = "moonshotai-cn" ] && [ "$TEMP" = "0.9" ] && pass "T17.24" || fail "T17.24" "custom model not persisted"
```

**期望**：`model.modelID=kimi-k2.7-code`、`model.providerID=moonshotai-cn`、`temperature=0.9`

---

### T17.25 沙箱创建记录 exec_log（含开始时间与耗时）

> 沙箱创建是 SaaS 模式的关键生命周期事件。验证 `SandboxProvider.createSandbox` 在创建沙箱时记录 `source=sandbox-create` 的 exec_log，且 `time_started` / `time_finished` 有真实时间差（耗时）。

```bash
# 创建 session（沙箱惰性创建，需先触发 AI 工具调用或 exec）
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{"title":"sandbox-create-timing"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 触发沙箱创建：发 AI 消息让模型调 bash 工具（或直接用 exec API）
curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 echo sandbox-timing-test\"}],\"model\":$MODEL}" > /dev/null
sleep 5

# 验证 sandbox-create 记录
psql "$PG_URL" -c "
SELECT id, source, status,
       time_started, time_finished,
       (time_finished - time_started) as duration_ms,
       command
FROM exec_log
WHERE session_id='$SID' AND source='sandbox-create'
ORDER BY time_created DESC;
"
```

**期望**：
- `source=sandbox-create` 存在至少 1 条记录
- `status=completed`
- `time_started` 非空，`time_finished` 非空
- `time_finished > time_started`（`duration_ms > 0`），沙箱创建有真实耗时
- `command` 字段（JSON）含 `sandboxID`、`image`、`durationMs`

### T17.26 沙箱创建耗时合理性验证

> 验证沙箱创建耗时在合理范围内（通常 < 30s），且多次创建的耗时可以被聚合统计。

```bash
# 统计沙箱创建耗时分布
psql "$PG_URL" -c "
SELECT COUNT(*) as total,
       ROUND(AVG(time_finished - time_started)) as avg_duration_ms,
       MIN(time_finished - time_started) as min_duration_ms,
       MAX(time_finished - time_started) as max_duration_ms
FROM exec_log
WHERE source='sandbox-create' AND time_finished > time_started;
"

# 按耗时区间分组
psql "$PG_URL" -c "
SELECT
  CASE
    WHEN (time_finished - time_started) < 1000 THEN '0-1s'
    WHEN (time_finished - time_started) < 5000 THEN '1-5s'
    WHEN (time_finished - time_started) < 30000 THEN '5-30s'
    ELSE '30s+'
  END as bucket,
  COUNT(*) as count
FROM exec_log
WHERE source='sandbox-create' AND time_finished > time_started
GROUP BY bucket
ORDER BY bucket;
"
```

**期望**：
- `avg_duration_ms` 在合理范围（通常 1-10s）
- 无异常超长耗时（除非远端沙箱网络抖动）
- 所有记录 `time_finished > time_started`（无负耗时）

---

### 运行与验证

```bash
# 组合 1（远端 PG）
source test-env.sh 1 && source test-lib.sh

# 执行所有 T17 用例
bash docs/test-cases/agents/session-exec-log.md  # 或逐个复制执行

# 最终汇总
summary
```

> **PG 验证**：所有 exec_log 记录可通过直接查询 `exec_log` 表验证：
> ```bash
> PGPASSWORD=8zuhlMLd4gaeUG5k psql -h 127.0.0.1 -p 15432 -U app -d opencode -c "SELECT source, COUNT(*) as cnt FROM exec_log WHERE session_id='$SID' GROUP BY source ORDER BY source"
> ```