# Agent 记忆与自进化：2026 流行方案综述

> 围绕「项目维度自进化记忆」主题的周边方案梳理（与 `app-memory-rsi.md` 配套阅读）。2026 年该领域分成五个流派：记忆基础设施、程序记忆/技能库、知识库外置、记忆操作系统、环境密集型 RSI。本文记录各派代表、核心思路，以及对本项目的对照结论与可借鉴点。

## 一、记忆基础设施派（API 服务型）

最商业化的一派，把「记忆」做成独立服务/中间件，应用方经 API 挂接。

| 方案 | 核心思路 | 特点与定位 |
| ---- | ---- | ---- |
| [Mem0](https://mem0.ai) | 记忆即服务：add/search/update/delete 四操作，LLM 从对话中自动抽取事实记忆并更新 | 事实标准之一；自建 LoCoMo 基准（对比报告见 [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)）；主攻「用户偏好/事实」型记忆；强调低 footprint（vs Zep 每 600k tokens/会话） |
| [Zep](https://www.getzep.com) / Graphiti | 时序知识图谱（temporal knowledge graph），事实带生效/失效时间边 | 主打对话历史长时记忆，图检索；适合"谁说过什么、何时有效"类查询 |
| [Letta](https://www.letta.com)（原 MemGPT） | self-editing memory：agent 自己管理主上下文/外部存储的分页 | 更像有状态 agent 平台而非记忆 API；其博客 [Benchmarking AI Agent Memory](https://www.letta.com/blog/benchmarking-ai-agent-memory/) 显示"纯文件系统存对话史即可拿 LoCoMo 74%"——侧面说明纯对话记忆无玄学 |
| LangMem（LangChain） | 记忆组件库，绑定 LangGraph 生态 | 生态集成友好 |

**共同赌注**：语义/情景记忆（用户是谁、聊过什么、偏好什么）。通用对话助手场景强。
**共同短板（对本项目）**：不验证记忆真伪（LLM 自评入库），无环境变更感知（全靠向量相似度检索）。

## 二、程序记忆/技能库派（与 RSI 最同源）

把「经验」沉淀为**可复用的过程性知识**（代码/workflow/例程），冻结模型参数，能力随库增长。

| 方案 | 核心思路 |
| ---- | ---- |
| [Voyager](https://arxiv.org/abs/2305.16291)（Minecraft） | 技能库=长期记忆：成功行为存成**可执行 JavaScript 代码**，检索+组合复用；RSIAgent 的 "code as policy" 与本方案的「可执行步骤级记忆」均为其直系后裔 |
| [Agent Workflow Memory (AWM)](https://openreview.net/forum?id=PfYg3eRrNi) | 从历史轨迹归纳**可复用 workflow** 注入后续任务；web/编码 agent 上涨分明显 |
| Reflexion | verbal self-reflection：失败后语言化反思存档重试——自反思经验学习的老祖宗 |
| ExpeL | 从多条轨迹中提炼 insights 集合，跨任务复用 |
| Skill Library RL 变体（如 [arXiv:2512.17102](https://arxiv.org/html/2512.17102v2)） | 技能库 + 强化学习结合的最新变体 |

本方案 `fact/causal/lesson` 三类条目本质属于这一派：沉淀的是过程性因果知识，不是对话摘要。

## 三、知识库外置派（Claude 系实践主流）

不搞独立记忆系统，就是**文件系统 + agent 自主读写整理**。

- **Anthropic memory tool + Skills**：`MEMORY.md` + 目录结构，agent 自己读/写/重组——与本仓库 AGENTS.md 的人工沉淀模式同构，差异只在「由 agent 自动维护」
- **Cookbook/Playbook 论**：冻结模型 + 沉淀可复用例程（"Your AI Agent Doesn't Need Retraining. It Needs a Cookbook."）
- **Eric Ma 三部曲（2026-01）**：[Part 1](https://ericmjl.github.io/blog/2026/1/17/how-to-build-self-improving-coding-agents-part-1/) AGENTS.md 作为 repo memory、[Part 2](https://ericmjl.github.io/blog/2026/1/18/how-to-build-self-improving-coding-agents-part-2/) skills 作为可复用 playbook、[Part 3](https://ericmjl.github.io/blog/2026/1/19/how-to-build-self-improving-coding-agents-part-3/) 运营模型。要点见下节

### Hermes Agent 源码精读：进程内学习闭环的工程范本

[Hermes Agent](https://github.com/NousResearch/hermes-agent)（Nous Research，Python）自我定位为「唯一内置 learning loop 的 agent」。无 RL、无外置流水线，闭环三件套全部在进程内：

**① `agent/background_review.py` —— 每轮后的提炼 fork**

每轮对话结束 fork 后台 review（可路由到便宜模型跑 digest：近期轮原文 + 旧轮摘要，省 3-5× 成本），回放会话决定记忆/技能写入。其 `_SKILL_REVIEW_PROMPT` 是极成熟的写入规范，两个 prompt 块是防毒化范本：

- `_LESSON_LAYER_BLOCK`（写什么）：pitfall = 可泛化规则 + 一句 WHY（机制）；**"同一教训学到两次 = 一条规则——入库前先搜库，强化而非追加"**；"修正就地处——不要在错误句子下追加 UPDATE: actually…"；read-before-write **机器硬门**（skill_manage 拒绝不新鲜读取就 patch 的写入）
- `_DO_NOT_CAPTURE_BLOCK`（不写什么，直击毒化模式）：环境依赖失败（缺 binary/未配置）不是 durable rule；**负面断言**（"X 工具坏了"）会硬化成 agent 自我引用数月的自拒；**未解决的失败严禁包装成"可靠工作流"**——"把一串未验证失败写成 validated guidance，未来会话会信任并重复"

**② `agent/curator.py` —— 周期整理（多数方案缺失的一环）**

interval + min_idle 触发的后台合并进程。目标形态："class-level umbrella + 少量 references/"，"几百个每会话一个的窄技能是库的失败而非特性"。合并三式：并入现有 umbrella / 新建 umbrella 后归档兄弟 / 纯归档。硬规则：**永不删除**（archive 是最大破坏动作，可恢复）；**禁止用 use_count 判断价值**（"use=0 不是价值的证据也不是删除的理由，新技能可能只是还没遇到触发场景"）；pinned / cron 引用的跳过；**dry-run 模式**——只产出报告，人批后实跑。

**③ 防护分层**

protected skills（bundled/hub/pinned/user-owned 对后台 agent 只读）→ archive-only → `write_approval` staging（`/skills diff` 人工 approve/reject）→ curator dry-run。另：MEMORY.md 字符硬上限（2,200），超限**报错让 agent 自己整理合并**而非静默丢弃；注入 system prompt 的是 session 开始时的 frozen snapshot（保 prefix cache）；跨会话兜底走 FTS5 session_search。

**与 App Memory 的对照**：提炼器 ↔ background_review；topic 聚合 ↔ umbrella 合并（我们被动覆盖、它主动整理）；沙箱复验 ↔ prompt 规范 + 人审（互补，见方案文档 §3）；字符上限自整理 ↔ topic 唯一 key（预算压力一个交给 agent、一个交给结构）。

### Eric Ma 三部曲精读：与 App Memory 的同构与互补

Eric Ma 的体系是**同一问题的「人工运营」版本**——改进不来自模型权重，而来自包裹 agent 的环境（repo memory + skills 两个杠杆）。这正是本方案的出发点；差别在于他把人放在循环里，我们把循环自动化。

**核心模型（Part 3 成熟度阶梯）**：

| 阶段 | 形态 | 本项目对应 |
| ---- | ---- | ---- |
| Stage 0 | Ad hoc prompting，重复解释不沉淀 | 通用 appId 会话现状 |
| Stage 1 | Repo-local memory（AGENTS.md：code map + local norms + guardrails） | AGENTS.md 已有 |
| Stage 2 | 跨 repo 重复的工作流 → 提升为全局个人 skill | `memory://` skill 机制已具备 |
| Stage 3 | 团队共享 skill（明确安装路径） | user_skill 表（`user-skill.ts`） |

**与我们方案逐点对照**：

| Eric Ma（人工） | App Memory（自动） |
| ---- | ---- |
| "我观察到 mismatch → 口头纠正 → agent 写进 AGENTS.md → 下次继承"（self-correction loop） | exec-repair 修复链路 + denied 聚类自动入队 → verifier 复验 → `verified` 条目注入 |
| 发现 code map 过期时 agent 顺手更新 map（stale 反馈回写） | git HEAD 变更 → 条目标 `stale` → 懒复验更新（同构，V2） |
| AGENTS.md vs skill 的分流规则：repo 事实/规范 → AGENTS.md；可复用有输出契约的流程 → skill | `fact/causal`（常驻注入索引）与 `lesson`（按需加载）的同类分层 |
| 提升判据："同痛点出现两次再提升"（twice-pain promotion） | topic 聚合的 `verified_count` 天然提供频次信号，可作提升/淘汰依据 |
| skills 按需加载（manifest → 全文） | `<preloaded_skills>` manifests only + skill 工具按需 materialize（一致） |

**他没有解决、本方案补上的**：① 无验证环节（人眼就是 verifier，全自动场景必须机器替代——沙箱复验）；② 单人单机视角，无多会话/多实例共享（PG `(app_id, topic)` 聚合）；③ 沉淀靠人的元认知习惯（"watch yourself work"），我们用事件驱动的触发点替代。

**可直接吸收进方案的两个小点**：① AGENTS.md 里显式写 self-correction 指令（"发现文档过期就更新它"）——零成本，V1 即可加进 memory:// skill 渲染出的索引块；② "提升判据 = 同痛点两次"对应 `verified_count >= 2` 才注入 preloaded 索引（防单次噪声），比每日限额更精准。


## 四、记忆操作系统派（研究前沿）

把记忆管理本身做成 agent 的操作系统级抽象（调度、演化、遗忘）：

- **MemOS**：记忆操作系统，统一管理多种记忆形态的调度与转化
- **A-MEM**（Agentic Memory）：Zettelkasten 式自组织笔记网络，记忆条目互相链接、动态演化
- **MemoryBank**：遗忘曲线式记忆衰减

学术热点多、工程落地少；对本项目更多是概念启发（尤其「遗忘/衰减」对应我们的 `stale` 降权）。

## 五、环境密集型 RSI 派

有**真实环境反馈闭环**的记忆进化，记忆是"验证过的环境规律"而非对话总结：

- **RSIAgent**（[arXiv:2609.15364](https://arxiv.org/abs/2609.15364)，[官网](https://aetherlabsai.github.io/RSIAgent)、[GitHub](https://github.com/AetherLabsAI/RSIAgent)）：broad-then-deep 自主探索 + 真实环境 verifier + 冻结记忆复用，详见 [RSIAgent 官方实现分析](./app-memory-rsi.md)
- 各类 OS/computer-use 自进化 agent（OSWorld 系 benchmark 生态）

## 本方案的定位与差异化

本方案横跨第 2、3、5 派：**技能库形态**（skill / `memory://`）+ **仓库级外置知识**（AGENTS.md 传统）+ **真实环境验证**（RSI）。

两个关键差异化（相对主流方案）：

1. **验证优先**：Mem0/Zep 均不验证记忆真伪，本方案的沙箱只读复验 + `candidate→verified` 状态机在工业界是稀缺设计——全自动流水线里这是防毒化的生死线
2. **环境绑定**：主流记忆是「关于用户/对话的」，本方案是「关于一个代码仓库环境的」——git HEAD 联动的 `stale` 失效机制在流行方案中几乎没有（第 4 派的遗忘曲线是时间驱动，不是环境变更驱动）

可反向借鉴的点：

- Mem0 的四操作抽象（add/search/update/delete）→ 我们的 topic upsert 已覆盖，检索可考虑后续加 FTS5 全文索引
- Zep 的时间边（事实生效/失效区间）→ `verified_at` + HEAD 已隐含，暂不引入图谱
- Letta 的「文件系统就够了」→ 印证本方案用 skill materialize 落盘而非向量库的选择
- MemoryBank 的遗忘曲线 → `stale` 降权之外，V2 可评估按 `verified_count` + 时间衰减清理长期未复验条目
