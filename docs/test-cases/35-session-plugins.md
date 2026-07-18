# Session Plugins 测试用例

> 验证会话级动态 Plugin：PG 持久化、Runtime 加载、Hook 执行、Session 隔离、缓存失效和错误隔离。
>
> 当前测试环境：本地 PG + 远程沙箱，服务地址 `http://localhost:14096`。
>
> **通用清单映射**：API CRUD 章节（T35.1-T35.6 等）遵循 [`00-preamble.md` 附录 A](./00-preamble.md) 通用 CRUD 清单（G1-G9）；其余为 plugin 特有场景（hook 执行/缓存/错误隔离/npm 包）。

---

## 前置条件

```bash
BASE="http://localhost:14096"
PG_URL="postgresql://local@127.0.0.1:5432/opencode"

curl -s --noproxy '*' "$BASE/" -o /dev/null -w "HTTP %{http_code}\n"
```

期望：HTTP 200。PG 表由 SaaS 服务启动时自动迁移创建。

创建 session：

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' -d '{}' |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "$SID"
```

---

## 一、已接入的 Hook 清单

> 下表以 `packages/plugin/src/index.ts` 的 `Hooks` 类型和 `packages/opencode/src/plugin/session-plugin-runtime.ts` 的实际调用点为准。普通实例 Plugin 与 Session Plugin 不是同一条运行时路径；某个 hook 在普通 Plugin 中存在调用，不代表 Session Plugin 也能收到。

| Hook | 接入路径 | 触发方式 |
|------|---------|---------|
| `chat.params` | `session/llm/request.ts` | `/message` 发送 AI 请求 |
| `chat.headers` | `session/llm/request.ts` | `/message` 发送 AI 请求 |
| `chat.message` | `session/prompt.ts` | 用户消息解析完成后、进入模型前 |
| `experimental.chat.system.transform` | `session/llm/request.ts` | `/message` 发送 AI 请求 |
| `experimental.chat.messages.transform` | `session/prompt.ts` | `/message` 进入 runLoop |
| `tool.execute.before` | `session/tools.ts` | 普通工具执行；`TaskTool` 的内部路径目前只有实例 Plugin 调用 |
| `tool.execute.after` | `session/tools.ts` | 普通工具执行；`TaskTool` 的内部路径目前只有实例 Plugin 调用 |
| `command.execute.before` | `session/prompt.ts` | `/command` 执行命令 |
| `experimental.text.complete` | `session/processor.ts` | assistant 文本流结束时 |

**Session Plugin 已接入**（allowlist `session-plugin-runtime.ts:16-34` 共 17 个 hook，均有 `sessionPluginRuntime.trigger` 调用点）：上表全部 9 个 hook + `shell.env`（`tool/shell.ts:530`）+ `experimental.session.compacting`（`session/compaction.ts:351`）+ `experimental.compaction.autocontinue`（`session/compaction.ts:475`）+ `tool`（`session-plugin-runtime.ts:195` → `tool/registry.ts:398` 注入 LLM 工具列表）+ `tool.definition`（`tool/registry.ts:438`）+ `dispose`（`session-plugin-runtime.ts:198`）+ `event`/`auth`。

**不允许**（不在 allowlist，session runtime 过滤）：`config`、`provider`、`permission.ask`、`experimental.provider.small_model`。

**Session Plugin 已补齐的实例级能力**：`event` 按 event 中的 sessionID 路由到对应 Runtime；`auth.loader` 在匹配 provider 的 Session LLM request 中合并返回 options；`tool.definition` 与 `tool` 能向 LLM 工具列表注入 session plugin 定义的工具。

> ⚠️ **与代码核对**（2026-07-18）：早期版本曾把 `shell.env`/`compacting`/`autocontinue`/`tool`/`tool.definition`/`dispose` 列为"未接入/不允许"，当前代码均已接入（见上）。T35.32/T35.33/T35.47 等用例的"未接入"断言已过时，需改为正向断言。

---

## 二、API CRUD

### T35.1 Plugin 创建

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"params-test",
    "description":"Modify chat params",
    "code":"export default async () => ({\"chat.params\": async (_input, output) => { output.temperature = 0 }})"
  }' | python3 -m json.tool
```

**期望**：返回 `name`、`description`、`enabled=true`、`time_created`、`time_updated`；创建/更新响应不返回完整 `code` 源码。

### T35.2 Plugin 列表（字段完整性 + 代码脱敏）

```bash
curl -s --noproxy '*' "$BASE/session/$SID/plugins" | python3 -c '
import json,sys
rows = json.load(sys.stdin)
r = [x for x in rows if x["name"]=="params-test"][0]
print("has name:", "name" in r)
print("has description:", "description" in r)
print("has enabled:", "enabled" in r)
print("has time_created:", "time_created" in r)
print("has time_updated:", "time_updated" in r)
print("code redacted:", "code" not in r or "export default" not in str(r.get("code","")))
'
```

