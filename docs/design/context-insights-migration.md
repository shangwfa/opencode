# 上下文洞察迁移方案

状态：第一阶段采集与 API 已交付；第二阶段分析 API（请求趋势、上下文事件、文件活动、Agent 家族、跨会话总览）与第三阶段 `packages/hn-app` 可视化已交付。验收与限制见 `docs/test-cases/context/context-insights.md`。

## 目标与边界

迁移 dsh-context 0.74.0 的产品能力，不引入 DeepSeek Harness、Cordis 或其投影协议。采用现有 OpenCode V2 的 schema → protocol → core → server 分层，PG 为事实存储，沿用会话鉴权与 SSE。沙箱仍只负责文件和工具执行，不承担上下文统计服务。

本方案基于本地源码检查，不代表 Docker/API/PG 集成测试已通过。参照项目为 `/Users/ruomu/code/dsh-context`。

## 已确认的基础能力

| 能力 | 源码依据 | 迁移决策 |
| --- | --- | --- |
| 持久化事件、事务内 projector、PG 聚合锁、顺序回放 | `packages/core/src/bus.ts`、`packages/core/AGENTS.md` | 复用，不另造进程内事件总线 |
| 会话累计 Token 和成本投影 | `packages/core/src/session/projector.ts`、`usage.ts` | 作为既有用量口径，不重复累计 |
| 时间范围、模型、工具统计 | `packages/core/src/session/stats.ts`、`packages/schema/src/session-stats.ts` | 在语义一致时复用；每日归因需另行核对 |
| 指令、工具、模型与历史装配 | `packages/core/src/session/context.ts`、`model-request.ts` | 在最终请求装配处采集，不从聊天 UI 反推 |
| post-hook 请求审计 | `packages/core/src/session/model-request-log.ts` | 当前是 opt-in 本地 JSONL；不能充当线上查询存储 |
| 当前上下文读取 | `packages/server/src/handlers/session.ts` 的 `session.context`、`packages/core/src/session/history.ts` | 当前返回历史消息，不等于完整模型请求 |
| 累计用量与当前压力的区分 | `packages/hn-app/src/components/session/session-token-usage.ts` | 保留，禁止用累计 Token 计算窗口占用 |
| fork 与子会话的区别 | `packages/core/src/session/projector.ts` 的 `projectFork` | fork 不自动计入子 Agent 家族 |

## 功能映射

| 原项目功能 | SaaS 交付内容 |
| --- | --- |
| Context Stats / Token Stats | 单会话用量、成本、轮次、步骤、工具统计；请求组成单独估算 |
| Timing Stats | 请求耗时、首 Token 延迟、生成区间、工具区间；并行工具按区间并集统计，避免重复扣减 |
| Current Context | 最近实际请求组成与模型窗口；“下一次请求预览”必须独立标识，不能冒充实际请求 |
| Context Trend | 每次请求与轮次粒度的 total/delta；展示重试、失败、取消、压缩边界 |
| Context Browser / DNA | 按系统提示词、工具定义、用户、注入/技能、助手、工具结果分类浏览；正文按需分页 |
| Context Events | 压缩、指令/技能注入、模型/Agent 切换等已有事件；无法观测的类型不能伪造 |
| File Activity | 文件工具行为与关联调用；Code Mode 嵌套调用需验证实际采集链路 |
| Fleet | 父子 Agent 图、状态、家族成本；fork 独立展示，家族合计不能重复计数 |
| Context Insights | 按授权范围聚合的会话列表、每日用量、成本、缓存率和热力图 |
| `/context`、设置 | 前端入口；默认视图、筛选等属于展示偏好，不修改 Agent 行为 |
| Prompt Prefix/Suffix | 映射现有指令能力；核对生效范围和继承语义后再决定是否增加入口，不新增平行注入体系 |

## 采集与存储设计原则

以下为整体设计原则；第一阶段实际交付以验收文档为准，尚未实现的分析能力不作为已存在的接口。

