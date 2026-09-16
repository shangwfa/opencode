# App Memory：项目维度自进化记忆（RSI）

> 受 RSIAgent（arXiv:2609.15364，Aether AI）启发：Agent 能力上限 = 底层模型 × 可复用经验，而经验层可以在**不更新模型参数**的前提下通过「探索 → 验证 → 沉淀 → 复用」的递归自我改进（RSI, Recursive Self-Improvement）持续增厚。本方案把该思想落到本项目的 appId 维度：**带 appId 的会话就是一个项目（代码仓库），同 appId 的所有 session 共享同一套沙箱环境与 app PVC（`session`→`app` PVC 模式）——`appId` 即 RSI 语境下的 "environment" 边界**。目标是在 app 维度自动沉淀「动作—条件—结果」可复用因果经验，验证后供同 appId 的后续 session 创建时自动注入，实现项目维度的自学习、自进化。

## 功能背景与效果

每个 session 都从零开始：AGENTS.md 是静态的仓库级知识，「已知坑」靠人工踩过再写进文档。同 appId 连续十个 session，第 2 个 session 踩过的沙箱 OOM 坑、构建命令坑，第 11 个 session 原样再踩一遍。App Memory 让这些经验自动沉淀、自动验证、自动复用：

| 能力 | 效果 |
| --- | --- |
| 全自动闭环（用户决策） | 无需 agent 显式调用「沉淀」工具、无需人工审查：捕获 → 提炼 → 沙箱复验 → 聚合入库 → 新 session 自动注入，全程后台流水线 |
| 项目维度 | 经验挂在 `app_id`（session.pg.ts 已有该列）而非 session，同 app 共享；环境 facts、因果规律、失败教训三层形态 |
| 真实环境验证 | 候选经验必须在沙箱（该 app 的 PVC 环境）实际复跑通过才转正——对齐 RSIAgent 的 verifier 用真实环境反馈、而非模型自评 |
| 注入即索引 | 复用现有 `<preloaded_skills>` 机制（system.ts:138-162）：新 session 只注入条目索引 manifest，agent 经 skill 工具按需加载全文，防上下文淹没 |
| 随任务随算随用 | 提炼/复验均发生在沙箱内部已有会话路径之外，异步、限流、可关，默认 off 零开销 |
| 会话删除免疫 | 经验入队时**快照所需上下文**进队列，提炼器异步消费，不回头查 exec_log——绕开 remove handler 的 FK cascade 随 session 删除 exec_log 的破坏窗口 |

## 可沉淀数据源盘点（线上验证 2026-09-16）

对现网 PG（48 个 appId 会话、315 条 exec_log、4.3 万条 event）实测盘点后的全景，**结论：数据已齐备，V1 不需要新增任何埋点，缺的只是提炼层**。

### 一、结构化行为数据（PG，机器可查，最直接）

| 数据源 | 表/位置 | 沉淀价值 |
| ---- | ---- | ---- |
| exec_log | `exec_log` | **最高价值**。command（tool-call JSON）、status（completed/failed/denied）、exit_code、stderr/error——失败修复链路、denied 权限坑（样本中 22 条固定模式）、超时/OOM 全在这 |
| message + part | `message` / `part`（session.pg.ts:63/77） | 任务上下文、agent 推理与总结、错误现场全文；提炼器的主力语料 |
| event 流 | `event`（durable，样本 43k 条） | 全局事件：ExecFailed、沙箱 OOM、watchdog 动作、session 生命周期——触发点信号源 |
| todo | `todo`（session.pg.ts:95） | 任务结构与完成度——「什么任务在什么环境卡住」的骨架 |
| session_goal | `session_goal`（condition + react + last_verdict） | 目标→判定→反应的完整因果闭环，天然 lesson 素材 |
| permission 规则 | `permission`（session.pg.ts:133） | denied 的规则侧信息——「这个项目拦什么命令」属环境 facts |
| hitl_request | `hitl/request.pg.ts` | agent 主动问人的问题 = 知识缺口信号；高频提问模式可沉淀 |
| CCR 原文 | `storage_data`（`plugin/ccr/*`） | 被压缩的大输出原文（build 日志/长 JSON）——失败分析的原始证据；**随 session 删除清理，提炼要趁在** |

### 二、运行时信号（进程内，实时但易逝）

