# Agents 文档 vs 测试用例覆盖差距分析

对照文档：https://opencode.ai/v2/docs/agents/
对照范围：`docs/test-cases/agents/`（`session-agents.md`、`session-agent-permissions.md`、`compose-agent.md`、`team-agent.md`、`session-exec-log.md`）及其脚本 `docs/test-cases/scripts/*.mjs`

代码事实依据：
- `packages/schema/src/config/agent.ts:16` — `mode: Literals(["subagent","primary","all"])`
- `packages/core/src/agent.ts:92-104` — `selectable()` / `selectedDefault()` 回退链
- `packages/core/src/plugin/agent.ts:94-153` — 内置 build/plan/general/explore/compaction/title/summary 的 mode/hidden/permissions
- `packages/core/src/config/plugin/agent.ts:21-26,88-126,177-212` — 发现目录、合并、Markdown 解码

## 结论

Session Agent 的 CRUD、权限规则、subagent 编排、沙箱共享、PG 持久化覆盖较好。
**文档中的「Selection」「Modes(all)」「Builtins」「Locations」「Merging 细节」以及 `steps`/`hidden`/`disabled` 的运行时行为基本没有用例。**

---

## 补充执行结果（2026-09-29）

针对下方 P0 清单新增了 3 个文档与 3 个脚本，已在 `opencode-saas-test` + 本地 PostgreSQL
+ `Yd-DeepSeek/deepseek-v4-flash` 实跑：

| 新增文件 | 覆盖编号 | 实测 |
|---|---|---|
| [`config-agents.md`](./config-agents.md) + `config-agents-v2.mjs` | T61（P0-1、5、12–19、21） | **26 PASS / 0 FAIL** |
| [`builtin-agents.md`](./builtin-agents.md) + `builtin-agents-v2.mjs` | T62（P0-6–11、22、23） | **45 PASS / 0 FAIL** |
| [`agent-runtime.md`](./agent-runtime.md) + `agent-runtime-v2.mjs` | T63（P0-1–5、20、24） | **2026-09-30：25 功能断言 PASS / 0 FAIL，2 清理断言 PASS** |

### 实测确认的关键结论

- SaaS 模式下**沙箱 `/workspace` 与服务端进程文件系统分离**。沙箱内的 `opencode.jsonc` 与 `agents/`
  （无 `.opencode` 前缀）**不参与**配置加载；Agent 定义只有两个来源：服务端 `~/.config/opencode`
  （`source=global`）与沙箱 `/workspace/.opencode/agents/*.md`（`source=sandbox`）。P0-13 因此在 SaaS 下无接口可测。
- `default_agent` 回退链实测成立：指向 `mode: subagent` 或 `hidden` 的 Agent 均回退到 `build`（T63.2、T63.3）。
- 沙箱 Markdown 覆盖 Session Agent 为**字段级**合并，未声明字段保留原值（T61.13.3）。
- 全局 `agents/<name>.md` 的加载晚于同目录 `opencode.jsonc`，故 Markdown 中的 `request` 键冲突时胜出（T61.7.2）。

### 实测发现的文档缺陷

> D1–D3 的 upstream/2.0 对齐分析见 [`UPSTREAM-V2-ALIGNMENT.md`](./UPSTREAM-V2-ALIGNMENT.md)。
> 该分析修正了本表 D2 的初步判断：upstream 同样允许直接选择并执行 hidden Agent。

| 编号 | 文档表述 | 实测行为 | 证据 | 性质 |
|---|---|---|---|---|
| D1 | Selection：「Changing `default_agent` does not replace the agent stored on an existing session」 | 仅对**显式调用过 `POST /agent`** 的会话成立；未选 Agent 的会话每次执行重新解析默认值，会跟随新 `default_agent` | T63.4.1–T63.4.5 | 文档表述不准确，非实现缺陷 |
| D2 | Builtins：「Hidden `compaction`/`title`/`summary` … cannot be selected directly」 | 本地与 upstream **均允许**直接选择并执行；强制点只在 `default_agent` 校验，且 upstream **throw**、本地**静默回退** | T62.8.1–T62.8.2、T63.2.1、T63.3.1 | 实现对齐缺口（待产品决策） |
| D3 | Steps：「On the final step, OpenCode removes tools and asks the model to summarize in text」 | 曾报 provider thinking passback 错误；末步 synthetic assistant 指令作为历史回放会触发错误。现改为请求级 system 指令并在普通末步请求中隐藏工具 | T63.7.2 | 隔离 Docker + PG + DeepSeek 在线通过 |