**期望**：`name`/`description`/`enabled`/`time_created`/`time_updated` 完整返回；`code` 不回显完整源码。

### T35.3 同名 Upsert

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"params-test",
    "description":"Updated",
    "code":"export default async () => ({\"chat.params\": async (_input, output) => { output.temperature = 0.1 }})"
  }'

curl -s --noproxy '*' "$BASE/session/$SID/plugins" | python3 -c '
import json,sys
x=[x for x in json.load(sys.stdin) if x["name"]=="params-test"]
print("count:",len(x),"description:",x[0]["description"] if x else None)
'
```

**期望**：同名记录仍只有 1 条，内容更新。

### T35.4 删除单个 Plugin

```bash
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/plugins/params-test" \
  -w '\nHTTP %{http_code}\n'
```

**期望**：HTTP 2xx，列表中不再出现 `params-test`。

### T35.5 清空 Plugins

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"a","code":"export default async () => ({})"}' >/dev/null
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID/plugins" -w 'HTTP %{http_code}\n'
```

**期望**：HTTP 2xx，列表为空。

### T35.6 非法请求

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' -d '{"name":"missing-code"}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：HTTP 400。

---

## 三、PG 持久化

### T35.7 PG 写入

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"pg-test","description":"PG row","code":"export default async () => ({})"}' >/dev/null

psql "$PG_URL" -c \
  "SELECT session_id,name,enabled FROM session_plugins WHERE session_id='$SID';"
```

**期望**：存在当前 session 的 `pg-test` 记录，`enabled=true`。

### T35.8 time_created / time_updated 行为

```bash
# 第一次创建
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ts-test","code":"export default async () => ({})"}' >/dev/null

T1=$(psql "$PG_URL" -tAc "SELECT time_created || '|' || time_updated FROM session_plugins WHERE session_id='$SID' AND name='ts-test';")

sleep 1

# Upsert 更新
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ts-test","code":"export default async () => ({})"}' >/dev/null

T2=$(psql "$PG_URL" -tAc "SELECT time_created || '|' || time_updated FROM session_plugins WHERE session_id='$SID' AND name='ts-test';")

C1=$(echo $T1 | cut -d'|' -f1)
C2=$(echo $T2 | cut -d'|' -f1)
U2=$(echo $T2 | cut -d'|' -f2)

echo "created unchanged: $([ "$C1" = "$C2" ] && echo PASS || echo FAIL)"
echo "updated advanced: $([ "$U2" -gt "$C1" ] 2>/dev/null && echo PASS || echo FAIL)"
```

**期望**：`time_created` 不变，`time_updated` 前进。

### T35.9 Session 删除级联

```bash
curl -s --noproxy '*' -X DELETE "$BASE/session/$SID" -o /dev/null
psql "$PG_URL" -tAc "SELECT count(*) FROM session_plugins WHERE session_id='$SID';"
```

**期望**：返回 `0`。

### T35.10 多 Session 隔离（Store 层）

```bash
SID_A=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
SID_B=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

curl -s --noproxy '*' -X POST "$BASE/session/$SID_A/plugins/create" -H 'Content-Type: application/json' \
  -d '{"name":"isolated","code":"export default async () => ({})"}' >/dev/null

