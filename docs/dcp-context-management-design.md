# DCP 上下文管理：调研与改造设计（缓存对齐视角）

> 状态：调研 + 设计稿（未实现）
> 目标：梳理内置 DCP（`packages/opencode/src/plugin/dcp`）与 Headroom 及业界主流上下文压缩策略的差异，给出让 DCP 在「折叠历史」与「provider 缓存对齐」之间取得平衡的改造路线。
> 范围：仅讨论上下文压缩/折叠与 KV-cache 前缀的关系，不涉及 DCP 的权限、命令、sub-agent 等外围功能。

---

## 0. TL;DR

- **问题本质**：DCP 的折叠是"中段删除 + 插入摘要"，KV-cache 是严格前缀命中，任何对已发送 token 的删除/移位都会让**折叠点之后整段**缓存失效；且 `decompress`/`recompress`/`sweep`/高频 nudge 提供了反复回改路径，缓存可能永不收敛。
- **业界结论**：没有产品真正解决"中段折叠保缓存"，主流做法是绕开——折叠一次性、低频、**收敛到头部冻结区且不再回改**（Claude Code auto-compact、Copilot compaction 均为摘要替换历史后重开会话/不再动旧字节的形态）。
- **社区研究结论（更关键）**：JetBrains 2025 SWE-bench 实测 **masking（遮蔽旧观测、保留动作）往往比 LLM 摘要更高分且更便宜**，摘要会拉长 agent 轨迹 13–15%；摘要只该用于真正复杂的结构状态。
- **改造建议（按改动量排序）**：
  1. R0（不改代码）：抬高阈值、低频批式折叠、约束 `sweep`/`decompress`。
  2. R1：让 `prune`（已是 masking 形态）成为默认主力，`compress` 摘要退居兜底。
  3. R2：把折叠收敛为**头部冻结区单调推进**（压缩点只前进不回改）。
  4. R3：在冻结区边界打 cache 断点（`provider/transform.ts` 的 `applyCaching`）。
  5. R4：折叠后自动重读最近修改文件 + 结构化 handoff（intent/changes/decisions/next）。
  6. R5：`decompress` 从"还原原文"降级为"只读 checkpoint 回看"，杜绝回改已冻结字节。

---

## 1. 背景与现状（基于代码核查）

### 1.1 DCP 的定位与接入

- 内置 vendored 副本 `@tarquinen/opencode-dcp`（AGPL-3.0），由 `Flag.OPENCODE_DCP_ENABLED`（`flag/flag.ts:37`）门控，在 `plugin/index.ts:90` 作为 internalPlugin 注册；与 npm 版的差异见 `plugin/dcp/index.ts:25-28`。
- 会话状态经 `storage` 桥接（`plugin/index.ts:144-158`）写入 PG `plugin/dcp/<sessionId>` 行，随会话删除清理（`server/routes/instance/httpapi/handlers/session.ts:313`）——SaaS 多实例共享 DCP 状态的前提已就绪。

### 1.2 DCP 的上下文管理动作（两层）

DCP 实际有两套机制，作用位置不同，影响缓存的方式也不同：

| 机制 | 位置 | 形式 | 缓存影响 |
|---|---|---|---|
| `prune` 族（`lib/messages/prune.ts`） | 单条消息内部 | 把过期/出错 tool 的 output/input **替换成短占位文案**（masking） | 小、离散；尾部近几轮被替换会小范围失效，头部稳定区无影响 |
| `compress` tool（`lib/compress/range.ts` / `message.ts`） | 整段消息 | 模型自己选 startId/endId 并写摘要，hook 把一段历史替换为 synthetic summary 块 | **大**：折叠点之后全部失效 |

`compress` 由**模型主动调用**：DCP 在接近 `compress.maxContextLimit` 时通过 nudge 提示模型去压。这是"护栏式 + 模型自主"的触发，不是系统按固定水位触发的确定性动作——见 `lib/hooks.ts` 的 `injectCompressNudges`。

### 1.3 为何是"缓存杀手"

设上次请求发了 `M1..M20`，本次把 `M5..M12` 折叠成 `S` 得到 `M1..M4, S, M13..M20`：

- 严格前缀命中要求从请求头开始的 token 序列一致；
- `S` 之后一切（含**内容未变**的 `M13..M20`）都因相对前缀变化而无法复用旧 KV；
- 若随后再次折叠/回改，缓存永远无法安定（decompress 甚至主动把已折叠段放回原文）。

opencode 的缓存策略（`provider/transform.ts:383` `applyCaching`）只给 system 前 2 条 + 末尾 2 条打 `cache_control: ephemeral`，对中段历史本就"不指望命中"——折叠一次实际是把命中区从"system + 尾部"退化到仅"system"。

