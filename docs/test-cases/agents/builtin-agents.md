# 内置 Agent 契约（V2）

> 对照官方文档 <https://opencode.ai/v2/docs/agents/> 的 Builtins / Hidden / Disabled / Permissions 章节。
> 本文档只做 API 与权限决策层断言，**不调用模型**；需要真实执行的场景见 [`agent-runtime.md`](./agent-runtime.md)。

## 一、运行环境

```bash
source docs/test-cases/test-env.sh 3
export PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'   # 可选，启用 PG 核验
node docs/test-cases/scripts/builtin-agents-v2.mjs
```

脚本通过 `/api/session/:id/agents`、`/permission`、`/agent` 三个接口断言，不依赖模型猜测调用哪个工具；结束时删除自建 Session 并核验 PG 级联。

## 二、用例

### T62.1–T62.2：内置 Agent 矩阵

| Agent | 期望 mode | 期望 hidden | 来源 |
|---|---|---|---|
| `build` | primary | false | `packages/core/src/plugin/agent.ts` |
| `plan` | primary | false | 同上 |
| `general` | subagent | false | 同上 |
| `explore` | subagent | false | 同上 |
| `compaction` | primary | **true** | 同上 |
| `summary` | primary | **true** | 同上 |
| `title` | primary | **true** | 同上 |

| 用例 | 验证点 |
|---|---|
| T62.1.1–T62.1.3 | 上表 7 个内置 Agent 均存在，mode 与 hidden 与文档一致 |
| T62.2.1 | `GET /agents` 不含 `scout`（V2 已移除该内置 Agent） |
| T62.2.2 | `source=global` 的内置集合恰为上表 7 项，无多余残留 |

### T62.3：`general` 不能继续派生子 Agent

文档：「General … but cannot launch more subagents」。

| 用例 | 验证点 |
|---|---|
| T62.3.1 | `POST /permission` 对 `action=subagent, agent=general` 返回 `deny` |
| T62.3.2 | 同 action 在 `agent=build` 下不继承该 deny |

### T62.4–T62.5：`explore` 只读与 `build` 的敏感文件审批

| 用例 | 验证点 |
|---|---|
| T62.4.1–T62.4.2 | `explore` 对 `edit`、`shell` 返回 `deny` |
| T62.4.3–T62.4.4 | `explore` 对 `read`、`grep` 返回 `allow` |
| T62.4.5 | `explore` 读取 `*.env` 返回 `ask` |
| T62.5.1–T62.5.2 | `build` 读 `.env` 为 `ask`，常规项目文件为 `allow` |

### T62.6：覆盖内置 Agent 是追加而非替换

文档：「Agent definitions merge in configuration order … permission rules append」。

给 `build` 追加 `{shell, "git push *", ask}` 后：

| 用例 | 验证点 |
|---|---|
| T62.6.1 | 权限数组长度 +1 且含新规则，内置默认规则未被整体替换 |
| T62.6.2 | 追加后 `build` 仍可执行常规 shell |
| T62.6.3 | 该覆盖持久化到 PostgreSQL `session_agents.config` |

### T62.7：`disabled` 移除内置 Agent

| 用例 | 验证点 |
|---|---|
| T62.7.1–T62.7.2 | `disabled: true` 后 `plan` 不再出现在有效列表 |
| T62.7.3–T62.7.4 | `DELETE /agents` 清空覆盖后 `plan` 回到列表 |

### T62.8–T62.10：隐藏 Agent 的列表与选择行为

**这是文档与实现的差异点，用例 pin 的是当前实现的真实契约。**

| 用例 | 验证点 |
|---|---|
| T62.8.1 | `hidden` 内置 Agent **仍出现在** `GET /agents` 有效列表 |
| T62.8.2 | `POST /agent` 接受 `title`/`compaction`/`summary` 并写入 Session——**当前实现不做保留名校验** |
| T62.9.1 | 选择 primary Agent 不改变 Session 已保存的模型（对应文档 Model 章节的分离存储） |
| T62.10.1 | `hidden` 自定义 Agent 保留在列表且 `hidden=true` |

> 文档原文称隐藏的 `compaction`/`title`/`summary` "cannot be selected directly"，但当前 `POST /api/session/:id/agent`
> 对这三个 ID 一律返回 204。文档表述与实现不符，已记入
> [`AGENT-DOC-COVERAGE-GAP.md`](./AGENT-DOC-COVERAGE-GAP.md)。隐藏语义目前只体现在 subagent 工具目录过滤
> （`mode !== "primary" && !hidden`），该过滤没有对应 HTTP 接口，由 Core 单测覆盖。

## 三、本轮执行记录

**2026-09-29**：`opencode-saas-test` + 本地 PostgreSQL。**45 项全部通过**。

| 脚本 | 结果 |
|---|---|
| `builtin-agents-v2.mjs` | 45 PASS / 0 FAIL |

覆盖矩阵：

| 验收面 | 证据 | 状态 |
|---|---|---|
| 7 个内置 Agent 的 mode / hidden / 名称 | T62.1 | 覆盖 |
| 无 `scout`、无多余内置 | T62.2 | 覆盖 |
| `general` 的 subagent deny | T62.3 | 覆盖 |
| `explore` 只读、`build` 敏感文件 ask | T62.4–T62.5 | 覆盖 |
| 覆盖内置为追加语义 + PG 持久化 | T62.6 | 覆盖 |
| `disabled` 移除内置与恢复 | T62.7 | 覆盖 |
| 隐藏 Agent 的列表/选择实际行为 | T62.8 | 覆盖（与文档不符，已记录） |
| 切 Agent 不改会话模型 | T62.9 | 覆盖 |
| hidden 自定义 Agent | T62.10 | 覆盖 |
| subagent 目录过滤掉 hidden | Core 单测 | 无 HTTP 接口，未做 E2E |
| `steps` 运行时行为 | — | 见 [`agent-runtime.md`](./agent-runtime.md) |

脚本：[`../scripts/builtin-agents-v2.mjs`](../scripts/builtin-agents-v2.mjs)。
