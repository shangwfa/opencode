# 内置 Agent 契约（V2 API）

> 对照官方文档 <https://opencode.ai/v2/docs/agents/> 的 Builtins / Hidden / Disabled / Permissions 章节。
> 本文档只做当前 `/api/...` 接口与权限决策层断言，**不调用模型**；需要真实执行的场景见 [`agent-runtime.md`](./agent-runtime.md)。

## 一、运行环境

```bash
source docs/test-cases/test-env.sh 3
export PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'   # 完整验收应设置，启用 PG 核验
node docs/test-cases/scripts/builtin-agents-v2.mjs
```

脚本通过 `/api/session/:id/agents`、`/api/session/:id/permission`、`/api/session/:id/agent` 三个接口断言，不依赖模型猜测调用哪个工具；设置 `PG_URL` 时核验覆盖持久化与删除级联。

## 二、用例

### T62.1–T62.2：内置 Agent 矩阵

| Agent ID | API 显示名 | 期望 mode | 期望 hidden |
|---|---|---|---|
| `build` | `Build` | primary | false |
| `plan` | `plan` | primary | false |
| `general` | `General` | subagent | false |
| `explore` | `Explore` | subagent | false |
| `compaction` | `Compaction` | primary | **true** |
| `summary` | `Summary` | primary | **true** |
| `title` | `Title` | primary | **true** |

定义依据：`packages/core/src/plugin/agent.ts`；`plan` 使用 Agent 默认显示名（ID 本身）。

| 用例 | 验证点 |
|---|---|
| T62.1.1–T62.1.5 | 上表 7 个 Agent 的 ID、`source=global`、显示名、mode、hidden |
| T62.2.1 | `GET /agents` 不含 `scout`（V2 已移除该内置 Agent） |
| T62.2.2 | 上表已知内置 Agent 均标记为 `source=global`；该字段也可能用于全局自定义 Agent，不能据此断言全局集合恰好 7 项 |

### T62.3：`general` 不能继续派生子 Agent

文档：「General … but cannot launch more subagents」。

| 用例 | 验证点 |
|---|---|
| T62.3.1 | `POST /permission` 对 `action=subagent, agent=general` 返回 `deny` |
| T62.3.2 | 同 action 在 `agent=build` 下不继承该 deny |
| T62.3.3 | `general` 对 `question` 返回 `deny` |

### T62.4–T62.5：`explore` 只读与 `build` 的敏感文件审批

| 用例 | 验证点 |
|---|---|
| T62.4.1–T62.4.2 | `explore` 对 `edit`、`shell` 返回 `deny` |
| T62.4.3–T62.4.4 | `explore` 对 `read`、`grep` 返回 `allow` |
| T62.4.5–T62.4.6 | `explore` 读取 `.env`、`.env.local` 返回 `ask` |
| T62.4.7 | `explore` 读取 `.env.example` 返回 `allow`（敏感文件例外） |
| T62.5.1–T62.5.4 | `build` 读 `.env`/`.env.local` 为 `ask`，常规文件/`.env.example` 为 `allow` |

### T62.6：覆盖内置 Agent 是追加而非替换

文档：「Agent definitions merge in configuration order … permission rules append」。

给 `build` 追加 `{shell, "git push *", ask}` 后：

| 用例 | 验证点 |
|---|---|
| T62.6.1 | 权限数组长度 +1 且含新规则，内置默认规则未被整体替换 |
| T62.6.2 | 追加后 `build` 仍可执行常规 shell |
| T62.6.3 | 新增的 `git push *` 规则实际评估为 `ask` |
| T62.6.4 | 该覆盖持久化到 PostgreSQL `session_agents.config` |

### T62.7：`disabled` 移除内置 Agent

| 用例 | 验证点 |
|---|---|
| T62.7.1–T62.7.2 | `disabled: true` 后 `plan` 不再出现在有效列表 |
| T62.7.3 | PG 中保存 `disabled: true` |
| T62.7.4–T62.7.5 | `DELETE /agents` 清空覆盖后 `plan` 回到列表 |

### T62.8–T62.10：隐藏 Agent 的列表与选择行为

**这是文档与实现的差异点，用例 pin 的是当前实现的真实契约。**

| 用例 | 验证点 |
|---|---|
| T62.8.1 | `hidden` 内置 Agent **仍出现在** `GET /agents` 有效列表 |
| T62.8.2 | `POST /agent` 接受 `title`/`compaction`/`summary` 并写入 Session——**当前实现不做保留名校验** |
| T62.9.1 | 选择 primary Agent 不改变 Session 已保存的模型（对应文档 Model 章节的分离存储） |
| T62.10.1 | `hidden` 自定义 Agent 保留在列表且 `hidden=true` |
| T62.10.2 | 当前实现也接受选择 `hidden` 自定义 Agent |