| 数据源 | 位置 | 价值 |
| ---- | ---- | ---- |
| exec-repair attempts | 内存 Map（`exec-repair.ts`） | 修复尝试实时计数——入队点之一；注意线上「字面同命令重试」为 0（见写路径修正） |
| exec-failed 失败模式 | `exec-failed.ts` 正则族 | OOM/超时等 8 类失败分类器现成——提炼器的预分类器 |
| watchdog 判定 | `watchdog.ts` | 卡死/孤儿执行——「这个 app 的任务容易卡在哪」 |
| LLM stall / lock 超时 | 各 `OPENCODE_*` 开关 | 基础设施类 facts（该项目经常 429、经常 stall） |

### 三、既有知识载体（人工/会话沉淀，可引用、需去重）

| 数据源 | 表 | 价值 |
| ---- | ---- | ---- |
| AGENTS.md（session 级） | `agents-md.pg.ts` SessionAgentsMdTable | 项目已有 session 级 AGENTS.md 落库——记忆条目须与它**按 topic 去重合并**，而不是各写各的 |
| session skill | `session_skill` | 会话内生成的技能——同 app 重复出现即提升为 app 级条目（"pain twice" 提升路径） |
| user skill | `user_skill` | 用户级技能库——跨 app 复用层（Eric Ma Stage 2） |
| rpa_app / version / run | `rpa.pg.ts` | RPA 场景版本与运行历史——版本边界即经验失效边界（已被 git HEAD 机制覆盖） |

### 四、文件系统证据（沙箱侧，异步采集）

- **compaction 历史文件**（`/workspace/.opencode/tool-output/`）：compaction 落盘的完整历史——比 PG 消息更全，idle 提炼时的深度语料
- **git log/diff**（app PVC 内）：项目演进史——条目 `head` 字段的验证锚点
- 沙箱快照：`session_snapshot` / `sandbox` 表——环境状态基线

### 盘点得出的三个设计约束

1. **入队快照更显必要**：CCR 原文与 event 都是随 session 级联清理的易逝数据，提炼 enrich 必须异步快照，不能事后回查
2. **记忆 vs AGENTS.md 的边界**：AGENTS.md 保持「仓库级静态规范」，app_memory 承接「动态经验」；读路径注入时两者互补、按 topic 去重
3. **信号放宽**：exec-repair 字面匹配线上零命中，触发点须覆盖 failed→completed 的近似修复链路（见写路径）

## 核心设计

**概念澄清：appId ≠ rpa-app（两种不同类型）**

| 维度 | appId（本方案的对象） | rpa-app |
| ---- | ---- | ---- |
| 定义 | `pvcMode=app` 的 PVC 聚合键：调用方在创建会话时显式传入（`session.ts` 758-786，1-128 字符标识符），语义是「项目/代码仓库」的共享沙箱空间 | RPA 业务平台的应用实体（`RpaAppTable`，`rpa_xxx`）：有 project_id、directory、params_schema，下游挂版本表（RpaAppVersionTable）与运行表（RpaAppRunTable） |
| 生命周期 | 无独立生命周期，只作为聚合标识跟随调用方 | 有完整的应用/版本/运行生命周期 |
| 关系 | rpa-runner 创建沙箱时**借用** `run.app_id` 作为会话 appId（rpa-runner.ts:194），复用共享 PVC 机制 | 借用方；RPA 会话的 skill 读取与渲染逻辑不做任何 rpa-app 特判 |

App Memory 对准**通用 appId 机制**，与 rpa-app 的版本/运行模型解耦；RPA 是走这条机制的其中一类上层流量。rpa-app 版本推进导致环境变化的失效问题，由条目的 git HEAD 标记天然覆盖（新版本=新 HEAD=旧条目标 `stale`），无需感知 rpa 版本模型。

### 1. 记忆条目（数据模型）

新 PG 表 `app_memory`（`packages/opencode/src/app-memory/app-memory.pg.ts` + `migration-pg` 迁移）：

```ts
const AppMemoryTable = pgTable("app_memory", {
  id: text().primaryKey(),
  app_id: text().notNull(),
  topic: text().notNull(),          // 聚合 key："<category>.<slug>"，如 build.command / fail.sandbox-oom
  category: text().notNull(),       // fact | causal | lesson
  content: text().notNull(),        // Markdown 正文：动作、条件、结果的因果陈述
  status: text().notNull(),         // candidate | verified | stale | superseded
  head: text().notNull(),           // 提炼/最近一次复验时的 git HEAD
  evidence: pgJsonb<{ session_id: string; command?: string; failure_mode?: string; summary_from?: string }>().notNull().default({}), // 来源 session/命令/失败模式的溯源
  verified_count: integer().notNull().default(0),
  ...Timestamps,                    // time_created / time_updated；verifier 复验时用显式 update 刷新（PG bridge 无 $onUpdate）
}, (t) => [
  index("app_memory_app_idx").on(t.app_id),
  uniqueIndex("app_memory_app_topic_idx").on(t.app_id, t.topic),
])
```