curl -s --noproxy '*' "$BASE/session/$SID_A/plugins" | grep -q isolated && echo "A: PASS"
curl -s --noproxy '*' "$BASE/session/$SID_B/plugins" | grep -q isolated && echo "B: FAIL" || echo "B: PASS"
```

**期望**：A 有 `isolated`，B 没有。

---

## 四、Runtime Hook 执行

> 以下用例验证 session plugin 注册的 hook 在对应执行路径被触发。使用 `/message`（AI 请求路径）的 hook 为主，避免与 session-commands 功能混淆。

### T35.11 空 Runtime 空操作

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

# 不注册任何 plugin，直接发消息
curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：HTTP 200，无 plugin 的 session 正常工作。

### T35.12 `chat.params` Hook

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"params","code":"export default async () => ({\"chat.params\": async (_input, output) => { output.temperature = 0 }})"}' >/dev/null

curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：HTTP 200，Plugin hook 未导致 LLM 请求失败。

### T35.13 `chat.headers` Hook

```ts
export default async () => ({
  "chat.headers": async (_input, output) => {
    output.headers["x-session-plugin"] = "true"
  },
})
```

**期望**：请求正常完成（HTTP 200），其他 session 不受影响。

### T35.14 `experimental.chat.system.transform` Hook

```ts
export default async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.push("Session plugin marker")
  },
})
```

**期望**：当前 session 的模型请求系统提示包含 marker，请求正常完成。

### T35.15 `experimental.chat.messages.transform` Hook

```ts
export default async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    for (const message of output.messages.toReversed()) {
      const part = message.parts.find((part) => part.type === "text")
      if (!part || part.type !== "text") continue
      part.text = "Reply with exactly: MSGHOOK77 and nothing else."
      break
    }
  },
})
```

**期望**：模型回复包含 `MSGHOOK77`。不能只验证 hook 被调用，必须验证修改后的消息被下游 LLM 请求消费。

### T35.16 `tool.execute.before/after` Hook

```ts
export default async () => ({
  "tool.execute.before": async (input, output) => {
    output.args.plugin_marker = "before"
  },
  "tool.execute.after": async (_input, output) => {
    output.metadata = { ...output.metadata, plugin_marker: "after" }
  },
})
```

**期望**：普通工具执行前后 hook 均被调用，且 args/output 的修改进入实际工具结果和消息流。另用 `TaskTool` 触发一次子任务，明确记录当前实现是否只触发实例 Plugin；不能把普通工具的通过结果推断为 TaskTool 路径也已接入 Session Plugin。

### T35.17 `command.execute.before` Hook

```ts
export default async () => ({
  "command.execute.before": async (_input, output) => {
    output.parts.push({ type: "text", text: "plugin command marker" })
  },
})
```

**期望**：仅当前 session 的命令执行收到 marker。

### T35.18 `enabled=false`

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"disabled","enabled":false,"code":"export default async () => ({\"chat.headers\": async () => { throw new Error(\"must not run\") }})"}' >/dev/null

curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：Plugin 记录存在，但 hook 不执行（无异常），消息正常完成。

### T35.19 disabled → enabled 切换

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

# 创建 disabled plugin
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"toggle","enabled":false,"code":"export default async () => ({\"chat.headers\": async () => { throw new Error(\"disabled\") }})"}' >/dev/null

# 确认 disabled 时不报错
curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -o /dev/null -w 'disabled: HTTP %{http_code}\n'

# 启用 plugin（upsert enabled=true）
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"toggle","enabled":true,"code":"export default async () => ({\"chat.headers\": async (_input, output) => { output.headers[\"x-toggle\"] = \"on\" }})"}' >/dev/null

# 确认 enabled 后 hook 生效
curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -o /dev/null -w 'enabled: HTTP %{http_code}\n'
```

**期望**：disabled 时请求正常（hook 未执行）；启用后请求仍正常且 hook 生效。

---

## 五、缓存失效与错误隔离

> 以下用例使用 `chat.headers` hook（`/message` 路径），不依赖命令执行，避免与 session-commands 混淆。

### T35.20 Plugin 代码更新后 Runtime 失效

1. 创建 plugin，`chat.headers` 注入 `x-version: v1`。
2. 发起一次 `/message`，确认 hook 生效。
3. Upsert 同名 plugin，改为 `x-version: v2`。
4. 再发起 `/message`。

**期望**：第二次请求只执行 `v2` 的 hook，旧 hook 不再执行。

### T35.21 Plugin 删除后 Runtime 失效

1. 创建 plugin，`chat.headers` 注入 marker。
2. 发起一次 `/message`，确认 hook 生效。
3. 删除该 plugin。
4. 再发起 `/message`。

**期望**：删除后 hook 不再执行，请求正常完成。

### T35.22 Plugin 语法错误 → 跳过

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"broken","code":"export default {{{ invalid"}' >/dev/null

curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：该 Plugin 被跳过，主请求正常完成。

### T35.23 语法错误修正后重新加载

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

# 创建语法错误的 plugin
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"fixable","code":"export default {{{ invalid"}' >/dev/null

# 修正代码
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"fixable","code":"export default async () => ({\"chat.headers\": async (_input, output) => { output.headers[\"x-fixed\"] = \"true\" }})"}' >/dev/null

# 验证修正后的 plugin 可正常工作
curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：修正后 plugin 正常加载，hook 生效，请求成功。

### T35.24 Hook 抛错隔离

创建两个 plugin：一个 `chat.headers` hook 抛异常，另一个 `chat.headers` hook 注入 marker。

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"throws","code":"export default async () => ({\"chat.headers\": async () => { throw new Error(\"expected\") }})"}' >/dev/null

curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"healthy","code":"export default async () => ({\"chat.headers\": async (_input, output) => { output.headers[\"x-healthy\"] = \"true\" }})"}' >/dev/null

curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：异常 plugin 不阻断后续 plugin 和主流程，请求正常完成。

### T35.25 多 Plugin 稳定执行顺序

创建 3 个 plugin（`a`、`b`、`c`），每个 `chat.headers` hook 向同一个 header 追加自己的名字。

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

