# 与 dsh-context 的逐项对照（2026-10-24 第二轮，代码级）

对照基线：`/Users/ruomu/code/dsh-context`（52 个 client 组件 / 25.8k 行）。
本仓库证据目录：`packages/hn-app/src/components/context-insights/`、`packages/schema/src/session-context-insights.ts`、`packages/core/src/session/context-*.ts`。

判定：**已实现** / **部分** / **缺失** / **不适用**（SaaS 无对应概念）。标注了证据文件。

---

## A. 统计卡（原项目拆成三张，我们合并成一张）

| 原项目指标 | 我们的状态 | 证据 |
| --- | --- | --- |
| Token：total / prompt / cacheRead / output / skill | 部分 | 实际 input/output/cache 来自结算事件；skill 估算已计入 `stats.skillTokens`；仍无 V1 的 `prompt` 口径 |
| Timing：active / wait / 工具入参耗时 / step / turn | 部分 | 有 elapsed / firstContent / model / tool 并集；**无 active（去除用户等待）、无 wait、无工具入参分段** |
| Context：turns / steps / injects / compactions / skills / toolCalls / 工具分布 | **已实现** | `Analysis.stats`（轮次/请求/注入/压缩/技能/工具调用 + 工具分布 + 命令使用），UI 在趋势卡下方；prunes 本仓库无此事件 |
| 会话时间条 `timingStrip` | **已实现**（每请求按时长占比，内部按首内容/模型/工具切分） |

> 这些计数所需的原始事实都在（请求点 + 事件），属于**纯聚合缺口**，不需要新采集。

## B. 当前上下文 / 组成可视化

| 原项目能力 | 状态 | 说明 |
| --- | --- | --- |
| 堆叠组成条 + 图例 | 已实现 | `views.tsx` |
| 上下文上限参考线 | **已实现（口径不同）** | 我们画 `min(inputLimit, window - outputReserve)`，标注为「上下文上限」。dsh 的 0.8 阈值是它自家 compaction 策略，我们的阈值由 `buffer` + provider 策略决定，未采集前不冒充 |
| 块图 treemap | **已实现**（slice-and-dice，按估算 token 比例，分类配色） |
| 环形图（donut） | 差异 | 我们用堆叠条替代（信息等价，视觉不同） |
| **图片/文件 Token 估算**（DeepSeek 官方图像算法、文件句柄计价） | 缺失 | `shared/imageTokens.ts`、`shared/fileTokens.ts`；我们把 media 只记描述与字节，token 计为描述 JSON 的量级 |
| 附件按消息原序成卡片 + 打开预览 | 已实现 | 附件卡片 + `FilePreviewDialog` |

## C. 上下文浏览器

| 原项目能力 | 状态 | 说明 |
| --- | --- | --- |
| 分类折叠 + 逐项 token | 已实现 | — |
| 每类别独立搜索 | 已实现 | — |
| 工具来源标签 / 排序 | 部分 | `mcp:` / `session` 可判；插件 vs 内置不可判（不动注册表契约） |
| 助手回复类型筛选（Thinking/Tools/Answer） | 部分 | 用 reasoning / tool-call / text 筛选（命名不同） |
| 工具结果 + 调用参数 + 状态 | 已实现 | 按 callID 配对，懒加载参数 |
| DNA：色带 + 引入步骤 + 分组收尾 | **已实现** | 色带按提示词顺序；`Item.introduced` 由服务端按 hash 回溯最早请求；列表中工具/系统提示词收尾 |
| **从聊天消息跳到上下文对应节点（contextJump）** | 缺失 | 原项目在助手消息上有跳转动作（`components/contextJump.tsx`） |

## D. 趋势

| 原项目能力 | 状态 |
| --- | --- |
| 每请求堆叠柱 / Step-Turn / Total-Delta / 横向滚动 | 已实现 |
| 总览带（压缩成连续带） | 已实现 |
| 压缩事件标记 | 已实现 |
| 步骤摘要三行 | 已实现 |
| 时长曲线 | 已实现 |
| 悬停联动浏览器 / 固定 | 部分（只有点击） |

## E. 文件活动

| 原项目能力 | 状态 |
| --- | --- |
| 每文件行 / 读写搜索筛选 / 路径搜索 | 已实现 |
| 行数增减 | 已实现 |
| Code Mode 嵌套 | 已实现 |
| 操作日志展开 | 已实现 |
| 文件预览跳转 | 已实现 |
| 汇总合计 | 已实现 |
| **搜索结果对应实际文件 + 命中数** | 已实现（解析 `tool.success` 的 content） |
| **图片（Images）类别** | 缺失（事件流不含图片读取结果） |