- **topic 唯一 = 防膨胀与防矛盾的核心**：同一主题（如 `build.command`）同 app 只有一条，复验产出的新结论 `upsert` 覆盖旧条目，而不是追加（追加会产生自相矛盾的记忆对）。
- **status 状态机**：`candidate`（提炼待验证）→ `verified`（沙箱复验通过，可进注入索引）；任一条目 `head` 落后项目当前 HEAD → 标 `stale`（读路径展示但降权，懒复验后恢复 `verified`）；被新条目覆盖时旧状态写 `superseded` 保留一版溯源。
- **`verified_count` 语义（借鉴 hermes curator 对 use_count 的教训）**：count 只用于**排序与衰减**，不用于**准入**——准入唯一条件是复验通过（`status=verified`）。低频 app 的第一条经验可能长期等不到第二次触发，若设「count≥N 才注入」门槛会把它们永久埋没；同理，「count=0」也不是删除/降权的理由，stale 判定只看 HEAD 与复验时间。
- 表设计对齐代码风格：字段名 snake_case、列名不重复定义（AGENTS.md Drizzle 规则）、迁移走 `migration-pg/<ts>_app_memory/migration.sql`。

### 2. 写路径：三处触发点，全部复用现有机制

**① 实时流：失败→修复链路检测**（最高价值经验来源，含线上修正）

基础锚点是 `exec-repair.ts`（`makeGlobalNode` 订阅 `ExecFailed` GlobalEvent，维护 `(sessionID, command)` 维度的 attempts 计数）。但**线上实测（2026-09-16）字面级「同命令先失败后成功」为 0 条**——agent 修复时改写命令/换工具/开新会话，exec-repair 的字面 key 抓不到真实修复。因此触发信号放宽为三类：

- **近似修复链路**：同 session 内 failed/denied 后 N 分钟窗口内出现同工具 completed（命令相似度不敏感，按 tool+working_directory 粗粒度配对）
- **denied 聚类**：权限拦截（线上 22 条、模式集中如 `cp /workspace/.rpa/...`）是典型「该写进记忆的坑」——同一 pattern 被拦 ≥2 次即入队
- **repair 类会话结束**：标题带 `repair` 的重试会话（rpa 场景真实形态）结束 = 完整「失败→修复」周期，按 appId 成对提炼旧会话+新会话

**关键动作不变：入队时把所需上下文（命令、失败摘要、修复结果、git HEAD、appId）整体快照进队列条目**——提炼异步消费，不依赖原 session 的 exec_log 存活，天然免疫 session 删除的 cascade 清理（CCR 原文/event 同为易逝数据，见数据源盘点）。

**② idle 扫描：watchdog 式后台提炼**

新模块 `app-memory/extract.ts` 仿 `watchdog.ts` 的 layer 形态（`Layer.effectDiscard` + 定时 `scanOnce`）：扫描本实例上「run 已结束（run-state 无 running run）且最近一次活动时间超过阈值」的同 appId session，从消息/工具输出里提炼候选经验。事件驱动源为 GlobalEvent 订阅（与 exec-repair 同模式）。

**③ 零开局面广度普查（broad）**

某 appId 的首个 session（该 app_id 在 app_memory 表中无 `verified` 条目）结束且空闲时执行一次「环境普查」：探测构建/测试/lint 命令、目录结构、依赖特征，沉淀为 `fact.*` 条目——对应 RSIAgent 的 broad-then-deep 中的 broad；后续 session 的失败教训逐步沉淀深水区规律（deep）。

### 3. 提炼器：廉价模型 + 结构化输出