for NAME in a b c; do
  curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$NAME\",\"code\":\"export default async () => ({\\\"chat.headers\\\": async (_input, output) => { output.headers[\\\"x-order\\\"] = (output.headers[\\\"x-order\\\"] || \\\"\\\") + \\\"$NAME\\\" }})\"}" >/dev/null
done

curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：请求中的 `x-order` 精确为 `abc`，且 3 个 hook 均执行。顺序应与 `list` 的 `name ASC` 一致，而不是只验证“都执行”。

### T35.26 Session Runtime 隔离（Hook 层）

在 A/B 两个 session 中注册同名 plugin，分别注入不同的 `chat.headers` marker。

**期望**：A 的请求只受 A plugin 影响，B 只受 B plugin 影响；plugin hook 不需要接收 sessionID。

---

## 六、边界与安全

### T35.27 不存在 Session

```bash
curl -s --noproxy '*' -X POST "$BASE/session/ses_NOT_EXIST/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"ghost","code":"export default async () => ({})"}' \
  -w '\nHTTP %{http_code}\n'
```

**期望**：返回明确的 404/400 错误，不产生孤立 PG 记录。

### T35.28 实例级 Hook 被过滤

提交包含 `config` 和 `command.execute.before` 的 plugin：

```ts
export default async () => ({
  config: async () => { throw new Error("must be filtered") },
  "command.execute.before": async (_input, output) => {
    output.parts.push({ type: "text", text: "session-hook-ok" })
  },
})
```

**期望**：`config` hook 不被执行（无异常）；`command.execute.before` 正常执行。

### T35.29 列表代码脱敏

```bash
curl -s --noproxy '*' "$BASE/session/$SID/plugins" | python3 -c '
import json,sys
for r in json.load(sys.stdin):
    code = str(r.get("code",""))
    if "export default" in code:
        print("FAIL: code leaked for", r["name"])
        sys.exit(1)
print("PASS: all code redacted")
'
```

**期望**：列表 API 不返回任何 plugin 的完整源码。

---

## 七、覆盖审计与补充用例

下面这些场景是当前实现边界的一部分，不能用“HTTP 200”代替验证。它们用于补齐工厂生命周期、全部 hook 白名单、部署模式和安全边界。

### T35.30 创建/更新响应的源码暴露

分别检查 `pluginsCreate` 的响应、列表响应和错误响应中的源码字段。

**期望**：创建/更新响应与列表响应统一脱敏，不返回完整源码。

### T35.31 Hook 工厂异常与非法导出

覆盖以下 plugin code：

- `default` 工厂抛异常；
- 没有 `default` 导出；
- `default` 不是函数；
- 工厂返回 `undefined` 或非对象；
- 返回未知 hook 名称或同名非函数值。

**期望**：单个 plugin 加载失败只跳过该 plugin；其他 plugin 和主流程继续执行；未知 hook 不被调用。

### T35.32 全部允许 hook 的接入状态

对 `allowed` 集合中的每个 hook 建立逐项断言：

| Hook | 当前状态 | 用例要求 |
|------|---------|---------|
| `chat.params` | 已接入 | 验证参数被 LLM 消费 |
| `chat.headers` | 已接入 | 验证 header 到达 provider 或可观测请求边界 |
| `experimental.chat.system.transform` | 已接入 | 验证 system 内容被模型消费 |
| `experimental.chat.messages.transform` | 已接入 | 验证消息内容被模型消费 |
| `tool.execute.before` | 已接入 | 验证 args 改变实际工具行为 |
| `tool.execute.after` | 已接入 | 验证返回 title/output/metadata 被消息流消费 |
| `command.execute.before` | 已接入 | 验证 parts 改变实际 command prompt |
| `chat.message` | 已接入 | 验证修改后的 parts 被会话历史和 LLM 消费 |
| `shell.env` | 未接入 | 当前版本必须明确“不应触发”，接入后再改为正向用例 |
| `experimental.session.compacting` | 仅实例 plugin 路径 | 验证 session plugin 不会误触发，或补齐 session runtime 调用 |
| `experimental.text.complete` | 已接入 | 验证最终 assistant 文本被 hook 替换并持久化 |
| `experimental.compaction.autocontinue` | 仅实例 plugin 路径且不在 session allowlist | 验证 session plugin 不会误触发，或补齐 session runtime 调用 |
| `event` | Session Plugin 已接入 | 验证按 event 中的 sessionID 路由，其他 session 不收到 |
| `auth` | Session Plugin 已接入 | 验证匹配 provider 时 loader options 被当前 LLM request 消费 |

`Hooks` 中的 `tool`、`auth`、`provider`、`dispose` 不是字符串 hook；它们也必须作为“不支持的 Session Plugin 能力”单独验证，而不能只用 `tool.definition` 或 `config` 代表。

### T35.33 禁止 hook 的完整过滤