---

## 2. 调研 A：Headroom vs DCP（接入点与压缩范式）

Headroom（headroomlabs-ai/headroom）是独立的上下文压缩基础设施；对 opencode 的接入是 transport 层（`headroom-opencode` 插件 monkey-patch fetch/http，或 `wrap opencode` 把 provider 指到本地 proxy `/v1`）。

| | Headroom | DCP |
|---|---|---|
| 运行位置 | opencode **外**（proxy / 库 / transport 拦截） | opencode **内**（消息 hook） |
| 压缩主体 | 本地确定性算法 + 小模型，按内容类型路由 | LLM 自己写摘要 |
| 作用单元 | content 内部字节块（JSON/log/代码/AST），**结构不变** | 整段消息 → 一个 summary 块，**结构改变** |
| 保真 | 字节级无损 + CCR 可逆（原件本地存、`retrieve` 取回） | 语义有损，靠 protectedTools/patterns/tags 原文缝进摘要防丢 |
| 缓存取向 | **第一公民**：CacheAligner + live-zone，冻结前缀字节不变只压新增 | 无对齐设计，折叠天然打断前缀 |
| 触发 | 每请求透明、毫秒级 | nudge/prune 护栏 + 模型主动 compress |

结论：两者**不是同构替代品**。DCP=上下文"折叠"（有损、改结构）；Headroom=上下文"瘦身"（无损、保结构、缓存友好）。可叠加：DCP 折完的 prose summary 在 Headroom 眼里几乎无冗余可压，不冲突；但 DCP 的折叠会周期性清零 Headroom 的缓存收益，省钱不能简单相加。

---

## 3. 调研 B：业界官方策略（Claude Code / Codex / Copilot）

| | Claude Code | Codex | Copilot CLI |
|---|---|---|---|
| 触发 | auto-compact 近上限 + 手动 `/compact` | 自动 + `/compact`（社区抱怨过频） | **~80% 后台折叠**，留 buffer；95% 兜底暂停等待 |
| 产物 | 结构化 summary（示意 ~12% 原体积） | handoff summary：progress/decisions/constraints/next/critical data | 同款 structured summary |
| 折叠后保留 | **自动重读 ≤5 个最近修改文件 + 重注入用过的 skills/匹配 rules**；startup 内容在历史外不受影响 | agent 指令 + 最近轮；codex 模型走服务端加密 `compact()` | 原始 user 指令 + plans/todos 现状 + 折叠期间新消息 |
| 可逆性 | 不还原原文 | 不还原 | **Checkpoint**：编号摘要文件可 `session checkpoints <n>` 回看，明确不可撤销 |

可借鉴点：

1. **结构化 handoff 骨架**（三家收敛到同一字段集）——降低摘要质量方差。
2. **"重读磁盘"补偿摘要丢失**（Claude Code）——compact 后重读最近修改文件，关键工作内容不依赖模型记得住。
3. **后台并发折叠 + buffer**（Copilot）——80% 起后台做，不阻塞工具执行；而不是模型在正常轮次里同步调 compress。
4. **Checkpoint 只读回看，不做原文还原**（Copilot）——可审计又不回改前缀。

反面教训（Codex 社区）：折叠过频（"10%→15% 又压"）导致任务状态丢失、无法干活 → 频率与阈值比算法更重要，宁可阈值偏高一次压够。

---

## 4. 调研 C：社区与研究最佳实践

- **Context Rot**：模型退化远早于 token 上限（Chroma 2025：200K 窗口 50K 就明显退化；lost-in-the-middle 中段精度 -30%+）。上下文管理是主动工程而非撞墙急救。
- **两阶段触发**：~60–70% 早期预警（此时同步外部状态），~80% 切换/折叠；两级留缓冲，避免竞态；加 cooldown + 去重防反复触发。
- **Masking > Summarization（JetBrains 2025 SWE-bench 实测）**：遮蔽旧观测、保留动作，常**更高分且更便宜**（Qwen3-Coder-480B：+2.6% solve rate、便宜 52%）；LLM 摘要把轨迹拉长 13–15%（抹掉停止信号）。摘要只用于真正复杂的历史状态。
- **四字段摘要骨架**：`intent · changes made · decisions taken · next steps`（对 file paths/error messages 保留度最高）。
- **持久化 ≠ 交接**：外部文件桥（`claude-progress.txt`）每会话开头读/结尾写：state snapshot → narrative(3–5 句) → decision log → priority queue → warnings/gotchas。数据库存事实，交接讲叙事。
- **不持久化噪音**：raw tool 输出、中间搜索结果、临时文件按需再取，别进上下文。
- **缓存侧共识**（Bedrock/Anthropic 文档 + agent 工程博客一致）：稳定内容（system/tools/instructions）前置并打断点，易变内容放末尾；prompt cache 对长程 agent 负载可省 41–80% 成本（arxiv 2601.06007）。