- 提炼复用现有 LLM 调用链路（消息级系统已连接 Yd-DeepSeek），用配置的便宜模型生成结构化条目（category + topic slug + 正文 + 复验命令）。
- **content 形态收紧（对照 RSIAgent "code as policy"）**：正文必须是「可执行步骤 + 具体命令/参数」级的过程知识（如"在 Y 目录用 X 命令跑 Z，注意 W 参数"），拒绝泛泛的行为建议——不可执行、不可复验的条目没有复用价值。RSIAgent 官网实例（T085）保留的教训即具体参数级（`RENDER_RESAMPLE 0 0 0`），后续 attempt 直接在构造程序里采用。
- **入队硬门**：提炼器必须产出一条**只读可复验命令**，产出不了的条目直接丢弃（V1 管道只收可复验条目）。
- **写入规范（借鉴 hermes-agent `_DO_NOT_CAPTURE_BLOCK`，与沙箱复验互补的 prompt 级防线）**：复验只能拦「跑不过的」，拦不住「跑得过但是毒的」。提炼 prompt 硬性约束三类不收：① 负面断言（"X 工具不行/不好用"）——能复验但会硬化为 agent 自拒；② 未解决的失败——严禁包装成"可靠工作流"；③ 环境依赖失败（缺依赖/未配置）——只沉淀修复动作（装什么/配什么），不沉淀"这环境有问题"。
- 提炼器只产 `candidate`；**任何条目不经沙箱复验不得转为 `verified`**——这是全自动模式下替代人工审查的生死线（无人工兜底，自评条目严禁转正）。
- 限流与去重：同 appId 串行（下方 §6），同 `(appId, topic)` 数据库唯一索引兜底并发，单 app 每日提炼预算与单条管道超时均可配置。

### 4. verifier：沙箱真实复验 + 副作用隔离

- **复验范围**：仅接受 V1 硬门产出的复验命令（如目录内跑 `bun typecheck`、`yarn test unit`），在该 app 的真实 PVC 环境中执行——验证的才是真实环境。
- **副作用隔离**：复验命令仅放行只读白名单（build/typecheck/单测/静态探测），禁止写盘型命令（`yarn add`、`rm -rf` 等）；复验允许产生构建缓存等无害残留，禁做任何环境状态变更。对照 RSIAgent 官方实现：其 verifier 检查 rollback-protected candidate、guest-local 变更在 actor 恢复工作前一律回滚、且不能读 actor 的私有推理；我们的环境是持久 PVC（非 OSWorld 逐任务全量重置的 VM），全量回滚成本高，故选「白名单在源头挡写」，快照回滚列为 V2 加固项。
- **成本控制与裁决语义**：复验不额外调用 LLM，仅消费提炼阶段产出的复验命令在沙箱执行——对照官方三态裁决（PASS/FAIL/unresolved）：基础设施错误不计为经验失败、状态记录为超时而非 FAIL（避免把环境故障学成错误教训）。跑不过或超时的条目回到 `candidate`，两次失败直接标 `superseded`（无验证能力的假知识不过夜）。

### 5. 读路径：四层触发机制（借鉴 hermes，按 SaaS 形态改造）+ skill 工作流

记忆条目「写进去」不等于「用得上」——执行任务时 agent 不一定会想到去加载。借鉴 hermes-agent 的四层递进触发机制，但**逐层按 opencode SaaS 形态改造**（hermes 是单机单进程 + 本地文件系统 + agent 可直接写技能文件；我们是多实例无状态 server + 远端 PG + 远端沙箱 + agent 在沙箱内无 PG 访问权）：

**第 1 层：常驻索引 + 强硬触发指令（被动层，server 侧渲染，天然兼容 SaaS）**

1. skill 发现层：在 `skill/index.ts` 的 `skill.available`/`get` 中增加一个基于 `app_memory` 表的 source，产出 `location = "memory://app/<appId>/<topic>"` 的 skill 列表（该前缀在 `skill/index.ts:501`、`tool/skill.ts:46` 已有直通分支，`memory://` 路径与 session:// 一样走 `materialize` 幂等落盘）。`get` 时按 appId 从 `app_memory` 表聚合渲染全文。
2. system prompt 自动注入：不需要新增 handler、不需要改 CreateInput——`SystemPrompt.skills` 只要 `skill.available` 补充了 memory:// skill，就会自动出现 `<preloaded_skills>` manifest 注入（现有行为，manifests only + 按需经 skill 工具加载全文），改动收敛在 skill 发现层一处。
3. **触发指令措辞（关键，现有措辞偏中性要升级）**：现 `<preloaded_skills>` 的说明是中性的 "call the skill tool to load"。渲染的 memory:// skill **description 必须写触发条件**（"当遇到 X / 执行 Y 类命令时"），而非"这是什么"——description 是唯一的被动触发面。同时在 `<preloaded_skills>` 尾注追加 memory 专用指令（措辞对齐 hermes 的强度）："只要条目与当前任务**哪怕部分相关**就 MUST 加载；宁可错载不可漏载；即使你认为自己会用基础方法完成，也要加载——条目定义的是**本项目**里这件事该怎么做。仅当确实无一相关才可不加载。"
4. **SaaS 隔离约束**：`skill.available` 的 appId 来源必须是当前 session 行的 `app_id`（查询在 server 侧、按 session 过滤），跨 appId/租户零泄漏；无 appId 的 session 不注入任何 memory:// skill。