### 实测发现的实现边界（非文档缺陷）

| 编号 | 说明 | 证据 |
|---|---|---|
| B1 | **子会话不继承 Session 级 Agent 覆盖**（与 fork 同理）。通过 `POST /agents` 定义的 subagent 被调度时必然失败（`Agent not found`）；需要在子会话可用的 subagent 必须来自沙箱 Markdown 或全局配置 | T63.6.1 |
| B2 | `hidden` 不影响 `GET /agents` 有效列表；过滤只发生在 subagent 工具描述生成处（`packages/core/src/tool/plugin/subagent.ts:281-299`） | T62.8.1、T62.10.1 |

### 仍未覆盖（保持缺口）

| 编号 | 项 | 原因 |
|---|---|---|
| P0-12 | 全局 `~/.config/opencode/agents/<name>.md` | **已覆盖**（T61.1、T61.2） |
| P0-24 | subagent 继承父模型 vs 自身模型 | 需在 assistant 消息中区分模型归属，当前 runtime 脚本只断言 `agent` 字段，未断言 `model` 字段差异 |
| P0-26 | `request` headers/body 是否随模型请求下发 | 文档已声明 V2 runner 不下发；需 provider 侧记录才能证伪，两侧均未断言 |
| P0-27 | `POST /agent` 错误路径 | **实测无校验**：`not-exist-agent`、`general`（subagent 模式）、`title` 均返回 204 并写入 Session；文档未定义该契约，无法编写期望 |
| — | 沙箱重建后的 Agent 状态 | 与 volume 持久化策略绑定，尚未定义期望 |

### 关于 `session-exec-log.md`

该文档仍是 V1 curl 脚本（`/session/:id/agents/create`、`permission` 对象语法、`temperature`），
并自带与 D2 矛盾的保留名拒绝预期。建议重写为 V2 或移入 `archive/`，详见下方 P2。

---

## P0 — 覆盖状态总览

下表为原始缺口清单。**已覆盖**项由 T61/T62/T63 覆盖，编号对应关系见各新增文档。
未覆盖项的原因见上文「仍未覆盖」小节。