1. 每次模型请求拥有稳定 requestID，关联 session、逻辑 step、attempt、用途、模型和时间。主请求、压缩、标题等用途分开；重试不能覆盖前一次尝试。
2. `SessionModelRequest` 提供采集回调，在主请求、生成、标题及压缩的实际模型调用边界记录 system/messages/tools 和模型窗口参数。不能只在 prepare 采集：压缩会在 prepare 后追加摘要及修正指令，重试也必须独立记录。语义请求不等于 HTTP hook 或 provider 编码后的原始线上报文，界面应明确这一边界。
3. PG 请求记录保存摘要、生命周期和组成；大内容以内容哈希引用去重，复用现有存储仅限语义与权限匹配时。不复制图片/base64，不保存认证头、provider 凭据与完整请求配置。
4. 第一阶段新增 `session_context_request` 和会话内哈希去重的 `session_context_content`，正文与摘要通知通过既有 Bus 的事务 commit 原子写入。摘要事件回放不重复写快照、不重复计费；正文是独立持久化事实，不能仅凭摘要事件重建。请求生命周期关联与分析后续完善。不得在流式 chunk 上反复写整份快照。
5. 实际 usage/cost 沿用已有结算事实；组成是明确标识的估算，两者分别展示。模型/供应商缺失的 usage 是未知，不冒充零或精确数值。
6. 技能与指令分类要保留来源信息。Code Mode 同时区分“对模型公开的 schema”和“runner 内可调用目录”，不能把后者全部误算为工具 schema。
7. 浏览器端只维护可丢弃的视图状态。任意 Pod 均可从 PG 查询；SSE 摘要只含 requestID、状态、revision 等，正文走鉴权详情接口。
8. 所有查询继承现有会话可见性；家族查询逐成员授权，总览先限定授权会话再聚合。跨会话内容哈希不能成为无鉴权读取入口。
9. 记录保留期、正文访问权限、超大请求处理和删除级联必须明确。失败/截断内容标注不可用，不能静默丢失后仍宣称完整。
10. 历史回填只恢复已有事实；没有原始请求的历史会话标注缺失或近似。现有迁移文件出现过 `session_context_epoch`，但这不是当前运行时具备逐请求快照的证据。

## 建议 API 形态

- 单会话摘要、请求列表、请求组成/内容详情、上下文事件、文件活动和家族接口。
- 授权范围内的跨会话洞察接口，支持日期、时区、分页和筛选。
- 沿用 `GET /api/session/:sessionID/event` 提供实时变更通知和既有回放语义，不再开平行 SSE。
- 列表不包含全文；详情响应声明估算方法、完整性与观测边界。
- 通过 schema/protocol 声明契约并更新生成客户端，避免前端手写另一套 wire 类型。

## 实施顺序与验收

### 第一阶段：采集与 API 基础

新增请求身份、PG 快照与必要投影；提供摘要、请求列表和详情 API；连接 SSE。实现前先写契约与统计口径测试。第一阶段不宣称完成全部产品迁移。

验收：Docker 中发起真实会话；订阅 SSE；验证请求与工具过程、接口结果和 PG 行；请求重试/失败/取消、重启恢复与跨实例查询不丢记录、不重复统计。确认默认 Code Mode 及嵌套工具调用确实生效。

### 第二阶段：分析能力

补齐组成、趋势、事件、文件活动、耗时与家族 API，以及跨会话日聚合。先以实际数据验证聚合口径，再决定是否需要额外物化日表。

验收：压缩前后历史可查；父子与 fork 正确；并行工具不重复计时；时区跨日、缓存 Token、不同模型定价、缺失 usage 均有明确结果。禁止无界扫描全部请求正文。

### 第三阶段：产品界面

若本次包含 `packages/hn-app`，在会话页接入 Context/Fleet，新增总览与详情浏览，最后完善 DNA、热力图、偏好和快捷命令。复用现有 React 19 组件体系，不直接复制原项目的 Harness 插槽代码。

验收：长会话懒加载/分页，约 390px 至桌面宽度，中英文、空态、缺失历史、错误恢复；与 API/PG 结果核对。

### 共同测试要求

- 单测：分类与估算、投影幂等/回放、生命周期、实际 usage 关联、去重、内容边界、鉴权与删除。
- PG 集成：并发写入、不同 Pod 查询、事务失败、迁移和删除级联；不以 SQLite 结果代替 PG 验证。
- API E2E：输入 → SSE 过程 → 响应 → PG 三者核对；问答自动应答以继续执行。
- SSE 输出遵循 `docs/test-cases/skills/streaming-output-spec.md`，不等执行结束才展示过程。
- 安全：跨用户请求/内容/家族不可读，响应与事件不泄露凭据。

## 后续范围

已确认作为 SaaS 原生能力实现。当前先交付第一阶段采集与 API；按前述顺序继续阶段二分析与阶段三 `packages/hn-app` 可视化。

当前工作区已有大量无关未提交改动，实施时必须保留，不做 reset、stash 或批量格式化。