**第 2 层：核心条目全文注入（主动兜底，server 侧组装 LLM 请求时完成）**

`fact.*` 类核心条目（构建/测试命令、目录约定）不依赖"模型想起来查"——server 组装 LLM 请求时把 `fact` 类条目渲染成文本块**直接进入 system prompt**（沿用第 1 层同一条注入管线，只是内容从 manifest 换成全文；fact 条目少而稳定，不构成上下文负担）。对应 hermes 的 `skills.auto_load`，但无需 hermes 的文件扫描机制——我们的条目本来就在 PG，注入即查询。`causal.*`/`lesson.*` 保持第 1 层按需加载。注入块同样标注 `[IMPORTANT: 本项目既定事实，按此执行，除非与当前任务显式冲突]`。

**第 3 层：复杂度 nudge 反哺沉淀时机（写路径联动，计数必须落 PG）**

借鉴 hermes `_iters_since_skill` 计数器的思路，但**进程内存计数在 SaaS 下不可靠**（session 可能被路由到任意实例、实例无状态可随时重启）——改为 server 侧从 PG 统计：session 的 exec_log 行数 / message part 数即复杂度信号，idle 提炼扫描时直接 SQL 排序（`ORDER BY exec_count DESC`），高复杂度 session 优先提炼。无需新增计数器，数据本来就在 PG。

**第 4 层：使用反馈就地修复（保鲜层，SaaS 下必须改「提议-复验」两段式）**

hermes 的 agent 直接 `skill_manage` patch 本地文件——**我们的 agent 在沙箱里，无法直接写 PG 的 app_memory 表，且防毒化不变量要求 agent 永不直接写 `verified` 条目**。改为两段式：

1. **agent 侧提议**：memory:// skill 渲染的索引块尾注写 self-correction 指令："加载的条目若缺步骤/命令失效/与本仓库现状不符，**将修正后的条目内容 + 原因写入 session skill**（或任务总结输出）"。session skill 是 agent 已有的合法写入通道（`POST /session/:id/skills/create`，durable PG snapshot）。
2. **server 侧收敛**：后台提炼扫描把「同 appId 下与 memory 条目相关的 session skill 新增/更新」作为**候选修正**入队 → 沙箱复验 → 通过则 topic upsert 覆盖原条目。agent 永远只产 candidate——修正也要过复验（防 agent 顺手写错），与防毒化不变量一致。

这条两段式同时解决 SaaS 的写入通道问题（不新增 agent 工具、不走 HTTP 新端点）和全自动场景的人工审查缺位问题（复验替代人审）。

### 6. 并发与多实例

- 同 appId 提炼/复验串行：worker 以 appId 为队列粒度，并行兜底用 PG advisory lock（`pg_advisory_lock(hashtext(app_id))`）——同实例多 session 与跨实例共享 PG（local-test 三组真实性）两面安全，不新增锁协议（不复制 session lock 的 HTTP 语义）。
- 跨实例消费一致：PG 唯一索引 + `upsert` 均以 `(app_id, topic)` 为稳定 key——同坑多 session 并行提炼只会收敛一条。
- **串行消化的依据（对照官方 wave memory barrier）**：RSIAgent Phase 1 的每个 wave 从同一 memory 快照起步并行探索，但所有分支完成 valid verification 后，经验按序**串行 consolidated**，下一波在 memory commit 持久化后才启动；未通过验证分支的 memory 不合并。我们的「同 app 队列串行 + 未验证不入库」即同构简化。

## 实现位置