| # | 文档章节 / 契约 | 现状 | 覆盖编号 |
|---|---|---|---|
| P0-1 | **Selection**：`default_agent` 配置 | **已覆盖** | T63.1 |
| P0-2 | **Selection 回退链**：configured → `build` → 第一个 visible primary-capable | **已覆盖** | T63.2、T63.3 |
| P0-3 | **Selection**：改 `default_agent` 不影响既有 Session | **已覆盖**（实测发现文档缺陷 D1） | T63.4 |
| P0-4 | **Modes**：`mode: all` | **已覆盖** | T61.10、T63.5 |
| P0-5 | **Modes**：省略 `mode` 默认 `primary` | **已覆盖** | T61.9 |
| P0-6 | **Builtins**：7 个内置 Agent 的 mode / 可见性 | **已覆盖** | T62.1 |
| P0-7 | **Builtins**：`general` 不能起 subagent | **已覆盖** | T62.3 |
| P0-8 | **Builtins**：`explore` 只读约束 | **已覆盖** | T62.4 |
| P0-9 | **Builtins**：覆盖内置为追加语义 | **已覆盖** | T62.6 |
| P0-10 | **Builtins**：无 `scout` | **已覆盖** | T62.2 |
| P0-11 | **Builtins 隐藏 Agent**："cannot be selected directly" | **已覆盖**（实测与文档冲突，见 D2） | T62.8 |
| P0-12 | **Locations**：全局 `~/.config/opencode/agents/<name>.md` | **已覆盖** | T61.1 |
| P0-13 | **Locations**：从当前目录向上逐级发现 `.opencode` | 未覆盖——SaaS 下沙箱 FS 与配置 FS 分离，无接口 | — |
| P0-14 | **Locations**：嵌套路径 → Agent ID `team/reviewer` | **已覆盖** | T61.2 |
| P0-15 | **Formats**：JSONC `agents` 块 | **已覆盖** | T61.6 |
| P0-16 | **Formats**：Markdown body 覆盖 frontmatter `system` | **已覆盖** | T61.3 |
| P0-17 | **Merging**："request maps merge by key" | **已覆盖** | T61.7 |
| P0-18 | **Merging**：全局 `permissions` 先于 Agent 规则 | **已覆盖** | T61.8 |
| P0-19 | **Merging**：沙箱优先于 Session，字段级覆盖 | **已覆盖** | T61.13 |
| P0-20 | **`steps` 运行时行为** | **部分覆盖**：上限截断与额度重置通过，末步文本总结为缺陷（D3） | T63.7 |
| P0-21 | **`steps` 正整数校验** | **已覆盖** | T61.12 |
| P0-22 | **`hidden` 运行时行为** | **已覆盖**（实测：不影响 API 列表，见 B2） | T62.8、T62.10 |
| P0-23 | **`disabled` 运行时行为** | **已覆盖** | T62.7 |
| P0-24 | **Model**：subagent 继承父模型 vs 自身模型 | 未覆盖——需在 assistant 消息中区分模型归属 | — |
| P0-25 | **Model**：选 Agent 不改会话模型 | **已覆盖** | T62.9 |
| P0-26 | **`request` Callout**：V2 runner 不下发 | 未覆盖——需 provider 侧记录证伪 | — |
| P0-27 | **Selection 错误路径**：`POST /agent` 无效 ID | 未覆盖——实测该接口无校验，文档未定义契约 | — |

## P1 — 文档已声明为缺口，但未排期

| # | 项 | 出处 |
|---|---|---|
| P1-1 | Agent 专属模型路由在线 E2E（切换 Agent 后核对实际模型） | `session-agents.md:100,138` |
| P1-2 | title generation override 真实执行 | `session-agents.md:94,138` |
| P1-3 | `system` 替换 provider 基础提示词 + 仍叠加项目指令/skills | 文档 Options/System |
| P1-4 | 沙箱重建后 Agent/VCS 状态（需按 volume 策略重新定义） | `session-agents.md:106-108` |

## P2 — 一致性问题

1. **`session-exec-log.md` 仍是 V1 脚本**：curl + `/session` + `/agents/create` + `permission` 对象语法 + `temperature`，
   与同目录其余 V2 文档冲突，且自带与缺陷 D2 相矛盾的保留名拒绝预期。建议：重写为 V2，或移入 `archive/`。
2. **目录内缺少索引**：无 README 说明各文档边界（exec-log 是审计，与 Agent 契约无关）。
3. **编号体系不连续**：T16 / T17 / T26 / T42 / T52 / T61 / T62 / T63 并存，来源不明。

---

## 新增文件清单

| 文件 | 用途 |
|---|---|
| [`config-agents.md`](./config-agents.md) | T61：配置发现、Formats、Merging、mode/steps 校验 |
| [`builtin-agents.md`](./builtin-agents.md) | T62：内置 Agent 矩阵、默认权限、hidden/disabled 语义 |
| [`agent-runtime.md`](./agent-runtime.md) | T63：`default_agent`、`mode: all`、subagent 委派、`steps` |
| `../scripts/config-agents-v2.mjs` | T61 执行脚本 |
| `../scripts/builtin-agents-v2.mjs` | T62 执行脚本 |
| `../scripts/agent-runtime-v2.mjs` | T63 执行脚本 |

均遵循本目录既有约定：V2 路由、真实模型断言 SSE 终态、PG 核验、`SKIP` 不记通过、
隔离容器配置改动必还原。