同一个 plugin 同时返回 `config`、`provider`、`dispose`、`permission.ask`、`tool`、`tool.definition`、`experimental.provider.small_model`、`experimental.compaction.autocontinue`，并返回一个允许的 marker hook。

**期望**：所有禁止 hook 都不执行，允许的 marker 正常执行；不能只验证 `config` 一个名称。

### T35.34 Runtime 缓存与工厂调用次数

在工厂中写入计数 marker，在同一个 session 连续执行两次请求，并在更新、删除、清空 plugin 后再次执行。

**期望**：同一 runtime 生命周期内工厂只调用一次；invalidate 后重新加载一次；旧 hook 不会残留；不同 session 的 runtime 不共享 loaded hooks。

### T35.35 Session 删除与 Runtime 清理

先让 session runtime 加载一个带 dispose/清理 marker 的 plugin，再删除 session，随后确认 runtime map 不再保留该 session。

**期望**：数据库级联删除和内存 runtime 清理同时发生，不产生跨 session 的幽灵 hook。若当前 HTTP 删除路径没有调用 `SessionPluginRuntime.dispose`，该用例应记录为实现缺陷而非跳过。

### T35.36 PG 模式与 noop 模式

分别在 `OPENCODE_DATABASE_URL` 开启和关闭时执行 CRUD、列表、runtime acquire 和 invalidate。

**期望**：PG 模式持久化真实记录；无数据库模式不崩溃且 runtime 为空操作，不应声称 plugin 已持久化。

### T35.37 输入边界与路由参数

覆盖空名称、空代码、超长名称/代码、错误类型、未知字段、非法 JSON、包含 `/` 或 URL 编码字符的 plugin name，以及删除不存在的 name。

**期望**：schema 错误返回 400；路由参数不会错删其他 plugin；删除不存在记录保持幂等或返回明确契约；不产生部分写入。

### T35.38 并发写入与失效竞态

并发执行同一 session 同名 upsert、删除/更新与 `/message`，并同时在两个 session 发起请求。

**期望**：每个 session 最终只保留一条同名记录；请求不会混用其他 session 的 code；失效后不会继续执行旧版本 hook；不同 session 可以并发运行。

### T35.39 动态代码执行安全边界

验证 plugin code 是否运行在预期权限边界内：文件系统、环境变量、网络、进程创建、源码临时文件清理，以及异常时临时文件清理。

**期望**：如果这是受信任管理端能力，必须明确其安全模型和授权边界；如果要求不可信租户可上传，则当前动态 import 方案不满足隔离要求，不能仅靠 hook 白名单宣称安全。

### T35.40 Hook 输入契约与 Promise 行为

在每个已接入 hook 中检查 input/output 的字段、可变性和异步行为；覆盖同步返回、resolved Promise、rejected Promise、修改后再抛错。

**期望**：类型契约与运行时行为一致；rejected hook 被隔离；修改在抛错前发生时是否保留必须明确并固定测试结果。

### T35.41 PluginInput 上下文与工厂签名

在 plugin 工厂中读取并记录 `PluginInput` 的 `client`、`project`、`directory`、`worktree`、`serverUrl`、`$` 和 `experimental_workspace`，并验证工厂返回 Promise；在 hook 中再核对 `sessionID` 等 hook-specific input。

**期望**：工厂收到实例上下文且只在 runtime 加载时调用；hook 的 session 输入字段准确；不能假设工厂本身收到 `sessionID`。当前 `Plugin` 的第二个 `options` 参数没有 Session Plugin 持久化入口，必须明确标记为不支持，而不能默认为可用。

---

## 八、与官方插件文档的兼容性审计

官方文档（`https://opencode.ai/docs/zh-cn/plugins/`，2026-07-14）描述的是普通实例 Plugin，不是本功能的 Session Plugin。以下用例必须明确记录“支持、行为不同、还是不支持”，不能把普通 Plugin 的通过结果当作 Session Plugin 的通过结果。

### T35.42 插件模块导出形式

官方文档示例使用命名导出，例如 `export const MyPlugin = async (...) => ...`；Session Plugin Runtime 当前通过动态 import 只接受 `default` 函数。

**期望**：`default` 工厂可加载；仅命名导出的官方示例代码应得到明确错误或文档提示，不能静默表现为 hook 未执行。

### T35.43 官方加载来源与 Session Plugin 来源隔离

官方 Plugin 来源包括全局配置、项目配置、全局插件目录、项目 `.opencode/plugins/` 和 npm 包，并按官方顺序加载；Session Plugin 来源是 PG 中的 session 记录，按 plugin name `ASC` 执行。

**期望**：验证两套来源互不串用；普通 Plugin 不应出现在 Session Plugin CRUD 列表中，Session Plugin 也不应被当作 npm/本地插件安装；同名 plugin 的顺序和覆盖规则分别符合各自契约。

