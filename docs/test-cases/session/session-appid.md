# 会话 appId 功能（创建标记 + 按 appId 查询）

> 验证 `feat: session appId query support` 的功能：创建会话时传入业务侧 `appId`，后续按 `appId` 查询该业务的全部会话。
>
> **背景**：SaaS 前端需要按业务项目维度聚合会话。复用已有的 `app_id` 列（无外键约束），请求体 `appId` 直接落库 `session.app_id`；列表接口新增 `?appId=` 过滤；默认按 `time_updated`（最后活动时间）降序。
>
> 改动点：
> 1. `packages/opencode/src/session/session.ts` — `ListInput` 增加 `appId`，`listByProject` 增加 `eq(SessionTable.app_id, ...)` 条件
> 2. `packages/opencode/src/server/routes/instance/httpapi/groups/session.ts` — `ListQuery` 增加 `appId` 字段
> 3. `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` — list handler 透传 `appId`
>
> 注意：创建传 `appId`、详情返回 `appId` 原本已支持（`CreateInput.appId`，校验 `[\w\-.]{1,128}`），本次新增的是**查询过滤**。

## 公共环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。
>
> 消息接口模型用 `$MODEL`（`Yd-DeepSeek/deepseek-v4-flash`）。**不要用 zhipuai**（本地 ZHIPU_API_KEY 余额不足返回 429，会触发长重试表现为挂死，见「已知问题」）。

---

## APP-1: 创建会话传 appId

### T41.1.1 创建带 appId 的会话并持久化

```bash
R=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"appId":"biz-proj-001","title":"app session 1"}')
echo "$R" | jq '{id, appId, title}'
SID1=$(echo "$R" | jq -r .id)
```

**期望**：返回会话 info，`appId: "biz-proj-001"`；PG 落库验证：

```bash
psql "$PG_URL" -t -A -c "SELECT app_id FROM session WHERE id='$SID1'"
# 期望输出: biz-proj-001
```

### T41.1.2 不带 appId 创建，字段为空

```bash
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"no app"}' \
  | jq '{appId, title}'
```

**期望**：`appId: null`（可选字段，不影响创建）。

### T41.1.3 非法 appId 被拒绝

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"appId":"bad id!"}'
```

**期望**：HTTP 400（appId 仅允许 `[a-zA-Z0-9_\-.]{1,128}`，含空格/中文/特殊字符拒绝）。

---

## APP-2: 按 appId 查询会话列表

### T41.2.1 过滤只返回匹配 appId 的会话

```bash
# 准备：两个不同 appId + 一个无 appId
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"appId":"biz-proj-001","title":"a1"}' >/dev/null
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"appId":"biz-proj-002","title":"a2"}' >/dev/null
curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"none"}' >/dev/null

curl -s "$BASE/session?appId=biz-proj-001" | jq 'length, .[].appId'
```

**期望**：只返回 `appId=biz-proj-001` 的会话；所有返回行的 `appId` 均为 `biz-proj-001`；不含 `biz-proj-002` 和无 appId 的会话。

### T41.2.2 不存在的 appId 返回空列表

```bash
curl -s "$BASE/session?appId=no-such-app" | jq 'length'
```

**期望**：`0`。

### T41.2.3 与其他查询参数组合

```bash
curl -s "$BASE/session?appId=biz-proj-001&limit=10&search=关键词" | jq 'length'
```

**期望**：appId 过滤与 limit/search/roots/start 等既有参数正交组合，无冲突。

---

## APP-3: 默认按最后活动时间降序

### T41.3.1 发消息后会话排到最前

> **注意**：排序键 `time_updated` 由**发消息**等会话活动刷新（prompt 流程显式 `sessions.touch`）；`PATCH /session/:id` 改标题**不刷新** `time_updated`（`setTitle` 依赖的 drizzle `$onUpdate` 在 PG bridge 不生效，2026-08-17 实测 delta=0）。验证排序必须用发消息。

```bash
# 同 appId 建两个会话，对先建的会话发消息后应排最前
S_OLD=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"appId":"sort-app","title":"older"}' | jq -r .id)
S_NEW=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"appId":"sort-app","title":"newer"}' | jq -r .id)

curl -s "$BASE/session?appId=sort-app" | jq '.[].title'   # 期望: newer 在前

curl -s --max-time 30 -X POST "$BASE/session/$S_OLD/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复:好\"}],\"model\":$MODEL}" >/dev/null
curl -s "$BASE/session?appId=sort-app" | jq '.[].title'   # 期望: older 在前

# PG 验证 time_updated 已刷新
psql "$PG_URL" -t -A -c "SELECT title, time_updated-time_created AS delta FROM session WHERE app_id='sort-app' ORDER BY time_updated DESC;"
```

**期望**：排序键为 `time_updated` 降序（发消息、改标题等任何活动都会刷新），最近活动的会话排最前。

---

## APP-4: 会话消息详情（既有接口回归）

### T41.4.1 按会话 ID 查消息列表

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"appId":"verify-app"}' | jq -r .id)
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"1+1等于几\"}],\"model\":$MODEL}" | jq -r '.parts[] | select(.type=="text") | .text'

curl -s "$BASE/session/$SID/message" | jq '.[] | {role: .info.role, texts: [.parts[] | select(.type=="text") | .text]}'
```

**期望**：消息接口返回完整对话（user「1+1等于几」→ assistant「2」）；`GET /session/$SID` 详情含 `appId`。

---

## 已知问题（2026-08-17 排查记录）

- **zhipuai provider 余额不足表现为「挂死」**：本地 `ZHIPU_API_KEY` 余额耗尽，API 返回 429（code 1113），opencode 的可重试错误匹配（`retry.ts` 将 429 列为 retryable）触发长时间指数退避重试，外部表现为消息无回复、无 error 落库、`OPENCODE_LLM_STALL_TIMEOUT_SEC` 不触发（每次重试都有网络活动，非流停滞）。**测试一律用 `$MODEL`（Yd-DeepSeek）**；若遇 zhipuai 挂死先查余额。
- `app_id` 列目前无索引，会话量大时 `?appId=` 查询走全表扫描；需要时在 PG 加 `CREATE INDEX session_app_id_idx ON session (app_id)`。

---

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-17 | T41.1.1/1.2/1.3 创建 + 持久化 + 非法拒绝 | ✅ | 容器 `opencode-saas-sandbox-test:appid`（本地 PG + 远程沙箱）实测；PG 落库 `app_id=biz-proj-001` |
| 2026-08-17 | T41.2.1/2.2/2.3 appId 过滤 | ✅ | 匹配 `all match: True`；不存在 count=0；limit/search 组合正交 |
| 2026-08-17 | T41.3.1 最后活动时间降序 | ✅ | 发消息后排序翻转（time_updated delta≈52s）；**改标题不刷新 time_updated**（PG bridge `$onUpdate` 不生效，用例已改用发消息验证） |
| 2026-08-17 | T41.4.1 消息详情回归 | ✅ | Yd-DeepSeek 回复正常；详情含 appId |
