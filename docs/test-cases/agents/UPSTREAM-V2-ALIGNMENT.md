# upstream/2.0 对齐分析：Agent 文档缺陷 D1–D3

> 对照基准：`upstream/2.0`（`git@github.com:anomalyco/opencode.git`，`7a6ce05d09 2.0 exploration (#22335)`）。
> 本文分析 [`AGENT-DOC-COVERAGE-GAP.md`](./AGENT-DOC-COVERAGE-GAP.md) 中记录的 D1–D3，判定哪些需要改实现、哪些需要改文档。
> 本地实现基准：`feat/opencode-saas-2.0`（`9d86bde786`）。

## 结论速览

| 编号 | 文档表述 | upstream/2.0 行为 | 本地行为 | 处置 |
|---|---|---|---|---|
| **D1** | 改 `default_agent` 不影响已有 Session | Agent 快照在**每条 user message** 上 | `session.agent` 字段；为 null 时**执行时**重新解析 | 改文档（非缺陷） |
| **D2** | hidden `compaction`/`title`/`summary` "cannot be selected directly" | 允许直接选；仅 `default_agent` 校验 hidden 时 **throw** | 允许直接选；`default_agent` 校验时**静默回退** | **改实现：恢复 fail-fast** |
| **D3** | 末步「移除工具并要求文本总结」 | 追加提示为 assistant 消息，不设 `toolChoice` | 请求级 system 指令，不设 `toolChoice`，执行侧禁用工具 | system 指令避免伪造无 thinking 的 assistant 历史；在线验证通过 |

---

## D1：文档表述不准确，非实现缺陷

### upstream 的 agent 解析模型

upstream 的 Session **没有 `agent` 列**。Agent 绑定在**每条 user message** 上，创建消息时快照：

```ts
// upstream/2.0 packages/opencode/src/session/prompt.ts:921
const createUserMessage = Effect.fn("SessionPrompt.createUserMessage")(function* (input) {
  const agentName = input.agent || (yield* agents.defaultAgent())
  const ag = yield* agents.get(agentName)
  ...
})
```

执行时从最近一条 user message 取 agent（`prompt.ts:1391`：`agents.get(lastUser.agent)`）。
因此 upstream 语境下「changing this setting does not replace the agent stored on an existing session」
实际指的是**已创建消息上的 agent 不变**，新消息才用新默认值。

### 本地行为

本地 `session_v2` 有 `agent` 列（`SessionAgents.select` 写入），`packages/core/src/session/agents.ts`
在 `session.agent` 为空时由 `Agent.Service.resolve(undefined)` → `selectedDefault()` 解析。

### 差异与影响

| 场景 | upstream | 本地 | 影响 |
|---|---|---|---|
| 显式 `POST /agent` 后改 `default_agent` | 已创建消息不变 | `session.agent` 已存，不变 | **一致**（T63.4.1–T63.4.3） |
| 未选 Agent 的会话改 `default_agent` | 后续**新消息**用新默认 | **每次执行**都重新解析 | 语义接近，但解析时机不同 |

边缘差异：消息已入队（`delivery: "queue"`）但未执行时改 `default_agent`，upstream 用入队时的值，本地用执行时的值。影响极小。

### 处置

**改文档，不改实现。** 本地 `AGENTS.md` 已有的 Session 级语义是更贴合 SaaS 的设计（会话是持久化聚合，Agent 属于会话属性）。
需把文档中该句限定为「explicitly selected agent」，并补充「会话未选择 Agent 时，每次执行按当前 `default_agent` 解析」。

---

## D2：真正的对齐缺口在 `default_agent` 校验强度

### 先修正 gap 报告的判断

gap 报告原先把 D2 记为「文档说 hidden 不可选、实现却允许」。**核对 upstream 后该判断不成立**：

```ts
// upstream/2.0 packages/opencode/src/session/prompt.ts:1391
const agent = yield* agents.get(lastUser.agent)
if (!agent) {
  const available = (yield* agents.list()).filter((a) => !a.hidden).map((a) => a.name)
  const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
  throw new NamedError.Unknown({ message: `Agent not found: "${lastUser.agent}".${hint}` })
}
```

`agents.get()` 命中即通过，`hidden` **不参与拒绝判定**；`filter((a) => !a.hidden)` 只用于拼错误提示里的
`Available agents: ...` 文案。`prompt.ts` 中 5 处（580 / 721 / 919 / 1392 / 1607）语义相同。

**所以 upstream 同样允许直接选择并执行 hidden Agent。** 文档那句 "cannot be selected directly"
在 upstream 也没有强制实现，是一句**未兑现的承诺**。

### 实际差异：fail-fast vs 静默回退

唯一的 hidden 强制点在 `default_agent` 校验，且 upstream 是**抛错**：

```ts
// upstream/2.0 packages/opencode/src/agent/agent.ts:299-307
if (c.default_agent) {
  const agent = agents[c.default_agent]
  if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
  if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
  if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
  return agent.name
}
const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
if (!visible) throw new Error("no primary visible agent found")
return visible.name
```

upstream 为此有 5 个用例（`test/agent/agent.test.ts:595-680`），逐条断言抛错：
无 `default_agent` 时返回 build、指向 plan 生效、指向 `mode: all` 生效、指向 subagent 抛错、
指向 hidden 抛错、指向不存在抛错。

本地是**静默回退**：

```ts
// packages/core/src/agent.ts:92-104
const selectable = (agent) => (agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined)
const selectedDefault = () => {
  const data = state.get()
  const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
  if (configured) return configured
  const build = selectable(data.agents.get(ID.make("build")))
  if (build) return build
  for (const agent of data.agents.values()) { const f = selectable(agent); if (f) return f }
}
```