| 模块 | 内容 |
| ---- | ---- |
| `packages/opencode/src/app-memory/` | 新独立模块（参照 skill/session 的模块形态）：`app-memory.pg.ts` 表 + `queue.ts`（候选入队/快照持久化，PG 存储）+ `extract.ts`（提炼 worker，仿 watchdog layer）+ `verify.ts`（沙箱复验 adapter）+ `render.ts`（memory:// skill 渲染）+ `layer.ts`（service 汇总） |
| `packages/opencode/src/sandbox/exec-repair.ts` | 修复成功节点产出候选快照，事件调用入队点 |
| `packages/opencode/src/skill/index.ts` | `skill.available`/`get` 增加 memory:// source（按 appId 查询 app_memory 表） |
| `packages/opencode/src/session/session.pg.ts` | 查询 session `app_id` 已存在，skill 渲染按 appId 查执 |
| `packages/opencode/migration-pg/<ts>_app_memory/migration.sql` | 新表迁移（`--> statement-breakpoint` 分隔） |
| `packages/opencode/src/flag/flag.ts` | `OPENCODE_APP_MEMORY_*` 环境开关 |
| `test/app-memory/*.test.ts` | L0 单测（提炼结构化、渲染、状态机、去重），从 packages/opencode 跑 |

注：本方案不改动任何既有成本敏感的表（session 等），流水线全部为增量模块；唯一的 schema 变更是新增 `app_memory` 表，按惯例走 `migration-pg` SQL 迁移，对既有 core/PG 双 schema 无冲突。

## 配置

| 环境变量 | 默认 | 说明 |
| -------- | ---- | ---- |
| `OPENCODE_APP_MEMORY_ENABLED` | off | 总开关；关闭时零额外行为（exec-repair 入队点短路） |
| `OPENCODE_APP_MEMORY_MODEL` | 继承当前 provider 配置 | 提炼与汇总用的模型 |
| `OPENCODE_APP_MEMORY_EXTRACT_IDLE_SEC` | 1800 | session 空闲到扫描提炼的阈值 |
| `OPENCODE_APP_MEMORY_DAILY_LIMIT_PER_APP` | 20 | 每 app 每日提炼候选条数上限 |
| `OPENCODE_APP_MEMORY_VERIFY_TIMEOUT_SEC` | 300 | 单条沙箱复验超时 |
| `OPENCODE_APP_MEMORY_VERIFY_READONLY_ONLY` | true | 复验命令白名单模式（写盘型一律拒绝转正） |
| `OPENCODE_APP_MEMORY_AUTOLOAD_CATEGORIES` | fact | 第 2 层全文注入的条目类别（逗号分隔；空串 = 全部走按需加载） |
| `OPENCODE_APP_MEMORY_NUDGE_MIN_ITERS` | 20 | 第 3 层复杂度 nudge：session exec_log 行数阈值（PG 统计），超过则提炼优先 |

## 与 RSIAgent 原文/官方实现的对照与吸收

| 官方机制 | 本方案对应 | 吸收策略 |
| ---- | ---- | ---- |
| Curriculum Agent 自主选题（curriculum） | 不做；编码 agent 的探索方向由用户任务驱动 | 保持「不做」决策；官网消融中 BRS/DRS 各自掉分说明的是「分层探索」价值，我们用广度普查 + 深水区提炼保留该结构 |
| Code as policy：经验即代码 | 首版 content 为 Markdown 陈述 | **已吸收**：正文收紧为可执行步骤 + 具体命令/参数级，入队硬门要求复验命令 |
| Verifier 独立上下文、rollback-protected candidate、三态裁决 | verifier 是纯沙箱执行器（更激进地省掉了 LLM verifier） | **已吸收**（见 §4）：基础设施错误不学成 FAIL；裸白名单替代全量回滚（环境形态差异，见上） |
| Wave memory barrier：并行探索 + 串行 consolidation | 同 appId 队列串行提炼/合并 | **已吸收**（见 §6），含「未验证不合并」不变量 |
| 官方评分（benchmark 分数）隔离在 learning loop 外 | 无 benchmark 场景 | 等价不变量写入实现约束：**任务最终成败/用户评分不作为经验来源**——只从过程（修复链路、复验反馈）中学习，防「为分而学」扭曲 |
| 承认的三大失败上限：练习错过弱点 / verification 接受不完整工作 / memory 保留错误规则 | 对应毒化与假阳性风险 | 前两者由「真实环境复验 + 只读白名单」对冲，第三条由状态机 + topic upsert 覆盖收敛；该三方防线在风险小节列出 |

