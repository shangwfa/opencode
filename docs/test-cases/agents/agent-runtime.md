# Agent 运行时行为（V2）

> 对照官方文档 <https://opencode.ai/v2/docs/agents/> 的 Selection / Modes / Steps 章节。
> 本文档全部用例**需要真实模型执行**，断言 SSE 过程、持久化消息与子 Session 归属，不只看 HTTP 状态码。

## 一、运行环境

```bash
source docs/test-cases/test-env.sh 3
export CONTAINER=opencode-saas-test   # 脚本会改写容器全局 default_agent，结束时还原
node docs/test-cases/scripts/agent-runtime-v2.mjs
```

前置条件：容器已配置可用模型（`MODEL` 环境变量），沙箱服务可用。未设置 `CONTAINER` 时脚本输出 `SKIP`。
模型不可用时记为环境阻塞，**不得把 provider error 或超时记作通过**。

脚本有两类结论：普通 `PASS` 为符合文档；`FAIL` 为**与文档不符的实测缺陷**，会汇总输出并以退出码 1 结束，用于回归跟踪。

## 二、用例

### T63.1：`default_agent` 决定未选择 Agent 的会话

新建会话（`GET /session/:id` 的 `agent` 为 `undefined`）直接发消息。

| 用例 | 验证点 |
|---|---|
| T63.1.1 | 新建会话未显式选择 Agent |
| T63.1.2 | 持久化 assistant 消息的 `agent` 等于 `default_agent` |
| T63.1.3 | 该 Agent 的 system prompt 生效 |

### T63.2–T63.3：`default_agent` 校验为 fail-fast

`default_agent` 是显式配置，指向不可用 Agent 属于配置错误，执行时**直接失败**而不是静默回退。
判定在 `packages/core/src/agent.ts` 的 `selectedDefault()`：排除 `mode === "subagent"` 与 `hidden`，
且不存在时也报错。**只有未配置 `default_agent` 时才走回退链**（`build` 优先，再第一个可见 primary）。

| 用例 | 验证点 |
|---|---|
| T63.2.1 | `default_agent` 指向 `mode: subagent` 的 Agent → 执行失败并说明 `runs as a subagent` |
| T63.3.1 | `default_agent` 指向 `hidden: true` 的 Agent → 执行失败并说明 `is hidden` |

> 该行为于 2026-09-30 从「静默回退到 `build`」改为 fail-fast，与 upstream/2.0 对齐，
> 详见 [`UPSTREAM-V2-ALIGNMENT.md`](./UPSTREAM-V2-ALIGNMENT.md) 的 D2 章节。

### T63.4：修改 `default_agent` 的影响范围

| 用例 | 验证点 |
|---|---|
| T63.4.1–T63.4.3 | **显式调用过 `POST /agent`** 的会话保存了 Agent ID，`default_agent` 变更后仍使用原 Agent，system prompt 不受影响 |
| T63.4.4–T63.4.5 | **未显式选择**的会话每次执行都重新解析默认值，改动后使用新 `default_agent` |

> 文档原文「Changing this setting does not replace the agent stored on an existing session」只对显式保存过
> Agent 的会话成立；未选 Agent 的会话本身不存储 ID。T63.4.4 pin 的是实现行为，已记入 gap 报告。

### T63.5：`mode: all` 同时支持 primary 与 subagent

| 用例 | 验证点 |
|---|---|
| T63.5.1–T63.5.2 | `mode: all` Agent 可被 `POST /agent` 选为会话 primary 并执行，system prompt 生效 |
| T63.5.3 | 沙箱 Markdown 定义的 `mode: all` 子 Agent 被 agents refresh 发现 |
| T63.5.4 | primary Agent 发起 `subagent` 工具调用 |
| T63.5.5–T63.5.6 | 子 Agent 在**独立子 Session** 中执行，其消息含自身 system prompt 标记 |
| T63.5.7 | 子 Session 的 `parentID` 指向委派方会话 |

> 子 Agent 的消息**不进入父会话**的 message 列表，必须从父会话工具 part 的 `state.metadata.sessionID`
> 取出子 Session ID 后单独查询。这与 [`compose-agent.md`](./compose-agent.md) 的断言方式一致。

### T63.6：Session Agent 定义的 subagent 在子会话中不可解析