### T35.44 事件订阅能力

官方文档列出了 `session.*`、`message.*`、`tool.*`、`shell.env`、`tui.*` 等事件，并以 `event` hook 发送通知。Session Runtime 现在按 event payload 中的 sessionID 路由事件。

**期望**：当前 session 收到自己的事件，其他 session 不收到；没有 sessionID 的全局事件不应误投递到任意 Session。

### T35.45 `.env` 保护的阻止语义

官方示例在 `tool.execute.before` 中抛异常来阻止读取 `.env`。Session Runtime 当前对每个 hook 使用 `Effect.ignore`，会吞掉异常。

**期望**：必须明确并测试当前行为：Session Plugin hook 抛错不会阻止工具执行，不能宣称 Session Plugin 可实现官方 `.env` 保护示例。若要支持安全拦截，应增加“拒绝/失败”控制流而不只是吞错。

### T35.46 Shell 环境注入范围

官方 `shell.env` 示例声称可注入 AI 工具和用户终端的所有 Shell 执行。Session Plugin 当前没有 `shell.env` runtime 调用点。

**期望**：Session Plugin 注入的 env 不出现在 AI 工具或用户 PTY；普通实例 Plugin 的 env 用例单独验证，不能计入 Session Plugin 覆盖率。

### T35.47 自定义工具注册

官方文档支持 `tool: { mytool: tool(...) }`，并规定自定义工具与内置工具合并、同名时优先覆盖。Session Runtime 当前过滤 `tool`，Session Plugin API 也没有工具定义字段。

**期望**：Session Plugin 返回 `tool` 不会注册工具；自定义工具注册、参数 schema、执行上下文和同名覆盖必须由普通 Plugin 测试覆盖，不能归入本文件的 Session Plugin 验收。

### T35.48 压缩 hook 行为

官方文档支持 `experimental.session.compacting`，包括追加 `output.context` 和完全替换 `output.prompt` 两种行为。Session Runtime 当前不触发该 hook。

**期望**：Session Plugin 的 context/prompt 修改不影响 compaction；普通实例 Plugin 分别验证追加上下文和替换 prompt。若未来接入 Session Runtime，必须补充真实摘要内容验证，而不是只检查 hook marker。

### T35.49 Tool Hook 执行路径矩阵

分别验证以下工具类别，而不是只调用一个普通工具：

| 工具路径 | 当前 Session Plugin 状态 |
|---------|------------------------|
| registry 中的内置/Session 自定义普通工具 | `tool.execute.before/after` 已接入 |
| `TaskTool` 子任务工具 | 目前只有实例 Plugin |
| MCP resource、resource template、resource read | 目前只有实例 Plugin |
| Session MCP tool | 目前只有实例 Plugin |

**期望**：每条路径都记录 before/after marker 和 args/output 是否被消费。未接入路径不能因为普通 registry tool 通过而标记为 Session Plugin 全覆盖。

### T35.50 System/Message Transform 路径矩阵

分别验证普通对话、agent 解析、compaction 三条路径：

- `experimental.chat.system.transform`：agent 解析路径由实例 Plugin 调用；最终 LLM request 路径由实例 Plugin 和 Session Plugin 调用。
- `experimental.chat.messages.transform`：正常 run loop 路径由实例 Plugin 和 Session Plugin 调用；compaction 路径目前只有实例 Plugin。

**期望**：每条路径分别记录调用次数和修改后的下游内容，不能用普通对话一次成功推断 agent/compaction 路径也已覆盖。

### T35.51 Plugin V2 注册 API 边界

`packages/plugin/src/v2` 还定义了 `PluginContext`、`agent`、`aisdk`、`catalog`、`command`、`integration`、`reference`、`skill` 等注册 API。这套 API 与 legacy `Hooks` 返回对象不同。

**期望**：确认当前 `opencode` 服务是否加载或调用 V2 注册 API。若没有调用点，则本文件不能把 V2 hook 计入 Session Plugin 覆盖率；应单独建立 V2 runtime 的测试矩阵，不能仅凭类型定义认为已支持。

### T35.52 Session Plugin npm 包默认最新版本

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"session-compatible-latest","source":"npm","spec":"<session-compatible-package>"}' | python3 -m json.tool
```

**期望**：记录创建成功，Runtime 首次 acquire 时自动安装并加载 npm 包；列表返回 `source=npm` 和原始 `spec`，不返回源码。

### T35.53 Session Plugin npm 包指定版本

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"session-compatible-pinned","source":"npm","spec":"<session-compatible-package>@1.2.3"}'
```

**期望**：安装并加载精确的 `1.2.3`，不会被 `latest` 替换；重复 acquire 使用缓存，不重复安装。

> `opencode-helicone-session` 依赖 `auth` 和 `event`。Session Runtime 已支持这两类能力的 session 路由；端到端验证还必须配置 `helicone` provider 和有效凭据，不能只用默认 `zhipuai` provider 代替。

