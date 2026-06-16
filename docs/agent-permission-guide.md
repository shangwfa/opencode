# Session Agent 权限最佳实践指南

> 基于 `feat/session-users` 分支代码实现 + 线上会话排查 + 端到端测试验证。
> 测试用例见 [`test-cases/26-session-agent-permissions.md`](./test-cases/26-session-agent-permissions.md)。

---

## 一、权限系统概览

### 权限三态

| action | 行为 | SaaS HTTP API 影响 |
|--------|------|-------------------|
| `allow` | 自动执行 | 正常 |
| `deny` | 阻止 | 工具从 LLM 工具列表移除（`disabled()`） |
| `ask` | 等待确认 | **卡住**（无人回复 → 工具永远 running） |

> ⚠️ SaaS 编排场景**避免 `ask`**，用 `deny` + 白名单替代。

### 权限匹配流程

```
工具调用 → ctx.ask({ permission: "edit", patterns: [path.relative(directory, filepath)] })
    ↓
evaluate(permission, pattern, ruleset) → findLast 从后往前匹配
    ↓
Wildcard.match: * → .*（含 /），? → .，. → \.（字面），** 无特殊语义
    ↓
allow → 放行 / deny → DeniedError / 无匹配 → ask（默认）
```

### 关键代码位置

| 逻辑 | 文件 |
|------|------|
| 配置解析（对象→ruleset） | `permission/index.ts:290` fromConfig |
| 合并（全局+agent） | `agent.ts:548-550` merge |
| 运行时求值 | `permission.ts:21` evaluate (findLast) |
| 工具级粗开关 | `permission.ts:37` disabled |
| 通配符匹配 | `core/util/wildcard.ts` |
| pattern 基准 | `write.ts:53` path.relative(directory, filepath) |
| subagent 权限继承 | `agent/subagent-permissions.ts` |

---

## 二、配置格式

### API 接受的格式

```json
// ✅ 对象语法（推荐）
{
  "permission": {
    "read": "allow",
    "edit": { "*": "deny", "docs/*.md": "allow" },
    "bash": "deny"
  }
}

// ✅ 字符串简写（全开/全关）
{ "permission": { "edit": "deny", "bash": "allow" } }

// ✅ 全局字符串
{ "permission": "allow" }

// ❌ 数组格式（API 返回 400）
{ "permission": [{ "permission": "edit", "pattern": "*", "action": "deny" }] }
```

### fromConfig 转换规则

```
输入: { edit: { "*": "deny", "docs/*.md": "allow" } }
        ↓  Object.entries 按 key 插入顺序遍历
输出: [
  { permission: "edit", pattern: "*",        action: "deny"  },
  { permission: "edit", pattern: "docs/*.md", action: "allow" }
]
```

- 字符串 `"allow"` → `{ pattern: "*" }`
- 对象 `{ "pattern": "action" }` → 每键一条 rule
- `~/` 和 `$HOME/` 开头自动展开为绝对路径

---

## 三、Pattern 写法规则

### 通配符

| 写法 | 含义 | 注意 |
|------|------|------|
| `*` | 零个或多个任意字符（**含 `/`**） | 跨目录匹配，不同于 shell glob |
| `?` | 一个任意字符（**含 `/`**） | — |
| `.` | 字面点（被转义为 `\.`） | **不能当通配符** |
| `**` | **无特殊语义**（= `*`） | 不要用 `**/` 前缀 |
| `...` | 三个字面点 | **不能当通配符** |

### 正确写法

```
analysis/<uuid>/spec/*.md       ✅ 相对路径，精确 UUID
analysis/*/spec/*.md            ✅ * 通配中间路径段
docs/*.md                       ✅ 匹配 docs/ 下所有 .md（含子目录）
config/*.json                   ✅ 匹配 config/ 下所有 .json
```

### 错误写法

```
**/analysis/<uuid>/spec/*.md    ❌ ** 无递归语义，修复后匹配不上
/workspace/analysis/...         ❌ 带前导 /，path.relative 产生的路径无前导 /
analysis/.../spec/*.md          ❌ ... 是字面点，不匹配 UUID
*analysis/<uuid>/spec/*.md      ⚠️ 能用但不必要（修复后 analysis/ 已足够）
```

### 规则顺序（last matching rule wins）

`findLast` 从后往前匹配，**最后一个匹配的规则生效**：

