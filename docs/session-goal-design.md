# Session Goal 实现方案

## 一、背景

OpenCode 当前没有 goal（持久化目标）功能。模型 finish 后 runLoop 直接 break，用户需反复输入"继续"驱动长任务。

本方案从 MiMo-Code 迁移 stop-condition goal 功能，采用独立 judge 模型判定完成条件。

### 对标项目对比

| 维度 | stop-condition gate（本方案） | continuation loop（Codex） |
|------|:---:|:---:|
| 侵入性 | 低（2 处 break 点） | 高（需改 idle 调度） |
| 判定可靠性 | 独立 judge 模型 | 模型自判 |
| 实现复杂度 | ~200 行 | ~2000 行 |
| 防作弊 | 模型不知道 goal 存在 | 模型持有 goal 工具 |

## 二、总体架构

```
用户: /goal "tests pass and build succeeds"
  │
  ▼
command() → goal.set(sessionID, condition)
  │  condition 文本作为 prompt 发给模型
  ▼
runLoop while(true) {
  模型工作 → finish
  │
  ▼
  break 点 → goalGate(lastUser)
  │
  ├─ 无 goal → return false → 允许 break
  │
  └─ 有 goal → goal.evaluate(condition, transcript, model)
       │        独立 judge (temperature=0)
       │
       ├─ ok / impossible → clear → break
       │
       └─ not ok → bumpReact()
            ├─ count > 12 → clear → break
            └─ 注入 system-reminder → continue
}
```

## 三、文件清单

| # | 文件 | 操作 |
|---|------|------|
| 1 | `packages/opencode/src/session/goal.pg.ts` | 新增 — PG 表 |
| 2 | `packages/opencode/src/session/goal.ts` | 新增 — Service |
| 3 | `packages/opencode/migration-pg/20260712000000_session_goal/migration.sql` | 新增 |
| 4 | `packages/opencode/test/session/goal.test.ts` | 新增 — 测试 |
| 5 | `packages/opencode/src/command/index.ts` | 修改 — 注册 `/goal` |
| 6 | `packages/opencode/src/session/prompt.ts` | 修改 — goalGate 集成 |

## 四、与 MiMo-Code 的适配差异

| mimo-code | opencode | 适配 |
|---|---|---|
| `EffectLogger` | 不存在 | 改用 `Log.create()` |
| `filterCompactedEffect(id, opts)` | `filterCompactedEffect(id)` | 去掉额外参数 |
| `taskGate` 前置 | 无此概念 | 去掉 |
| 纯内存 | 需要 PG | 追加 PG mirror |
| `ProviderID`/`ModelID` from `@/provider/schema` | 用 `string` | 简化类型 |

## 五、数据模型

### PG Schema

```sql
CREATE TABLE "session_goal" (
    "session_id" text PRIMARY KEY REFERENCES "session"("id") ON DELETE CASCADE,
    "condition" text NOT NULL,
    "react" integer NOT NULL DEFAULT 0,
    "status" text NOT NULL DEFAULT 'active',
    "last_verdict" jsonb,
    "time_created" bigint NOT NULL,
    "time_updated" bigint NOT NULL
);
```

内存状态用 `InstanceState` 的 `Map<SessionID, Goal>`，set/clear/bumpReact 时异步 mirror 到 PG。

## 六、Judge 模型设计

- temperature: 0（确定性判定）
- 输入：完整 transcript（工具调用/结果/图片全部保留）
- 输出 schema: `{ ok: boolean, impossible?: boolean, reason: string }`
- fail-open: judge 出错时允许停止
- 独立确认：不信任工作 agent 的自我报告

## 七、prompt.ts 插入点

```
位置 1: finish break (prompt.ts ~1136)
  if (lastAssistant?.finish && ...) {
+   if (yield* goalGate(lastUser)) continue
    break
  }

位置 2: outcome break (prompt.ts ~1358)
  if (outcome === "break") {
+   if (yield* goalGate(lastUser)) continue
    break
  }
```

## 八、常量

```typescript
const MAX_GOAL_REACT = 12  // judge 重入上限
```