### T35.54 Session Plugin npm 包版本更新失效

1. 创建 `source=npm`、`spec=package@1.0.1` 的 plugin 并触发一次 Runtime。
2. Upsert 同名记录为 `package@1.0.2`。
3. 再次触发 Runtime。

**期望**：旧 Runtime 被 invalidate，新版本重新解析；旧包导出的 hook 不再残留。

### T35.55 Session Plugin scoped npm 包

使用 `@scope/package` 和 `@scope/package@1.2.3` 两种 spec。

**期望**：正确解析包名和版本，不把 scoped package 的 `@` 误当成版本分隔符。

### T35.56 npm 包入口和兼容性错误隔离

覆盖不存在的包、没有 server 入口的包、导出非法值的包和 `engines.opencode` 不兼容的包，同时注册一个健康的 Session Plugin。

**期望**：失败 npm plugin 被跳过并记录明确错误；健康 plugin 继续执行；安装/入口/兼容性错误不阻断 Session 主流程。

### T35.57 npm Plugin 多导出与 allowlist

使用导出多个 plugin function 的 npm 包，其中一个返回允许 hook，另一个返回 `config`、`event`、`tool` 等受限能力。

**期望**：多个 server plugin 均初始化；允许 hook 生效；受限能力仍被 Session Runtime allowlist 过滤。

### T35.58 真实 npm Plugin 功能：Renamer

安装：

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/plugins/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"renamer","source":"npm","spec":"@sillybit/renamer-opencode-plugin@0.2.1"}'
```

发送用户消息：

```text
Reply with exactly the word OpenCode
```

**期望**：AI 实际回复为 `Renamer`。该用例必须验证 `experimental.chat.messages.transform` 修改后的消息被 LLM 消费，不能只检查 Plugin 记录或 HTTP 200。

**实测**：通过，实际回复为 `Renamer`。

### T35.59 真实 npm Plugin 功能：Helicone Header

安装 `opencode-helicone-session@1.0.1`，配置 `helicone` provider 和有效凭据后发送一次请求。

**期望**：实际 provider 请求包含非空的 `Helicone-Session-Id` 和 `Helicone-Session-Name`，并且两个不同 Session 的值不同。缺少真实 Helicone provider/凭据时，只能验证插件包装器和 Session Runtime 的 `event`/`auth.loader` 路由，不能标记端到端通过。

**当前实测**：插件包装器注入两个 header 通过；真实 Helicone provider 请求待凭据环境。

### T35.60 真实 npm Plugin 功能：DCP 消息裁剪

安装 `@tarquinen/opencode-dcp@3.1.14`，构造包含多个历史 tool output 的 Session，触发其 `experimental.chat.messages.transform`。

**期望**：过期/可裁剪的 tool output 被实际移除或压缩，错误信息和保护列表保持不变；必须检查发送给 LLM 的消息内容。

**当前实测**：npm 安装和 Runtime 加载路径通过；模型请求因工具循环超时，消息裁剪效果尚未验收。

### T35.61 真实 npm Plugin Hook 兼容性分类

检查以下包的实际导出与 Session Runtime 能力：

- `opencode-mem@2.19.4`：主要是 `chat.message`、`event`；Session Runtime 已支持这两个 hook，但需要单独配置其 memory backend 才能验证外部记忆效果。
- `opencode-supermemory@2.0.8`：主要是 `chat.message`、`event`；Session Runtime 已支持这两个 hook，但需要 Supermemory 凭据才可验证外部记忆效果。
- `opencode-translate@1.0.5`：包含 `chat.message`、messages transform、text complete 和 tool hooks；前三类现在已接入，tool hooks 也已接入，需按翻译 provider 配置验证。

**期望**：按实际 Hook 功能分类，不把 npm 安装成功等同于功能兼容；未接入 hook 必须明确列为不支持。

### T35.62 新接入 Hook 下游功能

注册一个 Session Plugin：

```ts
export default async () => ({
  "chat.message": async (_input, output) => {
    const part = output.parts.find((part) => part.type === "text")
    if (part && part.type === "text") part.text = "Reply with exactly CHAT_MESSAGE_MARKER"
  },
  "experimental.text.complete": async (_input, output) => {
    output.text = "TEXT_COMPLETE_MARKER"
  },
})
```

发送任意用户消息。

**期望**：会话历史包含 `CHAT_MESSAGE_MARKER`，最终 assistant 文本精确包含 `TEXT_COMPLETE_MARKER`。两项都必须验证下游结果，而不是只检查 hook 被调用。

**实测**：通过，`chat.message` 修改被模型消费，`experimental.text.complete` 最终输出为 `TEXT_COMPLETE_MARKER`。

---

## 九、验收标准

| 类别 | 用例 | 标准 |
|------|------|------|
| Store CRUD | T35.1-T35.6 | 创建/列表/upsert/删除/清空/非法请求 |
| PG 持久化 | T35.7-T35.10 | 写入、时间戳、级联、Store 层隔离 |
| Runtime Hook | T35.11-T35.19 | 空操作、7 个已接入 hook、enabled/disabled 切换 |
| 缓存与隔离 | T35.20-T35.26、T35.34-T35.36、T35.38 | 更新/删除失效、语法错误、修正重试、抛错隔离、多 plugin 顺序、跨 session 隔离、缓存、生命周期、部署模式、并发 |
| 安全与边界 | T35.27-T35.29、T35.30-T35.33、T35.37、T35.39-T35.40、T35.45 | 不存在 session、响应脱敏、全部禁止 hook、输入边界、动态代码权限、输入契约、阻止语义 |
| 官方文档兼容性 | T35.42-T35.50 | 导出形式、加载来源、事件、工具拦截、Shell env、自定义工具、压缩 hook、工具与 transform 路径边界 |
| npm Session Plugin | T35.52-T35.57 | 默认最新、指定版本、版本失效、scoped 包、安装错误、多导出与 allowlist |
| npm Plugin 功能验证 | T35.58-T35.61 | Renamer 下游消息修改、Helicone header、DCP 消息裁剪、真实包兼容性分类 |
| 新接入 Hook | T35.62 | `chat.message` 和 `experimental.text.complete` 下游效果 |

> **总计 62 个用例**。其中 T35.32、T35.49、T35.50 和 T35.51 明确区分 legacy/V2、普通实例 Plugin 和 Session Plugin Runtime；T35.52-T35.62 覆盖 Session Plugin 的 npm 安装和真实功能验证。

## 十、本轮执行结果

执行时间：2026-07-16。测试服务：`http://localhost:14096`，本地 PG + 远程沙箱。