```json
{
  "edit": {
    "*": "deny",              // ← 放最前（catch-all 兜底）
    "docs/*.md": "allow"      // ← 放后面（白名单覆盖 deny）
  }
}
```

**反过来写会导致白名单失效**：

```json
{
  "edit": {
    "docs/*.md": "allow",     // ← 在前
    "*": "deny"               // ← 在后，findLast 总是取到 deny
  }
}
```

---

## 四、工具与权限 key 的对应关系

每个工具调用权限检查时，用固定的 key 去匹配 ruleset。**配置里的 key 决定了哪个工具受控**：

```
write 工具（写文件）     → 查 "edit" 权限
edit 工具（编辑文件）     → 查 "edit" 权限
apply_patch 工具（打补丁）→ 查 "edit" 权限
read 工具（读文件）       → 查 "read" 权限
bash 工具（跑命令）       → 查 "bash" 权限
task 工具（调度子 agent） → 查 "task" 权限
skill 工具（加载技能）    → 查 "skill" 权限
```

> ⚠️ **最容易搞混的点**：`write` 工具查的是 `"edit"` 权限，不是 `"write"`。所以配置里写 `"edit": "deny"` 就能禁止 write/edit/apply_patch 三个工具。写 `"write": "deny"` 不生效。

配置示例：

```json
{
  "edit": { "*": "deny", "docs/*.md": "allow" },
  "read": "allow",
  "bash": "deny"
}
```

- write/edit/apply_patch → 查 `edit` → `docs/*.md` 放行，其他拒绝
- read → 查 `read` → 全部放行
- bash → 查 `bash` → 全部拒绝

### disabled() 工具级粗开关

`disabled()` 决定工具是否出现在 LLM 的工具列表里。它检查 ruleset 中该权限 key 最后一条匹配 `*` 的规则：

```typescript
// permission.ts:37
EDIT_TOOLS = ["edit", "write", "apply_patch"]
// 如果 edit 的最后一条 * 规则是 deny → write/edit/apply_patch 全部从工具列表移除
```

| 配置 | disabled 结果 | LLM 能看到 write 工具？ |
|------|-------------|----------------------|
| `edit: { "*": "deny" }` | write/edit/apply_patch 移除 | ❌ 看不到 |
| `edit: { "*": "deny", "docs/*.md": "allow" }` | **仍然移除**（只看 `*:deny`） | ❌ 看不到 |
| `edit: { "*": "ask", "docs/*.md": "allow" }` | 工具保留（ask ≠ deny） | ✅ 能看到 |

> **关键**：`disabled()` 只看 `*:deny`，不看白名单。如果 catch-all 是 `deny`，即使配了白名单，工具也被完全移除——白名单没机会在运行时生效。
>
> 如果需要白名单生效（工具可用），catch-all 用 `ask` 而非 `deny`。SaaS 无交互场景需要配合自动权限回复（`POST /permission/:id/reply`）。

---

## 五、标准 Agent 配置模板

### specer（需求分析 — 只写 spec 文件）

```json
{
  "read": "allow",
  "edit": {
    "*": "deny",
    "analysis/<uuid>/spec/*.md": "allow",
    "analysis/<uuid>/suggest-step.json": "allow"
  },
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "bash": "deny"
}
```

### planner（方案规划 — 只写 plan 文件）

```json
{
  "read": "allow",
  "edit": {
    "*": "deny",
    "analysis/<uuid>/plan/*.md": "allow",
    "analysis/<uuid>/suggest-step.json": "allow"
  },
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "bash": "deny"
}
```

### builder（编码实施 — 全开）

```json
{
  "read": "allow",
  "edit": "allow",
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "bash": "allow",
  "skill": "allow"
}
```

### reviewer（代码评审 — 只写 review 文件）

```json
{
  "read": "allow",
  "edit": {
    "*": "deny",
    "analysis/<uuid>/review/*.md": "allow",
    "analysis/<uuid>/suggest-step.json": "allow"
  },
  "glob": "allow",
  "grep": "allow",
  "list": "allow",
  "bash": "deny"
}
```

---

## 六、权限合并机制

### 全局 config + agent 自身

```typescript
// agent.ts:548-550
const custom = Permission.fromConfig(input.permission)     // agent 自身
const user = Permission.fromConfig(config.permission)       // 全局 config
const permission = Permission.merge(user, custom)            // [...user, ...custom]
```

全局规则在**前**，agent 规则在**后**。`findLast` 从后往前 → **agent 规则优先**。