子会话不继承 Session 级 Agent 覆盖（与 fork 同理，见 [`session-agents.md`](./session-agents.md)）。
因此通过 `POST /agents` 定义的 subagent 被调度时必然失败。

| 用例 | 验证点 |
|---|---|
| T63.6.1 | `session` 来源的 subagent 调用返回工具错误（`Agent not found`），未产生子 Agent 消息 |

> **这是当前实现边界，不是文档承诺**。需要在子会话中可用的 subagent 必须来自沙箱 Markdown
> （`.opencode/agents/*.md`）或全局配置。已有用例中 `compose-agent.md` 与 `team-agent.md` 都遵循了这一约束。

### T63.7：`steps` 上限与额度重置

配置 `steps: 2`，提示词要求连续执行 4 条 bash 命令，并连续发送两轮。

| 用例 | 验证点 | 本轮结果 |
|---|---|---|
| T63.7.1 | 执行恰好 2 步，不因提示词要求继续调用工具而扩展 | **通过**（实测 `steps=2`） |
| T63.7.2 | 达到上限后收敛为文本总结 | **通过**（隔离 Docker + PG + DeepSeek 实测） |
| T63.7.3 | 新用户输入重置额度，第二轮重新获得 2 步 | **通过**（实测 `steps=2`） |

**T63.7.2 缺陷与修复**：最初怀疑末步 `toolChoice: "none"` 导致 provider 拒绝，但移除该选项后错误仍复现，因此该判断被在线测试证伪。审计到的失败请求包含一个末步 synthetic assistant 消息：

```text
provider.invalid-request (HTTP 400)
The `content[].thinking` in the thinking mode must be passed back to the API.
```

实际历史中除原模型生成、带 reasoning/signature 的 assistant 工具调用外，还追加了只有普通文本的 `MAXIMUM STEPS REACHED` assistant 消息。该消息不是模型生成的 thinking 轮次，却被当作 assistant 历史回放；DeepSeek Anthropic 兼容端点因此返回上述 thinking passback 错误。

**修复方式**（2026-09-30）：末步不设置 `toolChoice`，将与 upstream 相同的总结要求作为仅本次请求生效的 system 指令追加；普通工具不再出现在末步请求中，`toolsDisabled` 保留为执行侧兜底。结构化输出请求保留专用输出工具，并遵循其 schema 格式。隔离 Docker + PG + DeepSeek 在线回归中 T63.7.2 通过。

## 三、本轮执行记录

**2026-09-30**：隔离 Docker 容器 `opencode-saas-test` + 本地 PostgreSQL `opencode-v2-up`，模型 `Yd-DeepSeek/deepseek-v4-flash`。

| 项 | 结果 |
|---|---|
| T63.1–T63.6 | 22 PASS / 0 FAIL |
| T63.7.1–T63.7.3 | 3 PASS / 0 FAIL |
| 清理断言 | 2 PASS（`default_agent` 与全局 agents 定义已还原） |

25 项功能断言、2 项清理断言全部通过；测试脚本确认 `default_agent` 与测试用全局 Agent 定义均已清理还原。

覆盖矩阵：

| 验收面 | 证据 | 状态 |
|---|---|---|
| `default_agent` 生效与 system prompt | T63.1 | 覆盖 |
| 回退到 `build`（subagent 模式 / hidden） | T63.2–T63.3 | 覆盖 |
| 改 `default_agent` 对既有会话的影响 | T63.4 | 覆盖（含与文档不符的场景） |
| `mode: all` 作 primary | T63.5.1–T63.5.2 | 覆盖 |
| `mode: all` 作 subagent、子 Session 归属 | T63.5.3–T63.5.7 | 覆盖 |
| Session 来源 subagent 的边界 | T63.6 | 覆盖（实现边界） |
| `steps` 上限与额度重置 | T63.7.1、T63.7.3 | 覆盖 |
| `steps` 末步文本总结 | T63.7.2 | **通过** |
| Agent 自定义模型路由的实际生效 | — | 未覆盖，见 gap 报告 |
| subagent 继承父会话模型 vs 使用自身模型 | — | 未覆盖，见 gap 报告 |
| `request` headers/body 是否随模型请求下发 | — | 未覆盖，文档已声明当前不下发 |

脚本：[`../scripts/agent-runtime-v2.mjs`](../scripts/agent-runtime-v2.mjs)。