对齐官方 smoke 不变量的测试断言（官方检查：transport、immutable memory、candidate replay、verifier isolation、checkpoint rollback）：T-MEM.4/5/7 覆盖 memory 不可绕过验证入库、复验隔离、复验幂等，T-MEM.8 对应裁决语义，T-MEM.6 对应关闸零行为；checkpoint rollback（快照回滚）属 V2。

## 风险与已知短板

- **毒化是最大风险**：全自动无人工兜底，只有「沙箱真实性 + 只读白名单 + 状态机」三道防线；任何绕过 verifier 进入 `verified` 的路径都是 bug（集成测试必须断言这个不变量）。
- **复验副作用**：真实 PVC 环境复跑 build/test 会留缓存与临时文件；白名单模式把风险压到与正常会话用法一致，但极端吞吐下可能加剧 OOM（复验限额与 sandbox 资源配置联动）。
- **过期与 git HEAD**：条目按提炼时的 HEAD 标记，项目持续演进后 `fact.*`/`causal.*` 可能失真——`stale` 降权 + 懒复验是 V2 目标，V1 先保证「新 session 注入的条目都是被验证过的」这一不变量成立。
- **提炼噪声**：偶发任务难以过滤掉「只踩一次」的低价值条目——不做语义判断硬挡，靠每日条数上限与唯一 key 收敛（同 topic upsert 自然压制噪声重复）。

## 分期

- **V1（最短闭环）**：exec-repair 实时入队 + watchdog 式 idle 提炼 + 沙箱只读复验 + `(app_id, topic)` 聚合 upsert + skill discovery 挂 memory:// + preloaded_skills 自动索引注入 + **四层触发机制（SaaS 改造版）**（强硬触发指令 + appId 隔离 / fact 类全文注入 / PG 统计复杂度 nudge / 「agent 提议 → server 复验」两段式就地修复）。
- **V2**：appId 首个 session 广度普查、git HEAD 变更触发懒复验/`stale` 衰减、candidate→verified 的复验重试机制、提炼池的成本观测面板（对齐 CCR 的 PG 聚合观测思路）、**curator 式 topic 整理**（借鉴 hermes `curator.py`：周期性 prefix/domain 聚类 → 相近 topic 合并为聚合条目 → 被合并条目写 `superseded` 归档而非删除；**dry-run 报告先行**，人工批准后才实跑；永不物理删除）。
- **不做**：全局自主探索（curriculum agent 自决定学什么）——编码 agent 有任务目标驱动，探索方向天然由工作内容决定，自主探索循环对本场景收益偏低。

## 验证要点（集成）

| 编号 | 场景 | 命令思路（`source docs/test-cases/test-env.sh` + `test-lib.sh`） | 期望 |
| ---- | ---- | ------------------------------------------------------------ | ---- |
| T-MEM.1 | 闭环 happy path | 同 appId 创建 session①，在沙箱内执行会失败并被 exec-repair 修复的命令，等待 idle 扫描；查询 PG `app_memory` | 该 app_id 出现 `verified`/`candidate` 条目，topic 唯一 |
| T-MEM.2 | session 删除后经验仍在 | 移除 session① 后再创建 session②，检查其 system prompt 与 `app_memory` 行 | 经验不随 session 级联丢失，新 session 仍注入索引 |
| T-MEM.3 | 跨 session 复用 | 同 appId 重复踩同一坑，新 session 创建后查看 system prompt | `<preloaded_skills>` 出现 memory:// skill |
| T-MEM.4 | 防毒化不变量 | 无法构造只读复验命令的候选经验 | 状态停留 `candidate`，二次失败后转 `superseded`，永不进入注入索引 |
| T-MEM.5 | 并发唯一聚合 | 并行创建多个 session 复现同坑 3 次 | `app_memory` 该 topic 仅一条，`verified_count` 单调递增 |
| T-MEM.6 | 默认关闭无副作用 | 不设置 `OPENCODE_APP_MEMORY_ENABLED` 运行标准测试全流程 | 无 app_memory 写入、无额外 LLM/沙箱调用，现有用例全部不受影响 |
| T-MEM.7 | 复验幂等（candidate replay） | 同一候选连续触发 2 次复验 | 两次结果一致；重复复验不产生重复条目、不重复计数 |
| T-MEM.8 | 基础设施错误不计失败 | 复验命令执行期间人为重启沙箱容器 | 状态记录为超时/retry，不学成"该命令不可信"类错误教训 |