> 文档原文称隐藏的 `compaction`/`title`/`summary` "cannot be selected directly"，但当前 `POST /api/session/:id/agent`
> 对这三个 ID 一律返回 204。文档表述与实现不符；差异及 upstream 对齐记录见
> [`UPSTREAM-V2-ALIGNMENT.md`](./UPSTREAM-V2-ALIGNMENT.md)。`hidden` 从 subagent 工具目录中过滤的逻辑位于
> `packages/core/src/tool/plugin/subagent.ts`，目录过滤由 `packages/core/test/tool-subagent.test.ts` 的 context-hook 测试覆盖。

### T62.11–T62.15：真实模型、Sandbox 与工具执行边界

API permission evaluate 只能证明规则结果，不能单独证明执行时授权和文件副作用。新增 runtime 脚本使用真实模型，并通过父/子 Session SSE 观察执行过程。针对已观察到的父模型重复派发子 Agent，runtime 用例直接 prompt 已创建的 child Session，避免模型重试污染工具调用计数；子 Session 仍继承 parent 的 Session Agent 定义：

| 用例 | 验证点 |
|---|---|
| T62.11 | 普通内置 Agent 成功调用 `execute`，确认测试环境 Code Mode sandbox 生效 |
| T62.12 | 在 child Session 直接运行内置 `explore`；允许的 `read` 读取 canary，Sandbox 中无目标副作用文件。模型未尝试 `write`/`shell`（工具未提供给 explore），所以本用例不声称验证这两种工具的 execution-time 拒绝 |
| T62.13 | `explore` 读取唯一 `.env.local-*` 资源触发 `read ask`；SSE 自动 `reject` 后工具未成功、内容不泄露、PG 无保存的批准行 |
| T62.14 | Core 直接执行 `write` leaf，携带 `agent=explore`；模拟 Permission 服务对 `edit` 返回拒绝，断言调用失败且文件不存在、写入适配器未触发 |
| T62.15 | Core 直接执行 `shell` leaf，携带 `agent=explore`；模拟 Permission 服务对 `shell` 返回拒绝，断言调用失败且 marker 文件不存在 |

T62.11–T62.13 脚本：[`../scripts/builtin-agents-runtime-v2.mjs`](../scripts/builtin-agents-runtime-v2.mjs)。为稳定触发指定工具，测试会覆盖 `explore.system`，但通过 permission API 断言原有内置 deny 规则仍生效；这不是对 stock system prompt 遵循性的验收。T62.14–T62.15 位于 `packages/core/test/tool-write.test.ts` 和 `packages/core/test/tool-shell.test.ts`：它们绕过模型的工具目录过滤，直接走真实 leaf 执行链，并用 permission 测试替身确定性触发拒绝；真实规则匹配由 T62.4/T62.5 API 用例覆盖。它们验证工具授权与副作用顺序，不等同于真实模型/远端 Sandbox E2E。

## 三、历史执行记录

**2026-09-29**：`opencode-saas-test` + 本地 PostgreSQL。旧版脚本记录 **45 项通过**。

| 脚本 | 结果 |
|---|---|
| `builtin-agents-v2.mjs` | 45 PASS / 0 FAIL（旧版断言集） |

**2026-10-09 API/PG 复验**：当前源码镜像的隔离容器 `opencode-saas-builtin-agent`（14103）+ 本地 PostgreSQL `opencode-v2-up`。更新后的 API 脚本 **67 项功能断言全部通过**，Session 删除级联清理断言通过；原相关 Core 单测 **29 pass / 0 fail**。本轮补齐后 Core `agent.test.ts` + `tool-subagent.test.ts` **30 pass / 0 fail**，`bun run typecheck` 通过。该 API/PG 记录不包含本节新增 runtime E2E。

**2026-10-09 runtime 复验**：最终脚本 T62.11–T62.13 全部通过。Code Mode `execute` 返回 canary；child Session 中 explore `read` 成功且 Sandbox 无目标副作用文件；`.env` read 只调用一次，SSE 记录 `ask → reject`，工具失败、随机密钥未进入父/子消息，PG 保存行数为 0。执行期间实时订阅了 Session SSE；测试 Session 与容器均已清理。模型未尝试 `write`/`shell`，其 execution-time deny 仍未覆盖。