---

## 5. 改造建议（对 opencode/DCP）

### R0 — 纯配置/使用层（不改代码，先落地）

- `compress.maxContextLimit` 抬高、`nudgeFrequency`/`iterationNudgeThreshold` 调大 → 折叠更晚、更少。
- 约束手动抖动：避免 `sweep`、`decompress`/`recompress` 高频使用。
- 预期：折叠从"每几轮一次"降到"每个长任务 1–2 次"，让单次前缀重建被后续轮次摊薄。

### R1 — masking 优先（把研究结论写进默认策略）

- 默认策略以 `prune`（tool 输出/错误占位替换 = masking）为**主力**，`compress` 摘要只对"真复杂/信息不可再得"的段触发。
- 调整 nudge 文案与优先级：让模型更倾向清理观测而非折叠推理。

### R2 — 折叠收敛为头部冻结区单调推进（核心改造）

现状问题：compress 可作用于任意中段、且可被 decompress/recompress 回改。目标状态：

- 已折叠的 summary 块固定堆在消息序列**最前**（紧跟 system/startup）；
- 压缩点只允许取"冻结区末尾的下一个未压缩段"，**单向从旧向新推进**；
- 一旦进入冻结区，字节**永不回改**；summary 用 `blockId:anchorMessageId` 确定性 seed（`lib/messages/utils.ts` 已具备）保证跨请求字节稳定。

效果：每次折叠只改变上一次请求尾部的一小段；折叠完成后整段 `system → 冻结区 → 新摘要` 成为稳定前缀，从单点重建快速恢复高命中。这等价于把 Headroom 的 live-zone 思想搬进 DCP。

涉及改动：DCP 状态机（`lib/state/state.ts` + `syncCompressionBlocks`）增加"冻结区游标"约束；`resolveRanges` 限制可折叠范围。

### R3 — 在冻结区边界打 cache 断点（放大 R2 收益）

- `provider/transform.ts:383` `applyCaching` 目前只给 system 前 2 + 末尾 2 打点。
- 让 DCP 折叠区结束那条消息也带消息级 `providerOptions.anthropic.cacheControl = { type: "ephemeral" }`（Anthropic/Bedrock 支持；OpenAI 系为严格前缀自动缓存，只能靠 R2 的字节稳定）。
- 效果：冻结区断点之前字节未变 → 独立命中，每次折叠只需重算"新摘要 → 末尾"这段。

### R4 — 折叠后重读 + 结构化 handoff

- compress 成功后，系统**自动重读最近修改的 ≤N 个文件**（用 opencode 现有 read 能力与 tool 记录），把关键工作内容以"重读"而非"全塞进摘要"的方式带回。
- compress prompt 从自由 summary 改为四字段骨架：`intent / changes made / decisions taken / next steps`（对应 `lib/prompts/compress-*.ts`）。

### R5 — decompress 降级为只读 checkpoint

- 保留审计：每次折叠落一份编号 checkpoint（Copilot 式），可 `/dcp checkpoints <n>` 回看摘要内容；
- 移除/禁用"还原原文再放回上下文"路径——这是主动回改已冻结前缀的最大缓存杀手。

---

## 6. 决策点 / 开放问题

1. R2 与 R5 是激进改动（改 DCP 状态机语义），需评估与上游 npm 版 DCP 的偏离成本（本仓库是 vendored AGPL 副本，可接受 fork 化）。
2. SaaS 多实例共享 provider key 时，任一实例折叠会让同 key 所有实例下次请求缓存退化 → R2/R3 在共享 key 场景收益更大。
3. R4 的"重读最近文件"与现有 tool 权限、沙箱文件可达性（SaaS 远端沙箱）需对齐。
4. Headroom 叠加场景：本设计不与 Headroom 冲突，可并行；但省钱账需按"折叠重建"与"无损瘦身"分开计算，不可简单相加。

---

## 7. 参考来源

- 官方：Claude Code context-window / compaction docs（code.claude.com、platform.claude.com）；GitHub Copilot CLI context-management docs；OpenAI Responses compaction guide
- 逆向：Kangwook Lee《Investigating How Codex Context Compaction Works》(2026-03)
- 研究：Chroma Context Rot；JetBrains《Cutting Through the Noise》(2025-12)；Liu et al. lost-in-the-middle；arxiv 2601.06007（prompt caching for long-horizon agents）
- 工程：Anthropic《Effective harnesses for long-running agents》《Effective context engineering for AI agents》；DEV Community state-handoff 五层