**影响**：即使全局配了 `edit:allow`，agent 自身的 `edit:deny` 仍然生效（在后面，findLast 优先）。

### subagent 权限继承

task 工具调度 subagent 时（`subagent-permissions.ts`），subagent session 权限自动派生：

1. 继承父 **agent** 的 `edit:deny` 规则（Plan Mode 限制不被绕过）
2. 继承父 **session** 的 `deny` 规则 + `external_directory` 规则
3. subagent 未配 `task`/`todowrite` 时，默认补 `task:*:deny` / `todowrite:*:deny`

---

## 七、SaaS 场景注意事项

### directory vs worktree（已修复）

| 环境 | directory | worktree | `path.relative(directory, filepath)` |
|------|-----------|----------|------|
| SaaS global project | `/workspace` | `/`（无意义） | `analysis/.../spec/spec.md` |
| 本地 git 项目 | `/repo` | `/repo` | `src/index.ts` |

**修复前**：权限 pattern 用 worktree（`/`）算 → input 多 `workspace/` 前缀 → 白名单失效。
**修复后**：改用 directory → input 与文件操作基准一致 → 白名单生效。

修复文件：`write.ts:53` / `edit.ts:81,137` / `read.ts:54` / `apply_patch.ts:217,225`

### ask 卡住问题

HTTP API 模式下 `ask` 无人回复 → 工具永远 running。解决方案：

```bash
# 方案1: 自动回复（监听 SSE + POST reply）
# SSE 收到 permission.asked 事件后:
POST /permission/:requestID/reply?directory=/workspace
{ "reply": "once" }   # 或 "always"（加入 approved，后续自动放行）

# 方案2: 避免 ask（推荐）
# 用 deny + 白名单替代 ask catch-all
```

### external_directory

写入 `/workspace` 之外的路径（如 `/tmp/`）触发 `external_directory` 权限。默认 `ask`。

SaaS 编排建议显式配置：`"external_directory": "allow"` 或 `"deny"`。

---

## 八、常见错误与排查

### write/edit 全部失败（permission denied）

**排查步骤**：

1. 查 agent 权限配置：`SELECT permission FROM session_agents WHERE session_id=? AND name=?`
2. 查 edit 白名单 pattern：是否有 `*:deny` 但白名单在前面（顺序错误）
3. 查 pattern 前缀：是否用了 `**/` 或 `/workspace/`（不应有前缀）
4. 查 directory：确认 `instance.directory` 值，pattern 应与之相对

### 线上案例对照

| 会话 | pattern | write 结果 | 原因 |
|------|---------|-----------|------|
| ses_136b900 | `**/analysis/...` | ❌ 5/5 error | `**/` 在 directory 基准下不匹配 |
| ses_13599abea | `analysis/...`（无前缀） | ❌ 10/10 error | 修复前 worktree 基准下多 `workspace/` 前缀 |
| ses_1358c667 | `**/analysis/...` | ✅ 2/2 ok | 修复前 worktree=`/` 时 `**/` 碰巧匹配 |
| ses_134b82832 等 6 个 | `*analysis/...` | ✅ 全部 ok | `*` 兼容两种基准 |
| 修复后测试 | `analysis/...`（无前缀） | ✅ ok | directory 基准下直接匹配 |

### disabled() 移除了工具但配了白名单

**现象**：配了 `edit: { "*": "deny", "docs/*.md": "allow" }`，但 write 工具完全不可用。

**原因**：`disabled()` 看到 `edit:*:deny` 就移除整个 edit 工具类，不看白名单。

**解决**：catch-all 用 `ask`（工具保留），或确保 agent 有全局 `edit:allow` 兜底（merge 后 agent 的 deny 在后，但 disabled 只看 deny）。

---

## 九、验证清单

新配置上线前检查：

- [ ] pattern 用相对路径（不带 `/` 前缀、不用 `**/`）
- [ ] `*` catch-all（deny/ask）在对象 key 最前
- [ ] 白名单在 catch-all 之后
- [ ] 避免 `ask`（或确保有自动回复机制）
- [ ] API 用对象语法（不用数组）
- [ ] bash deny 的 agent 不会卡住（bash 不走 ask，直接 disabled）
- [ ] subagent 有 `task:deny` / `todowrite:deny`（或明确 allow）
- [ ] 端到端验证 write 成功 + 非白名单拒绝
- [ ] PG 验证：`SELECT permission FROM session_agents WHERE session_id=? AND name=?`