## F. 事件

| 原项目能力 | 状态 |
| --- | --- |
| 类型筛选 / 来源 / 轮次 | 已实现 |
| 压缩 Token 净变化 | 已实现 |
| 每类型会话内总数 | **已实现**（下拉选项带当前页计数） |
| **清理（Prune）/ 计划模式（Mode）事件** | 不适用（本仓库无此类事件） |

## G. Fleet / Agent 家族

| 原项目能力 | 状态 | 说明 |
| --- | --- | --- |
| 家族关系图 + 悬停高亮 + 点击跳转 + 运行态 | 已实现 | |
| 卡片：Token/成本/窗口占用/组成条/请求数 | 已实现 | |
| 运行时长 | **已实现**（`SessionCard.started` + `elapsed()`；运行中按 now 计） | |
| **家族统计条 `fleetSummary`（进度/完成度）** | 缺失 | |
| **成员面板 `memberBoard`（搜索/状态/排序/固定）** | 缺失 | 我们只有图 |
| **任务板 `taskBoard`（团队共享任务）** | 缺失 | dsh 的 agent team 概念；本仓库无对应数据 |
| **通信面板 `commsPanel`（relay / mailbox / settled 三类消息）** | 缺失 | 本仓库无 agent 间消息事件 |
| 血缘配色 | 已实现 | |

## H. 总览页

| 原项目能力 | 状态 |
| --- | --- |
| KPI / 热力图 / 会话卡片 / 7 天图 / 组成合计 | 已实现 |
| **技能使用统计（每日 skill 调用次数与最近时间）** | 缺失 | 原 `overviewSkills.tsx` + `ActivityDay.skills` |
| 每日账本字段 | 部分：`toolCalls` 已按天统计并进 KPI 与日明细；`turns/toolsMs/wallMs` 仍需按天配对，未做 |
| 时间范围 | 已实现：今天 / 7 / 30 / 90 / 全部（400 天服务器上限） |
| 余额胶囊 `balanceCapsule` | 不适用（无钱包概念） |
| 升级/版本门 `upgradeGate`、`updatePill` | 不适用 |

## I. 命令 / 系统提示词

| 原项目能力 | 状态 | 说明 |
| --- | --- | --- |
| 命令面板 `commandPanel` | **已实现（只读聚合）** | 从 `log` 表 `source='session.command'` 聚合（名字/次数/最近时间），随 `Analysis.stats.commands` 返回并在统计块展示；未做独立面板与交互 |
| 系统提示词/工具 schema 的 epoch 变更点 | **已实现（页内）** | `Analysis.epochs`：按 system/tools 项 hash 签名，标出变更请求；跨页/全量历史仍未覆盖 |
| `/context` 命令 | 已实现 | |

## J. 设置

| 原项目项 | 状态 |
| --- | --- |
| placement / fleetTab / overviewRange / granularity / trend / browser / fileSort / toolSort / trendView / deltaBase / insightsEntry / durationCurve | 已实现 |
| **overviewAutoSteps** | 不适用 |
| **promptPrefix / promptSuffix** | 不适用（映射到现有指令能力） |

## K. 其它差异（非缺失）

| 项 | 说明 |
| --- | --- |
| 历史回填 `backfill` / `coldRead` | 明确不做：只展示上线后采集的请求（`history: captured-requests-only`） |
| 余额 / 计价目录 / 升级门 | SaaS 无钱包与付费墙 |
| Live 下一个请求预览 | 未做 dry-run；改为显示「尚未发送的输入」（`Analysis.pending`，来自 session_inbox），不冒充已组合的请求 |
| 插件 vs 内置工具 | 需扩展工具注册表契约 |

---

## 结论与优先级

**真正缺失、且数据已具备：**

1. ~~统计卡的计数字段~~ **已完成**（含工具分布）
2. ~~每日账本~~ **已完成**（turns / toolCalls / toolsMs / wallMs）
3. ~~命令面板~~ **已完成（只读聚合）**
4. 系统提示词/工具集 epoch 变更视图（I）
5. Fleet 运行时长、家族统计条、成员面板（G）
6. 事件每类型计数（F）
7. 压缩阈值预留遮罩 + treemap + 图片/文件 token 估算（B）

**需要新采集或跨仓库能力（成本高）：**

8. DNA 色带与"引入步骤"列（需要跨请求按 hash 建索引）
9. 从聊天跳到上下文节点（contextJump，需要聊天壳与上下文面板的联动接口）
10. agent team 的任务板 / 通信面板（本仓库无对应事件，属产品能力差异）