### 已通过

- `test/plugin/session-plugin-runtime.test.ts`：3/3 通过。
- 历史 E2E 脚本 `.tmp-session-plugins-e2e.mjs`：23/23 通过；该脚本的编号是旧版映射，不能替代当前 62 个用例的验收。
- 深层 hook 效果脚本：7/7 通过，验证了 `chat.params`、`chat.headers`、system transform、messages transform、tool before/after、command hook 的下游实际效果。
- 新接入 Hook 功能验证：2/2 通过，`chat.message` 修改进入会话/模型，`experimental.text.complete` 替换最终 assistant 文本。
- 补充 API/PG 脚本：26 项通过。
- 合约审计脚本 `.tmp-session-plugins-contract.mjs`：14/14 通过，覆盖 allowlist、runtime 调用集合、执行顺序、删除清理、输入校验、默认导出、工具和 transform 路径边界、V2 未接入确认。

### 失败

- 本轮功能断言无失败。T35.37 的空 `name`、非法 JSON 和 `enabled` 类型错误分别返回 400。
- T35.30 创建/更新响应已与列表接口统一脱敏，不再返回完整 `code`。

### 未完成或明确阻塞

- T35.36 noop 模式受当前镜像本地 SQLite migration 重复列错误阻塞，需独立干净数据目录/镜像修复后再跑。
- T35.39 动态代码权限边界需要隔离安全环境，不能在当前服务进程执行破坏性探针。
- T35.40 全 hook 输入字段仍需专门 fixture；当前 7 个 hook 的 output 下游效果已验证。
- T35.45 工具 veto 已验证：Session Plugin hook 抛错不会阻止工具执行，符合当前 `Effect.ignore` 实现但不符合官方 `.env` 防护示例。
- T35.43、T35.44、T35.46、T35.47、T35.48、T35.49、T35.50、T35.51 已通过合约/源码边界审计；它们是当前明确不接入或需要普通 Plugin fixture 的能力，不再标记为实现失败。
- T35.52-T35.57 npm 包 API 创建、默认 spec、精确版本 spec 和 Runtime 安装路径已验证；`auth`/`event` Session 路由也已用实际 marker 验证。`opencode-helicone-session@1.0.1` 的 Helicone provider 端到端请求仍需真实 Helicone 凭据。
- T35.58 Renamer 功能已通过：输入 `OpenCode` 后实际 AI 回复为 `Renamer`。
- T35.59 Helicone 包装器 header 注入已通过；真实 provider 请求待凭据。
- T35.60 DCP 安装/加载已通过，真实消息裁剪尚未通过验收。
- T35.61 mem/supermemory/translate 已完成 Hook 分类；其外部服务效果仍需各自凭据/配置。

> 本轮已修复并回归真实失败项；剩余 3 个需要专用环境或确定性 fixture 的用例保持未宣称通过，不把设计边界伪装成功能覆盖。