### 行为对比（实测）

| `default_agent` 指向 | upstream/2.0 | 修复前本地 | 修复后本地 | 本地用例 |
|---|---|---|---|---|
| 不存在 | **throw** | 回退到 `build` | **throw** `is not a known Agent` | Core `agent.test.ts` |
| `mode: subagent` | **throw** | 回退到 `build` | **throw** `runs as a subagent` | T63.2.1 |
| `hidden: true` | **throw** | 回退到 `build` | **throw** `is hidden` | T63.3.1 |
| 无该配置 | 第一个可见 primary（**无 build 特例**） | `build` 优先，再第一个可见 primary | 同左（保留） | Core `agent.test.ts` |

唯一保留的差异是未配置时的回退顺序：upstream 不给 `build` 特例，本地保持 `build` 优先，
这是本地文档已声明的既有契约，且比 upstream 更可预测。

### 实施记录（2026-09-30）

选定**方案 A**，已实施：

- `packages/core/src/agent.ts` — `selectedDefault()` 在配置了 `default_agent` 但目标不可用时抛错，
  仅未配置时走回退链。
- `packages/core/test/agent.test.ts` — 新增 `default agent selection` 分组 6 条用例：
  未配置回退 `build`、primary 生效、`mode: all` 生效、不存在 / subagent / hidden 三种失败。

Core 回归：`agent.test.ts` 16 pass / 0 fail，`session-runner.test.ts` 214 pass / 0 fail，
`session-step.test.ts` 3 pass / 0 fail，typecheck 通过。

---

## D3：已修复的末步历史消息协议错误

### upstream 的末步处理：追加提示，不动 toolChoice

```ts
// upstream/2.0 packages/opencode/src/session/prompt.ts:1398-1399, 1485
const maxSteps = agent.steps ?? Infinity
const isLastStep = step >= maxSteps
...
messages: [...modelMsgs, ...(isLastStep ? [{ role: "assistant", content: MAX_STEPS }] : [])],
...
toolChoice: format.type === "json_schema" ? "required" : undefined,
```

`max-steps.txt` 的内容要求模型停止工具调用、输出文本总结；末步把它作为 assistant 消息追加。upstream 当前源码仍把解析出的工具定义传入请求，因此工具禁用主要依赖提示指令。

### 原本地实现：末步额外设了 `toolChoice: "none"`

```ts
// packages/core/src/session/runner/llm.ts:249-253
messages: stepLimitReached ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)] : transcript.messages,
toolChoice: structuredSchema ? "required" : stepLimitReached ? "none" : undefined,
```

并在执行侧加了第二道守卫（`packages/core/src/session/runner/step.ts:89`）：

```ts
return new Tool.Error({ message: "Tools are disabled after the maximum agent steps" })
```

`toolChoice: "none"` 在 Anthropic Messages 协议下降级为 `tool_choice: {type:"none"}`，
**工具定义仍照常发送**（`packages/ai/src/protocols/anthropic-messages.ts:544`），
请求审计与在线对照证明，单独去除 `toolChoice: "none"` 仍会复现错误；它不是根因。

### 实测根因与修复（T63.7.2）

```
step 1,2  → 工具调用成功，历史含模型生成的 reasoning/signature
step 3（末步）→ 追加只有普通文本的 synthetic assistant 消息
             → DeepSeek Anthropic 兼容端点返回 thinking passback 400
移除 toolChoice: "none" 后仍失败，证明 toolChoice 不是根因。
```

本地方案保留 upstream 的步数判定和提示内容，但把 `MAX_STEPS_SYSTEM_PROMPT` 作为仅当前请求生效的 system 指令追加，避免把非模型生成内容伪装成 assistant thinking 轮次或合成 user 回合。普通末步请求不再暴露工具定义，降低模型继续发工具调用、得不到总结的概率；`toolsDisabled` 仍作为执行侧兜底。结构化输出场景保留专用输出工具并遵循 schema，不追加纯文本总结提示。

在线验证：本地最终方案镜像 + 本地 PG + `Yd-DeepSeek/deepseek-v4-flash` 的 T63.7.2 通过；T63.7.1、T63.7.3 及 T63.1–T63.6 同轮通过。`session-runner.test.ts` 与 `session-step.test.ts` 共 217 项通过。

验证过程发现，仅把提示移到 system 并不能稳定保证总结：一轮在线执行成功但末轮无文本，随后重跑通过。因此最终方案同时不向普通末步请求暴露工具定义；`toolsDisabled` 保持为执行侧兜底。最终完整 E2E 通过。

---

## 需要修改的文档

| 位置 | 现状 | 建议 |
|---|---|---|
| Selection「Changing this setting does not replace…」 | 未区分是否显式选择 | 限定为显式选择的 Session；补充未选择时按当前 `default_agent` 解析 |
| Builtins「cannot be selected directly」 | upstream 与本地都未强制 | 改写为「`hidden` 只影响列表展示与 subagent 目录；`default_agent` 指向 hidden Agent 时报错」 |
| Steps「removes tools」 | upstream 源码会发送末步工具定义；本地最终方案在普通末步隐藏工具定义 | 保留文档中的纯文本总结目标；本地采用更强的末步约束 |

## 代码处置记录

| 文件 | 改动 | 阻塞于 |
|---|---|---|
| `packages/core/src/session/runner/llm.ts` | 末步不设 `toolChoice`；request-scoped system part；普通工具不进入末步请求；执行侧禁用工具 | 已实现并在线验证 |
| `packages/core/src/agent.ts` | `default_agent` 校验改为 fail-fast | 已实现并在线验证 |