**2026-10-09 leaf 执行拒绝复验**：T62.14 `tool-write.test.ts` **10 pass / 0 fail**；T62.15 `tool-shell.test.ts` **76 pass / 30 skip / 0 fail**。两项都以 `agent=explore` 实际调用工具 leaf，拒绝发生后断言没有写入/marker 副作用。这里的 permission service 是测试替身，API 规则匹配另由 T62.4 验证。

覆盖矩阵：

| 验收面 | 证据 | 状态 |
|---|---|---|
| 7 个内置 Agent 的 ID / 显示名 / mode / hidden / 来源 | T62.1 | 覆盖 |
| 无 `scout`、已知内置来源 | T62.2 | 覆盖；不误把全局自定义 Agent 当内置 |
| `general` 的 subagent / question deny | T62.3 | 覆盖 |
| `explore` 只读规则与 env 例外、`build` 敏感文件审批 | T62.4–T62.5 | 覆盖代表性资源 |
| 覆盖内置为追加语义、规则命中 + PG 持久化 | T62.6 | 覆盖 |
| `disabled` 移除内置与恢复 | T62.7 | 覆盖 |
| 隐藏 Agent 的列表/选择 API 行为 | T62.8、T62.10 | 覆盖（与文档不符，已记录） |
| hidden/mode/permission 对 subagent 工具目录过滤 | `tool-subagent.test.ts` context hook | 覆盖 |
| 切 Agent 不改会话模型 | T62.9 | 覆盖 |
| hidden 自定义 Agent | T62.10 | 覆盖 |
| `explore` 工具执行时拒绝写入与 shell | T62.14–T62.15 Core leaf tests | 覆盖授权拒绝到达 leaf 后的无副作用；权限替身确定性拒绝，不是远端 Sandbox E2E |
| `explore` 真实读、Sandbox 副作用、`.env` ask/reject | T62.11–T62.13 + SSE、Sandbox、PG | 覆盖；真实模型未发起 `write`/`shell`，目录过滤由 Core leaf 测试绕过验证 |
| `steps` 运行时行为 | — | 见 [`agent-runtime.md`](./agent-runtime.md) |

脚本：[`../scripts/builtin-agents-v2.mjs`](../scripts/builtin-agents-v2.mjs)。

## 四、覆盖完整性评估

**结论：V2 API 契约的主要矩阵已覆盖，但相关功能整体尚不全面。**T62 是确定性的 API 与权限评估测试，不代表 Agent 工具实际执行成功。

| 范围 | 当前证据 | 状态 / 缺口 |
|---|---|---|
| 内置 ID、显示名、mode、hidden、`scout` 缺失 | T62.1–T62.2 + API | 覆盖；API 的 `source=global` 也可能表示全局自定义 Agent，不能据此断言全局列表恰好 7 项 |
| `general` / `explore` / `build` 默认权限 | T62.3–T62.5、`packages/core/test/agent.test.ts` | 覆盖代表性 allow/ask/deny 和 env 例外；未逐条验证完整权限数组 |
| Session 覆盖、disabled、PG 级联 | T62.6–T62.7 + PG | 覆盖追加、规则命中、持久化和删除恢复 |
| hidden Agent API 列表与选择 | T62.8–T62.10 | 覆盖当前接口行为；与官方文档 `cannot be selected directly` 存在差异 |
| hidden/mode/permission 对 subagent 工具目录过滤 | `packages/core/test/tool-subagent.test.ts` | 已补 context-hook 单测，验证 hidden、primary、caller-deny 被过滤，mode=all 保留 |
| `explore` write/shell 执行时拒绝 | T62.14–T62.15 Core tool tests | 已覆盖 leaf 执行链授权拒绝及无副作用；未通过真实模型或远端 Sandbox 执行这两项 |
| `explore` 真实读、Sandbox 副作用与 `.env` ask/reject | T62.11–T62.13 runtime E2E | 已补真实模型用例，SSE、Sandbox、PG 断言通过 |
| 每个内置 Agent 的完整配置字段及真实运行 | T62 + `agent-runtime.md` | **部分覆盖**：model/request/system/steps 未按每个内置 Agent 做完整矩阵；Agent 自定义模型路由另列缺口 |

因此，这份测试适合作为**内置 Agent API、规则矩阵与关键工具边界回归**，不能单独作为内置 Agent 端到端行为的全面验收。仍缺少每个内置 Agent 完整配置矩阵，以及通过真实模型/远端 Sandbox 实际发起被拒绝的 `write`/`shell` 调用。
